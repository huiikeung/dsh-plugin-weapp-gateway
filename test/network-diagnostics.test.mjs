// 服务端网络诊断模块：WebSocket 协议 RTT 的测量、超时/断开清理，以及按设备
// 与通道分组的历史样本。适配自上游 network-diagnostics 测试（本仓库只保留
// WebSocket 路径，没有 WebRTC 统计）。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { websocketRtt, createNetworkDiagnostics } from '../lib/network-diagnostics.mjs'

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1 }
  ping(payload) { this.payload = payload }
}

test('WebSocket RTT matches protocol payload and ignores business or unrelated pong', async () => {
  const socket = new Socket()
  let now = 100
  const pending = websocketRtt(socket, { now: () => now })
  socket.emit('pong', Buffer.from('heartbeat'))
  now = 135
  socket.emit('pong', socket.payload)
  assert.deepEqual(await pending, { status: 'ok', rttMs: 35, measurement: 'websocket-ping' })
  for (const name of ['pong', 'close', 'error']) assert.equal(socket.listenerCount(name), 0)
})

test('timeout, page abort, disconnect and send failure all release probe listeners', async () => {
  for (const mode of ['timeout', 'abort', 'close', 'error']) {
    const socket = new Socket(), abort = new AbortController()
    const pending = websocketRtt(socket, { signal: abort.signal, timeoutMs: 8 })
    if (mode === 'abort') abort.abort()
    if (mode === 'close') socket.emit('close')
    if (mode === 'error') socket.emit('error', new Error('failure'))
    const result = await pending
    assert.equal(result.status, { timeout: 'timeout', abort: 'cancelled', close: 'disconnected', error: 'error' }[mode])
    assert.equal(result.rttMs, null)
    assert.equal(socket.listenerCount('pong'), 0)
  }
})

test('only connected registered devices are grouped and history is bounded', async () => {
  let now = 10000
  const control = Object.assign(new Socket(), { connectionId: 1, deviceId: 'd1', mobileChannel: 'control' })
  const conversation = Object.assign(new Socket(), { connectionId: 2, deviceId: 'd1', mobileChannel: 'conversation' })
  const offline = Object.assign(new Socket(), { connectionId: 3, deviceId: 'd1', mobileChannel: 'legacy' })
  offline.readyState = 3
  const anonymous = Object.assign(new Socket(), { connectionId: 4, deviceId: undefined, mobileChannel: 'legacy' })
  const clients = new Set([control, conversation, offline, anonymous])
  for (const socket of [control, conversation]) {
    socket.ping = (payload) => setTimeout(() => socket.emit('pong', Buffer.from(payload)), 5)
  }
  const manager = createNetworkDiagnostics({ clients, devices: () => [{ id: 'd1', displayName: 'Phone' }], now: () => now })
  const first = await manager.measure()
  assert.equal(first.devices.length, 1)
  assert.equal(first.devices[0].name, 'Phone')
  assert.equal(first.devices[0].channels.length, 2)
  assert.deepEqual(first.devices[0].channels.map((channel) => channel.channel).sort(), ['control', 'conversation'])
  for (const channel of first.devices[0].channels) {
    assert.equal(channel.status, 'ok')
    assert.equal(channel.transport, 'websocket')
    assert.equal(channel.measurement, 'websocket-ping')
    assert.ok(channel.rttMs >= 0)
    assert.equal(channel.samples.length, 1)
    assert.ok(channel.p95RttMs >= 0)
  }

  // 1 秒内重复测量复用上一次快照，避免连点打满 ping。
  now = 10500
  assert.equal(await manager.measure(), first)
  now = 12000
  const second = await manager.measure()
  assert.equal(second.devices[0].channels[0].samples.length, 2)

  // 断开连接不再出现在结果里，历史随对象回收。
  control.readyState = 3
  now = 13000
  const third = await manager.measure()
  assert.equal(third.devices[0].channels.length, 1)
  manager.dispose()
  await assert.rejects(manager.measure(), /disposed/)
})
