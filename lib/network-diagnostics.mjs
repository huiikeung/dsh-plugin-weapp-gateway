// 网关侧网络诊断：向每条已鉴权移动连接发一次 WebSocket ping，量出往返时延。
//
// 设计取自上游 mobile-gateway（v0.11.2）的 network-diagnostics，但本仓库的
// 客户端是原生 ws 对象（没有 transport adapter 抽象），所以这里直接对 ws
// 发 ping；RTC 统计（rtc-ice）不适用，测量方式固定为 websocket-ping。
//
// 仅本机管理接口调用：/mgw/network-test（loopback 由 mgw 路由统一把关），
// 移动端不主动触发测量，避免被当成探测工具。
import crypto from 'node:crypto'

const MAX_CLIENTS = 256
const CONCURRENCY = 8
const SAMPLE_WINDOW_MS = 60_000
const MAX_SAMPLES = 60

export function websocketRtt(socket, { signal, timeoutMs = 3000, now = () => performance.now() } = {}) {
  return new Promise(resolve => {
    if (socket.readyState !== 1 || signal?.aborted) { resolve({ status: 'cancelled', rttMs: null }); return }
    const payload = Buffer.from(`mgw-net:${crypto.randomUUID()}`)
    const started = now()
    let timer, finished = false
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.off('pong', pong); socket.off('close', closed); socket.off('error', failed)
      signal?.removeEventListener('abort', aborted)
      resolve({ ...result, measurement: 'websocket-ping' })
    }
    const pong = data => { if (Buffer.from(data).equals(payload)) finish({ status: 'ok', rttMs: Math.max(0, now() - started) }) }
    const closed = () => finish({ status: 'disconnected', rttMs: null })
    const failed = () => finish({ status: 'error', rttMs: null })
    const aborted = () => finish({ status: 'cancelled', rttMs: null })
    socket.on('pong', pong); socket.once('close', closed); socket.once('error', failed)
    signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish({ status: 'timeout', rttMs: null }), timeoutMs)
    try { socket.ping(payload, error => { if (error) failed() }) } catch { failed() }
  })
}

async function abortable(operation, signal, timeoutMs = 3000) {
  const safe = Promise.resolve(operation).catch(() => ({ status: 'error', rttMs: null }))
  if (signal?.aborted) return { status: 'cancelled', rttMs: null }
  let timer, onAbort
  try {
    return await Promise.race([
      safe,
      new Promise(resolve => {
        onAbort = () => resolve({ status: 'cancelled', rttMs: null })
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => resolve({ status: 'timeout', rttMs: null }), timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}

export function createNetworkDiagnostics({ clients, devices, now = () => Date.now() }) {
  let busy = false, disposed = false, last = null, activeAbort
  // ws -> [{ at, rttMs }]；连接关闭后随对象回收，下一次清理时一并删掉。
  const histories = new WeakMap()
  return {
    async measure({ signal } = {}) {
      if (disposed) throw new Error('network diagnostics disposed')
      if (busy) throw Object.assign(new Error('network diagnostics busy'), { status: 409 })
      if (signal?.aborted) return { at: now(), devices: [] }
      // 1 秒内重复点击复用上一次结果，避免管理面板连点打满 ping。
      if (last && now() - last.at < 1000) return last
      busy = true
      const abort = new AbortController()
      activeAbort = abort
      const cancel = () => abort.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const connections = [...clients].filter(client => client.readyState === 1 && client.deviceId).slice(0, MAX_CLIENTS)
        const known = new Map(devices().map(device => [device.id, device]))
        const rows = new Array(connections.length)
        let index = 0
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, connections.length) }, async () => {
          while (!abort.signal.aborted) {
            const current = index++
            if (current >= connections.length) break
            const client = connections[current]
            let result
            try { result = await abortable(websocketRtt(client, { signal: abort.signal }), abort.signal) }
            catch { result = { status: 'error', rttMs: null } }
            if (!result || typeof result !== 'object') result = { status: 'unavailable', rttMs: null }
            if (client.readyState !== 1 || !clients.has(client)) result = { status: 'disconnected', rttMs: null }
            if (result.status !== 'ok' || !Number.isFinite(result.rttMs) || result.rttMs < 0) result.rttMs = null
            const history = histories.get(client) || []
            if (!abort.signal.aborted && result.status !== 'cancelled') {
              history.push({ at: now(), rttMs: result.rttMs })
              while (history.length && (history.length > MAX_SAMPLES || now() - history[0].at > SAMPLE_WINDOW_MS)) history.shift()
              histories.set(client, history)
            }
            const rtts = history.map(item => item.rttMs).filter(Number.isFinite).sort((a, b) => a - b)
            rows[current] = {
              deviceId: client.deviceId,
              name: known.get(client.deviceId)?.displayName || known.get(client.deviceId)?.name || '',
              connectionId: client.connectionId ?? null,
              channel: client.mobileChannel,
              transport: 'websocket',
              ...result,
              samples: history.map(({ at, rttMs }) => ({ at, rttMs })),
              p95RttMs: rtts.length ? rtts[Math.ceil(rtts.length * .95) - 1] : null,
              averageRttMs: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
            }
          }
        }))
        const grouped = new Map()
        for (const row of rows.filter(Boolean)) {
          if (!grouped.has(row.deviceId)) grouped.set(row.deviceId, { deviceId: row.deviceId, name: row.name, channels: [] })
          const { deviceId, name, ...channel } = row
          grouped.get(deviceId).channels.push(channel)
        }
        const snapshot = {
          at: now(),
          devices: [...grouped.values()],
          truncated: [...clients].filter(client => client.readyState === 1 && client.deviceId).length > connections.length,
        }
        if (!abort.signal.aborted) last = snapshot
        return snapshot
      } finally { signal?.removeEventListener('abort', cancel); activeAbort = null; busy = false }
    },
    dispose() { disposed = true; activeAbort?.abort(); last = null },
  }
}
