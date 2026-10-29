import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')
const plugin = (await import('../lib/index.mjs')).default
const { createTestConnection } = await import('./helpers/peer.mjs')

// Regression: after a DSH restart the phone's existing connection always dies
// with the old process. This test proves the gateway side of the recovery:
// the saved mode comes back enabled, the LAN listener rebinds, the paired
// device's long-lived token still authenticates, and the bundled relay
// connector is respawned against the NEW ephemeral web port. A phone that
// reconnects after the restart must be admitted, not rejected.

// The lifetime currently under test, so a failed assertion still disposes
// the plugin and its real connector child instead of leaking it.
let active = null

function waitForMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 3000)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.kind !== kind) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => { probe.close(resolve) })
  return port
}

// One DSH lifetime: a real HTTP server on an ephemeral port (the desktop app
// picks a new one every launch) plus the plugin applied against it.
async function startLifetime({ temp, lanPort, relayPort, deviceFile, gatewayStateFile, gatewayWaitTimeoutMs }) {
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  let managementRoute
  let upgradeRoute
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  let disposePlugin
  const ctx = {
    connection: createTestConnection(),
    inject(names) {
      if (names.length === 1 && names[0] === 'accountController') return
      assert.deepEqual(names, ['workspaceChanges'])
    },
    webServer,
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream() {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          while (!request_signal_aborted()) await new Promise((resolve) => setTimeout(resolve, 5))
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }
  let aborted = false
  const request_signal_aborted = () => aborted
  // 记录内置连接器每次启动拿到的环境变量。用注入缝包住真正的 spawn：连接器照旧
  // 真跑，我们只是旁观。原先靠 `ps eww -p <pid>` 读别的进程环境，那是 POSIX 专有，
  // Windows 上既没有 ps 也读不到环境，断言必然失败。
  const connectorLaunches = []
  const recordingSpawnProcess = (command, args, options) => {
    if (args.some((arg) => String(arg).includes('agent-connector'))) {
      connectorLaunches.push({ pid: undefined, env: options && options.env })
    }
    const child = spawn(command, args, options)
    const last = connectorLaunches[connectorLaunches.length - 1]
    if (last && last.env === (options && options.env)) last.pid = child.pid
    return child
  }
  // The real host has its port bound before plugins apply (the bundled
  // connector builds GATEWAY_URL from it at apply time), so bind first.
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  plugin.apply(ctx, {
    requireAuth: true,
    gatewayEnabled: false,
    gatewayWaitTimeoutMs: gatewayWaitTimeoutMs ?? 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: deviceFile ?? path.join(temp, 'devices.json'),
    gatewayStateFile: gatewayStateFile ?? path.join(temp, 'devices.json.gateway.json'),
    relayStateFile: path.join(temp, 'devices.json.relay.json'),
    publicUrlFile: path.join(temp, 'missing-public-url'),
    logFile: path.join(temp, 'gateway.log'),
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort,
    spawnProcess: recordingSpawnProcess,
  })
  return {
    webServer,
    base: `http://127.0.0.1:${webServer.port}`,
    connectorLaunches,
    stop: async () => {
      aborted = true
      disposePlugin()
      server.close()
      await once(server, 'close')
    },
  }
}

;(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-restart-'))
  const lanPort = await freePort()
  const relayPort = await freePort()

  // The hosted relay, stood up locally: accept the connector's registration.
  const relaySockets = new Set()
  const relayServer = new WebSocket.Server({ port: relayPort, path: '/relay' })
  relayServer.on('connection', (ws) => { relaySockets.add(ws); ws.on('close', () => relaySockets.delete(ws)) })

  // The connector is a real child process; keep its identity out of the
  // operator's ~/.dsh-weapp-relay so it cannot collide with a live install.
  process.env.STATE_DIR = path.join(temp, 'relay-identity')

  // A persisted relay registration is what makes the real deployment spawn
  // the bundled connector at every launch (shouldRunRelayConnector), so the
  // restart test starts from the same shape.
  fs.writeFileSync(path.join(temp, 'devices.json.relay.json'), JSON.stringify({
    version: 1,
    pairingMode: 'direct',
    relay: {
      relay: `ws://127.0.0.1:${relayPort}/relay`,
      nodeId: '0f1e2d3c-4b5a-4967-8899-aabbccddeeff',
      agentPubKey: 'nU2yVdMWY2fePU9MHkkD6PQJ3V+FkyItgDfWjVy95Go=',
      gatewayName: 'restart-test',
      updatedAt: Date.now(),
    },
  }))

  const deviceId = '3f6b1c2e-9a41-4c73-8d5b-2e7a1f0c9b84'

  // ---------------------------------------------------------------- life one
  const first = await startLifetime({ temp, lanPort, relayPort })
  active = first
  const lanUrl = `ws://127.0.0.1:${lanPort}/ws/mobile`

  const enable = await fetch(`${first.base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: first.base },
    body: JSON.stringify({ mode: 'persistent' }),
  })
  assert.equal(enable.status, 200)
  assert.equal((await enable.json()).gatewayMode, 'persistent')

  const pairResponse = await fetch(`${first.base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: first.base },
    body: JSON.stringify({ name: 'Restart iPhone', publicUrl: lanUrl }),
  })
  assert.equal(pairResponse.status, 201)
  const pair = await pairResponse.json()

  const phone = new WebSocket(lanUrl, ['dsh-mobile-v1', `dsh-pair.${pair.payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': deviceId },
  })
  const pairedPromise = waitForMessage(phone, 'paired')
  await once(phone, 'open')
  const paired = await pairedPromise
  assert.equal(typeof paired.token, 'string')

  // Register the relay the way the management UI does, then let the supervisor
  // spawn the bundled connector.
  const registerRelay = await fetch(`${first.base}/mgw/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: first.base },
    body: JSON.stringify({
      relay: `ws://127.0.0.1:${relayPort}/relay`,
      nodeId: '0f1e2d3c-4b5a-4967-8899-aabbccddeeff',
      agentPubKey: 'nU2yVdMWY2fePU9MHkkD6PQJ3V+FkyItgDfWjVy95Go=',
      gatewayName: 'restart-test',
    }),
  })
  assert.equal(registerRelay.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const firstStatus = await (await fetch(`${first.base}/mgw/status`)).json()
  assert.equal(firstStatus.relayConnector.running, true, 'life one spawned the bundled connector')
  const firstConnectorPid = firstStatus.relayConnector.pid
  const firstGatewayPort = firstStatus.webPort

  // ------------------------------------------------- restart: life one dies
  phone.close()
  await once(phone, 'close')
  await first.stop()
  assert.equal((await fetch(`http://127.0.0.1:${firstGatewayPort}/mgw/status`).catch(() => ({ status: 0 }))).status, 0,
    'the old web port is gone after the restart')

  // ---------------------------------------------------------------- life two
  const second = await startLifetime({ temp, lanPort, relayPort })
  active = second
  assert.notEqual(second.webServer.port, firstGatewayPort, 'the desktop app picked a new web port')

  const restartedStatus = await (await fetch(`${second.base}/mgw/status`)).json()
  assert.equal(restartedStatus.gatewayEnabled, true, 'the saved persistent mode survives the restart')
  assert.equal(restartedStatus.gatewayMode, 'persistent')
  assert.equal(restartedStatus.lan.listening, true, 'the LAN listener rebinds after the restart')
  assert.deepEqual(restartedStatus.lan.urls, [`ws://127.0.0.1:${lanPort}/ws/mobile`])
  assert.equal(restartedStatus.devices, undefined) // status carries no device count; the list does

  const devicesAfterRestart = await (await fetch(`${second.base}/mgw/devices`)).json()
  assert.equal(devicesAfterRestart.devices.length, 1, 'the paired device survives the restart')
  assert.equal(devicesAfterRestart.devices[0].online, false)

  // The phone reconnects with its saved long-lived token, exactly like the
  // DSH App / mini-program do after the desktop side came back.
  const reconnected = new WebSocket(lanUrl, ['dsh-mobile-v1'], {
    headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
  })
  const helloPromise = waitForMessage(reconnected, 'hello')
  await once(reconnected, 'open')
  const hello = await helloPromise
  assert.equal(hello.authenticated, true, 'the saved token still authenticates after the restart')
  assert.equal(hello.gatewayId, restartedStatus.gatewayId, 'the gateway identity is stable across restarts')

  const devicesOnline = await (await fetch(`${second.base}/mgw/devices`)).json()
  assert.equal(devicesOnline.devices[0].online, true, 'the reconnected phone shows online')
  assert.deepEqual(devicesOnline.devices[0].routes, ['lan'])

  // The bundled connector must be respawned against the NEW web port; a
  // connector still dialling the dead port is the "phone never reconnects"
  // failure for relay-routed clients.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const secondConnectorStatus = (await (await fetch(`${second.base}/mgw/status`)).json()).relayConnector
  assert.equal(secondConnectorStatus.running, true, 'the connector is respawned after the restart')
  assert.notEqual(secondConnectorStatus.pid, firstConnectorPid, 'a fresh connector process replaces the dead one')
  // 环境变量从注入缝记录，不靠 ps 读别的进程（POSIX 专有，Windows 上不可用）。
  const respawned = second.connectorLaunches.find((launch) => launch.pid === secondConnectorStatus.pid)
  assert.ok(respawned, 'the respawned connector was launched through the injected spawn')
  assert.equal(respawned.env.GATEWAY_URL, `ws://127.0.0.1:${second.webServer.port}/ws/mobile`,
    'the respawned connector dials the new web port')
  assert.notEqual(respawned.env.GATEWAY_URL, `ws://127.0.0.1:${firstGatewayPort}/ws/mobile`,
    'the respawned connector does not keep the dead port')

  reconnected.close()
  await once(reconnected, 'close')
  await second.stop()
  active = null

  // ------------------------------------------------- temporary mode + wait
  // The other "phone cannot reconnect after a restart" shape: temporary
  // mode auto-disables when nobody connects inside the wait window. That
  // must stay a runtime safety net — persisting 'disabled' would silently
  // overwrite the operator's saved 'temporary' choice, so the NEXT restart
  // would boot closed and reject every phone reconnect with 503 until
  // somebody re-enabled the gateway by hand.
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-temporary-'))
  const gatewayStateFile = path.join(temporaryDir, 'gateway.json')
  fs.writeFileSync(gatewayStateFile, JSON.stringify({
    version: 1,
    gatewayId: '5b9d1f4a-2c3e-4a8b-9d7f-1e2c3b4a5d6e',
    mode: 'temporary',
  }))
  const temporaryDeviceFile = path.join(temporaryDir, 'devices.json')

  // Lifetime one pairs a device (a connection cancels the wait timer, so the
  // pairing runs under a long window).
  const temporaryOne = await startLifetime({
    temp: temporaryDir,
    lanPort: await freePort(),
    relayPort,
    deviceFile: temporaryDeviceFile,
    gatewayStateFile,
    gatewayWaitTimeoutMs: 60_000,
  })
  active = temporaryOne
  const temporaryStatus = await (await fetch(`${temporaryOne.base}/mgw/status`)).json()
  assert.equal(temporaryStatus.gatewayEnabled, true, 'temporary mode opens a fresh window after the restart')
  assert.equal(temporaryStatus.gatewayMode, 'temporary')
  assert.equal(typeof temporaryStatus.waitExpiresAt, 'number', 'the wait window is counting')

  const temporaryWsUrl = `ws://127.0.0.1:${temporaryOne.webServer.port}/ws/mobile`
  const temporaryPair = await (await fetch(`${temporaryOne.base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: temporaryOne.base },
    body: JSON.stringify({ name: 'Temporary iPhone' }),
  })).json()
  const temporaryPhone = new WebSocket(temporaryWsUrl,
    ['dsh-mobile-v1', `dsh-pair.${temporaryPair.payload.pairingCode}`],
    { headers: { 'X-DSH-Device-ID': 'temporary-device-0001' } })
  const temporaryPairedPromise = waitForMessage(temporaryPhone, 'paired')
  await once(temporaryPhone, 'open')
  const temporaryPaired = await temporaryPairedPromise
  temporaryPhone.close()
  await once(temporaryPhone, 'close')
  await temporaryOne.stop()
  active = null

  // Lifetime two is the restart where nobody reconnects in time: the wait
  // window closes the gateway, and that must NOT be persisted.
  const temporaryTwo = await startLifetime({
    temp: temporaryDir,
    lanPort: await freePort(),
    relayPort,
    deviceFile: temporaryDeviceFile,
    gatewayStateFile,
    gatewayWaitTimeoutMs: 1_000,
  })
  active = temporaryTwo
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const timedOut = await (await fetch(`${temporaryTwo.base}/mgw/status`)).json()
  assert.equal(timedOut.gatewayEnabled, false, 'the wait window still auto-closes the gateway')
  const savedMode = JSON.parse(fs.readFileSync(gatewayStateFile, 'utf8'))
  assert.equal(savedMode.mode, 'temporary',
    'the auto-disable is not persisted: the operator keeps their saved choice')

  // While closed, a reconnect is rejected — that is the documented
  // behaviour of temporary mode for this run.
  const rejected = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${temporaryTwo.webServer.port}/ws/mobile`, ['dsh-mobile-v1'], {
      headers: { Authorization: `Bearer ${temporaryPaired.token}`, 'X-DSH-Device-ID': 'temporary-device-0001' },
    })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out waiting for rejection')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); reject(new Error('expected rejection')) })
    ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(res.statusCode) })
    ws.on('error', () => {})
  })
  assert.equal(await rejected, 503, 'a closed temporary gateway rejects reconnects for this run')
  await temporaryTwo.stop()
  active = null

  // The next restart re-opens the window, so the phone can reconnect.
  const temporaryThree = await startLifetime({
    temp: temporaryDir,
    lanPort: await freePort(),
    relayPort,
    deviceFile: temporaryDeviceFile,
    gatewayStateFile,
    gatewayWaitTimeoutMs: 60_000,
  })
  active = temporaryThree
  const reopened = await (await fetch(`${temporaryThree.base}/mgw/status`)).json()
  assert.equal(reopened.gatewayEnabled, true, 'the restart re-opens the saved temporary mode')
  const backOnline = new WebSocket(`ws://127.0.0.1:${temporaryThree.webServer.port}/ws/mobile`, ['dsh-mobile-v1'], {
    headers: { Authorization: `Bearer ${temporaryPaired.token}`, 'X-DSH-Device-ID': 'temporary-device-0001' },
  })
  const reopenedHello = waitForMessage(backOnline, 'hello')
  await once(backOnline, 'open')
  assert.equal((await reopenedHello).authenticated, true, 'the phone reconnects after the restart')
  backOnline.close()
  await once(backOnline, 'close')
  await temporaryThree.stop()
  active = null

  // ------------------------------------------- LAN port handoff after restart
  // An app relaunch can start the new DSH before the old process released
  // the LAN port. The listener must retry instead of leaving every LAN
  // phone with ECONNREFUSED until the next manual restart.
  const racedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-lanrace-'))
  const blocker = http.createServer(() => {})
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const heldPort = blocker.address().port
  const raced = await startLifetime({
    temp: racedDir,
    lanPort: heldPort,
    relayPort,
    deviceFile: path.join(racedDir, 'devices.json'),
    gatewayStateFile: path.join(racedDir, 'gateway.json'),
    gatewayWaitTimeoutMs: 60_000,
  })
  active = raced
  await new Promise((resolve) => setTimeout(resolve, 400))
  const blockedStatus = await (await fetch(`${raced.base}/mgw/status`)).json()
  assert.equal(blockedStatus.lan.listening, false, 'the LAN listener reports the failed bind')
  assert.match(blockedStatus.lan.error, /EADDRINUSE|address already in use/i,
    `the bind failure names the port conflict (got: ${blockedStatus.lan.error})`)
  blocker.close()
  await once(blocker, 'close')
  let recoveredStatus = blockedStatus
  for (let attempt = 0; attempt < 50; attempt += 1) {
    recoveredStatus = await (await fetch(`${raced.base}/mgw/status`)).json()
    if (recoveredStatus.lan.listening) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(recoveredStatus.lan.listening, true,
    'the LAN listener retries and binds once the old process releases the port')
  assert.equal(recoveredStatus.lan.error, null, 'the recovered listener clears the error')
  assert.deepEqual(recoveredStatus.lan.urls, [`ws://127.0.0.1:${heldPort}/ws/mobile`],
    'the recovered listener advertises the same LAN address')
  await raced.stop()
  active = null
  fs.rmSync(racedDir, { recursive: true, force: true })

  relayServer.close()
  fs.rmSync(temp, { recursive: true, force: true })
  fs.rmSync(temporaryDir, { recursive: true, force: true })
  console.log('RESTART RECONNECT TESTS PASSED')
})().catch(async (error) => {
  // Never leak the real connector child when an assertion fails mid-test.
  if (active) await active.stop().catch(() => {})
  console.error(error)
  process.exit(1)
})
