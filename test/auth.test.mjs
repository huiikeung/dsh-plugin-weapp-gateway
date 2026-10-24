import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')
const plugin = (await import('../lib/index.mjs')).default
const { createRegistry } = require('../lib/devices.js')

function waitForMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 2000)
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

function expectRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    ws.once('open', () => reject(new Error('expected WebSocket rejection')))
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.once('error', () => {})
  })
}

;(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-auth-'))
  const registryFile = path.join(temp, 'devices.json')
  const publicUrlFile = path.join(temp, 'public-url')
  fs.writeFileSync(publicUrlFile, '# Managed by test\nwss://203.0.113.10/ws/mobile\n')

  // Registry contract: pairing is single-use and neither the pairing code nor
  // the long-lived token is persisted.
  const registry = createRegistry(registryFile, { pairingTtlMs: 60_000 })
  const pairing = registry.createPairing('Test iPhone')
  assert.equal(registry.hasPairing(pairing.code), true)
  // The management panel polls pendingPairings() to close the QR dialog as
  // soon as the code is consumed: present while redeemable, gone once claimed.
  assert.deepEqual(registry.pendingPairings(), [pairing.id])
  const secondPending = registry.createPairing('Second Phone')
  assert.deepEqual(registry.pendingPairings().sort(), [pairing.id, secondPending.id].sort())
  assert.equal(registry.pendingPairings().includes(pairing.id), true)
  const clientDeviceId = '8f22f2b1-b4c0-42bd-bd91-b145f8b375a4'
  let claimed = registry.claimPairing(pairing.code)
  assert.ok(claimed)
  assert.equal(registry.claimPairing(pairing.code), undefined)
  // A consumed code leaves the pending list — that is the panel's signal.
  assert.equal(registry.pendingPairings().includes(pairing.id), false)
  assert.equal(registry.authenticate(claimed.token, clientDeviceId).id, claimed.device.id)
  const firstDeviceId = claimed.device.id
  const firstToken = claimed.token
  const secondPairing = registry.createPairing('Renamed Test iPhone')
  claimed = registry.claimPairing(secondPairing.code, clientDeviceId, 'Renamed Test iPhone')
  assert.equal(claimed.device.id, firstDeviceId)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].name, 'Renamed Test iPhone')
  assert.equal(registry.authenticate(firstToken), undefined)
  assert.equal(registry.authenticate(claimed.token).id, firstDeviceId)
  const stored = fs.readFileSync(registryFile, 'utf8')
  assert.equal(stored.includes(pairing.code), false)
  assert.equal(stored.includes(claimed.token), false)
  assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600)
  registry.connected(claimed.device.id)
  assert.equal(registry.list()[0].online, true)
  registry.disconnected(claimed.device.id)
  assert.equal(registry.list()[0].online, false)
  assert.equal(registry.revoke(claimed.device.id), true)
  assert.equal(registry.authenticate(claimed.token), undefined)

  const firstNamed = registry.claimPairing(registry.createPairing('Ignored desktop name').code, 'named-device-001', '我的手机')
  const secondNamed = registry.claimPairing(registry.createPairing().code, 'named-device-002', '我的手机')
  assert.deepEqual(registry.list().map((device) => device.displayName), ['我的手机 (1)', '我的手机 (2)'])
  assert.equal(registry.list()[0].name, '我的手机')
  registry.authenticate(firstNamed.token, 'named-device-001', '新名称')
  assert.deepEqual(registry.list().map((device) => device.displayName), ['新名称', '我的手机'])
  registry.revoke(firstNamed.device.id)
  registry.revoke(secondNamed.device.id)
  const unnamed = registry.claimPairing(registry.createPairing('Ignored desktop name').code, 'unnamed-device-001')
  assert.equal(unnamed.device.name, '未命名设备')
  registry.revoke(unnamed.device.id)

  let managementRoute
  let upgradeRoute
  let disposePlugin
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  let attachWorkspaceChanges, disposeWorkspaceChanges
  let snapshotPresent = true
  const changeSummary = { turn: 1, total: 1, added: 2, deleted: 1,
    files: [{ path: 'src/app.js', display: 'src/app.js', added: 2, deleted: 1 }] }
  const changeDiff = { kind: 'text', path: 'src/app.js', display: 'src/app.js',
    before: true, after: true, coarse: false, hunks: [] }
  const ctx = {
    inject(names, callback) {
      // Optional host services are injected before workspaceChanges; leave them
      // unbound so this gateway advertises only the capabilities under test.
      if (names.length === 1 && names[0] === 'accountController') return
      assert.deepEqual(names, ['workspaceChanges'])
      attachWorkspaceChanges = () => callback({
        workspaceChanges: {
          summary(id, seq) { assert.equal(id, 's1'); assert.equal(seq, 12); return snapshotPresent ? changeSummary : undefined },
          async diff(id, seq, index) { assert.equal(id, 's1'); assert.equal(seq, 12); assert.equal(index, 0); return changeDiff },
        },
        effect(factory) { disposeWorkspaceChanges = factory() },
      })
    },
    webServer,
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'speech' && request.method === 'catalog') return {
          providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
          selection: { providerId: 'sensevoice-local', language: 'auto' },
          maxAudioBytes: 4194304, maxDurationSeconds: 120,
        }
        if (request.namespace === 'speech' && request.method === 'transcribe') {
          assert.equal(request.args.request.audioBase64, 'AA==')
          assert.ok(request.signal instanceof AbortSignal)
          return { text: '测试语音', audioSeconds: 1, inferenceSeconds: 0.1 }
        }
        throw new Error('unexpected Remote invocation')
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }
  plugin.apply(ctx, {
    requireAuth: true,
    gatewayEnabled: false,
    gatewayWaitTimeoutMs: 1_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'integration-devices.json'),
    logFile: path.join(temp, 'gateway.log'),
    publicUrlFile,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`
  const wsUrl = `ws://127.0.0.1:${webServer.port}/ws/mobile`

  const initialStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(initialStatus.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(initialStatus.publicUrl, 'wss://203.0.113.10/ws/mobile')
  assert.equal(initialStatus.webPort, webServer.port)
  const helperStatus = await (await fetch(`${base}/mgw/public-setup`)).json()
  assert.equal(helperStatus.installed, false)

  const blockedPublicSetup = await fetch(`${base}/mgw/public-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ publicIp: '8.8.8.8' }),
  })
  assert.equal(blockedPublicSetup.status, 403)

  assert.equal(await expectRejected(wsUrl), 503)

  const enableGatewayResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enableGatewayResponse.status, 200)
  const enableGatewayBody = await enableGatewayResponse.json()
  assert.equal(enableGatewayBody.gatewayEnabled, true)
  assert.equal(typeof enableGatewayBody.waitExpiresAt, 'number')
  assert.equal(await expectRejected(wsUrl), 401)

  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const timedOutStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(timedOutStatus.gatewayEnabled, false)
  assert.equal(await expectRejected(wsUrl), 503)
  const reopenResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(reopenResponse.status, 200)

  const disableAuthResponse = await fetch(`${base}/mgw/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(disableAuthResponse.status, 200)
  assert.equal((await disableAuthResponse.json()).requireAuth, false)
  const debugSocket = new WebSocket(wsUrl)
  const debugHelloPromise = waitForMessage(debugSocket, 'hello')
  await once(debugSocket, 'open')
  assert.equal((await debugHelloPromise).authenticated, false)
  const unauthenticatedSpeech = waitForMessage(debugSocket, 'error')
  debugSocket.send(JSON.stringify({ type: 'speech-catalog', requestId: 'unauthenticated-speech' }))
  assert.equal((await unauthenticatedSpeech).code, 'authentication-required')
  for (const type of ['workspace-changes-summary', 'workspace-changes-diff']) {
    const response = waitForMessage(debugSocket, 'error')
    debugSocket.send(JSON.stringify({ type, requestId: type, sessionId: 's1', seq: 12, index: 0 }))
    const frame = await response
    assert.equal(frame.code, 'authentication-required')
    assert.equal(frame.requestId, type)
  }

  const debugClosePromise = once(debugSocket, 'close')
  const enableAuthResponse = await fetch(`${base}/mgw/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enableAuthResponse.status, 200)
  const enableAuthBody = await enableAuthResponse.json()
  assert.equal(enableAuthBody.requireAuth, true)
  assert.equal(enableAuthBody.disconnected, 1)
  await debugClosePromise
  assert.equal(await expectRejected(wsUrl), 401)

  const crossOrigin = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ name: 'Blocked', publicUrl: wsUrl }),
  })
  assert.equal(crossOrigin.status, 403)

  const insecurePublic = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Blocked', publicUrl: 'ws://gateway.example.com/ws/mobile' }),
  })
  assert.equal(insecurePublic.status, 400)

  const pairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Integration iPhone', publicUrl: wsUrl }),
  })
  assert.equal(pairResponse.status, 201)
  const pairBody = await pairResponse.json()
  assert.equal(pairBody.payload.publicUrl, wsUrl)
  assert.equal(typeof pairBody.payload.pairingCode, 'string')
  assert.match(pairBody.qrPayload, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(
    JSON.parse(Buffer.from(pairBody.qrPayload, 'base64url').toString('utf8')),
    pairBody.payload,
  )
  assert.equal('token' in pairBody, false)

  assert.equal(
    await expectRejected(wsUrl, ['dsh-mobile-v1', `dsh-pair.${pairBody.payload.pairingCode}`]),
    400,
  )

  const pairedSocket = new WebSocket(
    wsUrl,
    ['dsh-mobile-v1', `dsh-pair.${pairBody.payload.pairingCode}`],
    { headers: { 'X-DSH-Device-ID': clientDeviceId } },
  )
  const pairedPromise = waitForMessage(pairedSocket, 'paired')
  const helloPromise = waitForMessage(pairedSocket, 'hello')
  await once(pairedSocket, 'open')
  const pairedFrame = await pairedPromise
  const hello = await helloPromise
  assert.equal(pairedSocket.protocol, 'dsh-mobile-v1')
  assert.equal(hello.authenticated, true)
  assert.equal(hello.protocol, 3)
  assert.deepEqual(hello.capabilities, [
    'split-channels',
    'assistant-stream-v1',
    'history-format-version',
    'projection-baseline',
    'images',
    'session-create',
    'session-agent-preset',
    'wechat-clawbot-control-v2',
    'commands',
    'tasks',
    'goals',
    'schedule-management',
    'plugin-management-v1',
    'speech-input-v1',
    'session-cancel',
    'queue-control',
    'session-archive',
    'session-rename',
    'file-downloads',
    'cost-meter-v1',
    'context-dashboard-v1',
    'context-fleet-v1',
    'context-insights-v1',
    'context-comms-v1',
    'context-content-v1',
  ])
  const speechCatalog = waitForMessage(pairedSocket, 'speech-catalog')
  pairedSocket.send(JSON.stringify({ type: 'speech-catalog', requestId: 'speech-info' }))
  assert.equal((await speechCatalog).available, true)
  const speechTranscript = waitForMessage(pairedSocket, 'speech-transcript')
  pairedSocket.send(JSON.stringify({ type: 'speech-transcribe', requestId: 'speech-record', audioBase64: 'AA==' }))
  assert.equal((await speechTranscript).text, '测试语音')
  const connectedStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(connectedStatus.gatewayEnabled, true)
  assert.equal(connectedStatus.waitExpiresAt, null)
  assert.equal(typeof pairedFrame.token, 'string')
  const pairedDeviceId = pairedFrame.device && pairedFrame.device.id
  assert.equal(typeof pairedDeviceId, 'string')
  assert.equal(await expectRejected(
    `${wsUrl}?pairingCode=${encodeURIComponent(pairBody.payload.pairingCode)}`,
    { headers: { 'X-DSH-Device-ID': clientDeviceId } },
  ), 401)

  const unavailableChanges = waitForMessage(pairedSocket, 'error')
  pairedSocket.send(JSON.stringify({ type: 'workspace-changes-summary', requestId: 'missing-service', sessionId: 's1', seq: 12 }))
  assert.equal((await unavailableChanges).code, 'workspace-changes-unavailable')
  attachWorkspaceChanges()
  for (const type of ['workspace-changes-summary', 'workspace-changes-diff']) {
    const response = waitForMessage(pairedSocket, type)
    pairedSocket.send(JSON.stringify({ type, requestId: type, sessionId: 's1', seq: 12, index: 0 }))
    const frame = await response
    assert.equal(frame.requestId, type)
    assert.deepEqual(frame.value, type === 'workspace-changes-summary' ? changeSummary : changeDiff)
  }
  snapshotPresent = false
  const expiredChanges = waitForMessage(pairedSocket, 'workspace-changes-summary')
  pairedSocket.send(JSON.stringify({ type: 'workspace-changes-summary', requestId: 'expired', sessionId: 's1', seq: 12 }))
  assert.equal((await expiredChanges).value, null)
  const tokenSocket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${pairedFrame.token}`, 'X-DSH-Channel': 'control' } })
  const tokenHelloPromise = waitForMessage(tokenSocket, 'hello')
  await once(tokenSocket, 'open')
  const tokenHello = await tokenHelloPromise
  assert.equal(tokenHello.authenticated, true)
  assert.ok(tokenHello.capabilities.includes('workspace-changes-v1'))
  disposeWorkspaceChanges()
  const removedChanges = waitForMessage(tokenSocket, 'error')
  tokenSocket.send(JSON.stringify({ type: 'workspace-changes-summary', requestId: 'removed-service', sessionId: 's1', seq: 12 }))
  assert.equal((await removedChanges).code, 'workspace-changes-unavailable')
  const controlSpeech = waitForMessage(tokenSocket, 'speech-transcript')
  tokenSocket.send(JSON.stringify({ type: 'speech-transcribe', requestId: 'control-speech', audioBase64: 'AA==' }))
  assert.equal((await controlSpeech).requestId, 'control-speech')
  const conversationSocket = new WebSocket(wsUrl, { headers: {
    Authorization: `Bearer ${pairedFrame.token}`, 'X-DSH-Channel': 'conversation',
  } })
  await once(conversationSocket, 'open')
  const wrongChannel = waitForMessage(conversationSocket, 'error')
  conversationSocket.send(JSON.stringify({ type: 'speech-catalog', requestId: 'wrong-speech-channel' }))
  assert.equal((await wrongChannel).code, 'wrong-channel')
  const conversationClosed = once(conversationSocket, 'close')
  conversationSocket.close()
  await conversationClosed

  const devicesResponse = await fetch(`${base}/mgw/devices`)
  const devicesBody = await devicesResponse.json()
  assert.equal(devicesBody.devices.length, 1)
  assert.equal(devicesBody.devices[0].online, true)
  assert.equal(devicesBody.devices[0].connections, 2)

  const rePairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Integration iPhone Renamed', publicUrl: wsUrl }),
  })
  assert.equal(rePairResponse.status, 201)
  const rePairBody = await rePairResponse.json()
  const rePairedSocket = new WebSocket(
    wsUrl,
    ['dsh-mobile-v1', `dsh-pair.${rePairBody.payload.pairingCode}`],
    { headers: { 'X-DSH-Device-ID': clientDeviceId, 'X-DSH-Device-Name': Buffer.from('Integration iPhone Renamed').toString('base64') } },
  )
  const rePairedPromise = waitForMessage(rePairedSocket, 'paired')
  await once(rePairedSocket, 'open')
  const rePairedFrame = await rePairedPromise
  assert.equal(rePairedFrame.device.id, pairedFrame.device.id)
  assert.notEqual(rePairedFrame.token, pairedFrame.token)
  const rePairedDevices = await (await fetch(`${base}/mgw/devices`)).json()
  assert.equal(rePairedDevices.devices.length, 1)
  assert.equal(rePairedDevices.devices[0].name, 'Integration iPhone Renamed')
  assert.equal(rePairedDevices.devices[0].connections, 3)
  assert.equal(await expectRejected(wsUrl, { headers: { Authorization: `Bearer ${pairedFrame.token}` } }), 401)

  const closePromise = once(tokenSocket, 'close')
  const revokeResponse = await fetch(`${base}/mgw/devices/${pairedFrame.device.id}/revoke`, {
    method: 'POST',
    headers: { Origin: base },
  })
  assert.equal(revokeResponse.status, 200)
  await closePromise
  assert.equal(await expectRejected(wsUrl, { headers: { Authorization: `Bearer ${pairedFrame.token}` } }), 401)
  assert.equal(await expectRejected(wsUrl, { headers: { Authorization: `Bearer ${rePairedFrame.token}` } }), 401)

  // ---- relay mode: the payload must not adopt the caller's address --------
  // The fnOS runbook tells operators to put a LAN address in the WebSocket
  // address field. Leaking that into the relay payload sends the mini-program
  // straight at an endpoint it cannot authenticate against, so the relay
  // payload always carries the configured public URL instead.
  const relayRegister = await fetch(`${base}/mgw/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      relay: 'wss://relay.example.com',
      nodeId: 'ecb2de50-7542-490b-af4f-aebfcb29c3c2',
      agentPubKey: Buffer.alloc(32, 7).toString('base64'),
      gatewayName: 'Relay Probe',
    }),
  })
  assert.equal(relayRegister.status, 200)
  assert.equal((await relayRegister.json()).relay.nodeId, 'ecb2de50-7542-490b-af4f-aebfcb29c3c2')

  const modeRelay = await fetch(`${base}/mgw/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ mode: 'relay' }),
  })
  assert.equal(modeRelay.status, 200)
  assert.equal((await modeRelay.json()).pairingMode, 'relay')

  const relayPair = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Relay Probe', publicUrl: 'ws://192.168.3.110:3081/ws/mobile' }),
  })
  assert.equal(relayPair.status, 201)
  const relayPayload = (await relayPair.json()).payload
  assert.equal(relayPayload.version, 3)
  assert.equal(relayPayload.mode, 'relay')
  assert.equal(relayPayload.relay, 'wss://relay.example.com')
  assert.equal(relayPayload.nodeId, 'ecb2de50-7542-490b-af4f-aebfcb29c3c2')
  assert.equal(relayPayload.gatewayUrl, 'wss://203.0.113.10/ws/mobile')
  assert.equal('endpoints' in relayPayload, false)
  assert.equal(relayPayload.pairingCode.length, 43)

  const modeDirect = await fetch(`${base}/mgw/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ mode: 'direct' }),
  })
  assert.equal(modeDirect.status, 200)
  const directPair = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Direct Probe', publicUrl: wsUrl }),
  })
  assert.equal(directPair.status, 201)
  const directPayload = (await directPair.json()).payload
  assert.equal(directPayload.version, 2)
  assert.equal(directPayload.publicUrl, wsUrl)
  assert.equal('mode' in directPayload, false)

  // ---- relabel a paired device (the relay connector renames its entry once
  //      the phone reports its own model) ----
  // Pair a fresh device: the earlier one in this test is revoked on purpose.
  const renamePairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ publicUrl: wsUrl }),
  })
  assert.equal(renamePairResponse.status, 201)
  const renameCode = (await renamePairResponse.json()).payload.pairingCode
  // Upstream protocol: the device name travels in the X-DSH-Device-Name
  // header (base64), not in the pairing body.
  const renameSocket = new WebSocket(
    wsUrl,
    ['dsh-mobile-v1', `dsh-pair.${renameCode}`],
    { headers: {
      'X-DSH-Device-ID': `${clientDeviceId}-rename`,
      'X-DSH-Device-Name': Buffer.from('Rename Probe').toString('base64'),
    } },
  )
  const renamePaired = await waitForMessage(renameSocket, 'paired')
  const renameDeviceId = renamePaired.device.id
  assert.equal(renamePaired.device.name, 'Rename Probe')

  const renameOk = await fetch(`${base}/mgw/devices/${encodeURIComponent(renameDeviceId)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Xiaomi 14 Ultra' }),
  })
  assert.equal(renameOk.status, 200)
  assert.equal((await renameOk.json()).device.name, 'Xiaomi 14 Ultra')

  const renameBlank = await fetch(`${base}/mgw/devices/${encodeURIComponent(renameDeviceId)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: '   ' }),
  })
  assert.equal(renameBlank.status, 404, 'a blank name is rejected, not silently applied')

  const renameMissing = await fetch(`${base}/mgw/devices/does-not-exist/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'x' }),
  })
  assert.equal(renameMissing.status, 404)

  const listAfterRename = await (await fetch(`${base}/mgw/devices`, { headers: { Origin: base } })).json()
  assert.equal(listAfterRename.devices.find((d) => d.id === renameDeviceId).name, 'Xiaomi 14 Ultra')
  renameSocket.close()

  const disableGatewayResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(disableGatewayResponse.status, 200)
  assert.equal((await disableGatewayResponse.json()).gatewayEnabled, false)
  assert.equal(await expectRejected(wsUrl), 503)

  pairedSocket.close()
  rePairedSocket.close()
  disposePlugin()
  server.close()
  await once(server, 'close')
  fs.rmSync(temp, { recursive: true })
  console.log('AUTH AND PAIRING TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
