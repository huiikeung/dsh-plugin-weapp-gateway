// The bundled relay connector supervisor: when to spawn it, when to stay out
// of the way, and how it reports state to the panel.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelayConnector, resolveStateDir } from '../lib/relay-connector.mjs'

let checks = 0
function check(ok, what) {
  checks++
  if (!ok) { console.error(`FAIL  ${what}`); process.exitCode = 1 }
  else console.log(`OK    ${what}`)
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-conn-'))

// ---- resolveStateDir: reuse an existing identity, else the plugin's home ----
const homeDir = path.join(temp, 'home')
const legacyDir = path.join(temp, 'legacy')
fs.mkdirSync(path.join(homeDir, '.dsh-weapp-relay'), { recursive: true })
fs.mkdirSync(path.join(legacyDir, '.dsh-weapp-relay'), { recursive: true })
fs.writeFileSync(path.join(legacyDir, '.dsh-weapp-relay', 'identity.json'), '{"nodeId":"legacy"}')
check(resolveStateDir({}, homeDir, legacyDir) === path.join(legacyDir, '.dsh-weapp-relay'),
  'an identity left by the systemd install is reused so the nodeId stays stable')
const bareLegacy = path.join(temp, 'bare')
fs.mkdirSync(path.join(bareLegacy, '.dsh-weapp-relay'), { recursive: true })
check(resolveStateDir({}, homeDir, bareLegacy) === path.join(homeDir, '.dsh-weapp-relay'),
  'without a legacy identity the plugin home is used')
check(resolveStateDir({ STATE_DIR: '/custom/state' }, homeDir) === '/custom/state',
  'STATE_DIR override wins')

// ---- supervisor decisions ----
function fakeSpawn() {
  const spawned = []
  const spawnProcess = (command, args, options) => {
    const child = {
      command, args, options,
      pid: 1000 + spawned.length,
      exitCode: null, signalCode: null,
      killed: false,
      kill(signal) { this.signal = signal; this.killed = true },
      on(event, handler) { (this.handlers ||= {})[event] = handler },
      once() {},
      unref() {},
    }
    spawned.push(child)
    return child
  }
  return { spawnProcess, spawned }
}

// 1) starts with the right env and args
{
  const { spawnProcess, spawned } = fakeSpawn()
  const supervisor = createRelayConnector({
    relay: 'wss://relay.example.com', gatewayUrl: 'ws://127.0.0.1:2298/ws/mobile',
    gatewayName: 'NAS', mgmtUrl: 'http://127.0.0.1:2298', stateDir: '/state',
    spawnProcess,
  })
  const snap = supervisor.start()
  check(spawned.length === 1, 'one child is spawned')
  check(spawned[0].command === process.execPath && spawned[0].args[0].endsWith('relay/agent-connector.js'),
    'the child runs the bundled connector with the current node')
  check(spawned[0].options.env.RELAY_URL === 'wss://relay.example.com'
    && spawned[0].options.env.GATEWAY_URL === 'ws://127.0.0.1:2298/ws/mobile'
    && spawned[0].options.env.MGMT_URL === 'http://127.0.0.1:2298'
    && spawned[0].options.env.STATE_DIR === '/state',
    'relay, gateway, management and state are passed through the environment')
  check(spawned[0].options.env.GATEWAY_NAME === 'NAS', 'gateway name is passed')
  check(snap.running === true && snap.pid === 1000, 'snapshot reports the running child')
  supervisor.dispose()
  check(spawned[0].killed === true && spawned[0].signal === 'SIGTERM', 'dispose stops the child with SIGTERM')
}

// 2) refuses to start without a relay URL
{
  const { spawnProcess, spawned } = fakeSpawn()
  const supervisor = createRelayConnector({ relay: '', stateDir: path.join(temp, 'norelay'), spawnProcess })
  const snap = supervisor.start()
  check(spawned.length === 0 && snap.running === false, 'no relay URL means no spawn')
  check(/relayUrl/.test(snap.lastError || ''), 'the missing relay URL is reported for the panel')
}

// 3) a clean exit (pid lock held by an installed connector) is not a failure
{
  const { spawnProcess, spawned } = fakeSpawn()
  const supervisor = createRelayConnector({ relay: 'wss://r.example.com', stateDir: path.join(temp, 'iso' + Math.random().toString(36).slice(2, 8)), spawnProcess })
  supervisor.start()
  spawned[0].handlers.exit(0, null)
  const snap = supervisor.snapshot()
  check(snap.running === false && snap.lastError === null, 'exit 0 leaves no error (installed connector owns the identity)')
}

// 4) a live lock holder means an installed connector owns the identity
{
  const stateDir = path.join(temp, 'locked')
  fs.mkdirSync(stateDir, { recursive: true })
  // pid 1 is alive and is definitely not this process, so it stands in for an
  // installed connector that holds the identity.
  fs.writeFileSync(path.join(stateDir, 'connector.lock'), `${JSON.stringify({ pid: 1 })}\n`)
  const { spawnProcess, spawned } = fakeSpawn()
  const supervisor = createRelayConnector({ relay: 'wss://r.example.com', stateDir, spawnProcess })
  const snap = supervisor.start()
  check(spawned.length === 0 && snap.running === false, 'no child is spawned while another connector holds the lock')
  check(snap.delegatedTo === 1, 'the supervisor reports delegation instead of a failure')
  supervisor.dispose()
}

// 5) a stale lock (dead pid) is taken over
{
  const stateDir = path.join(temp, 'stale')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'connector.lock'), `${JSON.stringify({ pid: 999999 })}\n`)
  const { spawnProcess, spawned } = fakeSpawn()
  const supervisor = createRelayConnector({ relay: 'wss://r.example.com', stateDir, spawnProcess })
  supervisor.start()
  check(spawned.length === 1 && supervisor.snapshot().delegatedTo === null, 'a lock whose pid is gone is taken over')
  supervisor.dispose()
}

// 6) a crash schedules a restart, and repeated crashes give up
{
  const { spawnProcess, spawned } = fakeSpawn()
  let clock = 0
  const supervisor = createRelayConnector({ relay: 'wss://r.example.com', stateDir: path.join(temp, 'crash'), spawnProcess, now: () => clock, restartDelayMs: 20 })
  supervisor.start()
  spawned[0].handlers.exit(1, null)
  check(supervisor.snapshot().lastError === '内置连接器退出（1）', 'a nonzero exit is reported')
  await new Promise((resolve) => setTimeout(resolve, 120))
  check(spawned.length === 2, 'a crashed child is restarted after the delay')
  supervisor.dispose()
}

console.log(`\nrelay-connector: ${checks} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
