// Supervisor for the bundled relay connector (relay/agent-connector.js).
//
// Relay mode needs a local bridge: an outbound WebSocket to the VPS relay that
// registers this gateway's identity with the plugin and pipes mini-program
// traffic to the local mobile endpoint. Historically that bridge was a manual
// deployment (copy files, npm install, systemd unit), and a missed
// registration — e.g. the plugin restarting while the connector dialled — left
// the pairing QR dead with a healthy-looking process.
//
// This module closes that gap: when relay mode is on and nothing has
// registered, the plugin starts its own bundled copy. The copy takes a pid
// lock on the identity directory, so an already-installed connector (systemd)
// keeps ownership and the spawned one exits immediately. When an external
// connector is registered the supervisor stays idle, and the operator's
// existing deployment is untouched.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONNECTOR_SCRIPT = fileURLToPath(new URL('../relay/agent-connector.js', import.meta.url))
const MAX_RAPID_RESTARTS = 5

function commandExists(file) {
  if (path.isAbsolute(file)) return fs.existsSync(file)
  return (process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, file)))
}

// Prefer an identity that already exists so a spawned copy keeps the nodeId the
// relay and paired mini-program know. Candidates, in order: the plugin's own
// home, then the root home used by the documented systemd install.
export function resolveStateDir(env = process.env, home = os.homedir(), legacyHome = '/root') {
  if (env.STATE_DIR) return env.STATE_DIR
  const candidates = [path.join(home, '.dsh-weapp-relay')]
  if (legacyHome && path.resolve(legacyHome) !== path.resolve(home)) {
    candidates.push(path.join(legacyHome, '.dsh-weapp-relay'))
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'identity.json')).isFile()) return candidate
    } catch { /* no identity here */ }
  }
  return candidates[0]
}

export function createRelayConnector({ relay, gatewayUrl, gatewayName, mgmtUrl,
  stateDir = resolveStateDir(), log = () => {}, spawnProcess = spawn, now = () => Date.now(),
  restartDelayMs = 5_000 } = {}) {
  let child = null
  let restartTimer = null
  let stopped = false
  let restarts = 0
  let windowStart = now()
  let lastError = null
  let delegatedTo = null

  const snapshot = () => ({
    running: child !== null && child.exitCode === null && child.signalCode === null,
    pid: child === null ? null : child.pid,
    stateDir,
    relay: relay || null,
    lastError,
    delegatedTo,
  })

  const clearTimer = () => {
    if (restartTimer === null) return
    clearTimeout(restartTimer)
    restartTimer = null
  }

  const stop = () => {
    stopped = true
    clearTimer()
    const previous = child
    child = null
    if (previous === null || previous.exitCode !== null || previous.signalCode !== null) return
    previous.kill('SIGTERM')
    // The connector exits on SIGTERM; do not wait forever if it is wedged.
    const killTimer = setTimeout(() => {
      if (previous.exitCode === null && previous.signalCode === null) previous.kill('SIGKILL')
    }, 3_000)
    killTimer.unref?.()
  }

  // A live pid in the lock file means somebody else already owns this identity
  // (the documented systemd install). Spawning would just exit, so report the
  // delegation instead — and, crucially, do not treat a stale registration as
  // proof that a bridge is alive: our own child dies with the plugin.
  const lockHolder = () => {
    try {
      const held = JSON.parse(fs.readFileSync(path.join(stateDir, 'connector.lock'), 'utf8'))
      if (!Number.isInteger(held.pid) || held.pid === process.pid) return null
      try { process.kill(held.pid, 0); return held.pid } catch (error) { if (error.code !== 'ESRCH') return held.pid }
      return null
    } catch { return null }
  }

  const start = ({ force = false } = {}) => {
    if (child !== null && child.exitCode === null && child.signalCode === null) return snapshot()
    if (!force) {
      const holder = lockHolder()
      if (holder !== null) {
        delegatedTo = holder
        lastError = null
        return snapshot()
      }
    }
    if (!relay) {
      lastError = '未配置中继地址（relayUrl），无法启动内置连接器'
      return snapshot()
    }
    if (!force && !commandExists(process.execPath)) {
      lastError = `node 可执行文件不可用：${process.execPath}`
      return snapshot()
    }
    stopped = false
    lastError = null
    let spawned
    try {
      spawned = spawnProcess(process.execPath, [CONNECTOR_SCRIPT], {
        env: {
          ...process.env,
          RELAY_URL: relay,
          GATEWAY_URL: gatewayUrl,
          GATEWAY_NAME: gatewayName || '',
          MGMT_URL: mgmtUrl,
          STATE_DIR: stateDir,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      lastError = `启动内置连接器失败：${error.message}`
      return snapshot()
    }
    child = spawned
    delegatedTo = null
    log(`bundled connector starting: pid=${spawned.pid} relay=${relay} state=${stateDir}`)
    spawned.on('error', (error) => {
      if (child !== spawned) return
      lastError = `内置连接器启动失败：${error.message}`
      log(lastError)
    })
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      // Exit 0 with the pid lock held elsewhere is the expected "an installed
      // connector already owns this identity" path — not a failure.
      if (code === 0) {
        log('bundled connector exited; an installed connector likely owns the identity')
        return
      }
      lastError = `内置连接器退出（${signal || code}）`
      log(lastError)
      if (stopped) return
      const at = now()
      if (at - windowStart > 60_000) { restarts = 0; windowStart = at }
      restarts += 1
      if (restarts > MAX_RAPID_RESTARTS) {
        lastError = '内置连接器反复退出，已停止自动重启'
        log(lastError)
        return
      }
      restartTimer = setTimeout(() => { restartTimer = null; start() }, restartDelayMs)
      restartTimer.unref?.()
    })
    return snapshot()
  }

  const dispose = () => { stop() }

  return { start, stop, snapshot, dispose }
}
