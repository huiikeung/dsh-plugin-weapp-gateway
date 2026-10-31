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
const { createTestConnection } = await import('./helpers/peer.mjs')

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

// The server finishes its own close bookkeeping slightly after the client's
// close event, so device counts are awaited by polling rather than assumed.
async function waitForDeviceConnections(base, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await (await fetch(`${base}/mgw/devices`)).json()
    const device = body.devices[0]
    if (device && device.connections === expected) return device
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`device connections did not become ${expected}`)
}

function expectRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`timed out waiting for WebSocket rejection from ${url}`))
    }, 5000)
    ws.once('open', () => { clearTimeout(timer); reject(new Error('expected WebSocket rejection')) })
    ws.once('unexpected-response', (_request, response) => { clearTimeout(timer); resolve(response.statusCode) })
    ws.once('error', (error) => { clearTimeout(timer); reject(error) })
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600)
  // Live connections carry the entry point they arrived on so the
  // trusted-device list can badge 局域网 / 公网 / Cloudflare 外网 in real time.
  registry.connected(claimed.device.id)
  assert.equal(registry.list()[0].online, true)
  assert.deepEqual(registry.list()[0].routes, ['public'])
  registry.disconnected(claimed.device.id)
  assert.equal(registry.list()[0].online, false)
  assert.deepEqual(registry.list()[0].routes, [])
  registry.connected(claimed.device.id, 'lan')
  registry.connected(claimed.device.id, 'cloudflare')
  registry.connected(claimed.device.id, 'cloudflare')
  assert.equal(registry.list()[0].online, true)
  assert.equal(registry.list()[0].connections, 3)
  assert.deepEqual(registry.list()[0].routes, ['lan', 'cloudflare'])
  registry.disconnected(claimed.device.id, 'lan')
  assert.deepEqual(registry.list()[0].routes, ['cloudflare'])
  assert.equal(registry.list()[0].online, true)
  registry.disconnected(claimed.device.id, 'cloudflare')
  registry.disconnected(claimed.device.id, 'cloudflare')
  assert.equal(registry.list()[0].online, false)
  assert.deepEqual(registry.list()[0].routes, [])
  // An unknown or missing route normalizes to the main listener.
  registry.connected(claimed.device.id, 'not-a-route')
  assert.deepEqual(registry.list()[0].routes, ['public'])
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
    connection: createTestConnection(),
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
        if (request.namespace === 'llm' && request.method === 'discoverModels') {
          assert.equal(request.args.settingsNs, 'llm-pi-ai')
          assert.equal(request.args.request.provider, 'pi-ai')
          assert.equal(request.args.request.apiKey, 'sk-paired-test')
          return [{ id: 'pi-ai/chat', name: 'Pi Chat', vendor: 'dropped-by-gateway' }]
        }
        if (request.namespace === 'settings' && request.method === 'describe') {
          return { writable: true, hasDocument: true, namespaces: [
            { ns: 'llm-pi-ai', revision: 1, value: { providers: { 'pi-ai': { apiKeyEnv: 'PI_AI_API_KEY' } } } },
          ] }
        }
        if (request.namespace === 'credentials' && request.method === 'describe') {
          return { [request.args.refs[0]]: { configured: false, writable: true } }
        }
        if (request.namespace === 'credentials' && request.method === 'set') {
          assert.equal(request.args.ref, 'PI_AI_API_KEY')
          assert.equal(request.args.value, 'sk-paired-value')
          return undefined
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
  const unauthenticatedForget = waitForMessage(debugSocket, 'error')
  debugSocket.send(JSON.stringify({ type: 'device-forget', requestId: 'unauthenticated-forget' }))
  const forgetDenied = await unauthenticatedForget
  assert.equal(forgetDenied.code, 'authentication-required')
  assert.equal(forgetDenied.requestId, 'unauthenticated-forget')
  for (const type of ['workspace-changes-summary', 'workspace-changes-diff']) {
    const response = waitForMessage(debugSocket, 'error')
    debugSocket.send(JSON.stringify({ type, requestId: type, sessionId: 's1', seq: 12, index: 0 }))
    const frame = await response
    assert.equal(frame.code, 'authentication-required')
    assert.equal(frame.requestId, type)
  }
  // Model configuration is paired-device-only, exactly like plugin management:
  // an anonymous connection cannot discover models or touch credentials.
  for (const type of ['llm-discover-models', 'model-credential-describe', 'model-credential-set']) {
    const response = waitForMessage(debugSocket, 'error')
    debugSocket.send(JSON.stringify({ type, requestId: type, ns: 'llm-pi-ai', provider: 'pi-ai',
      ref: 'PI_AI_API_KEY', value: 'sk-denied' }))
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

  assert.equal(await expectRejected(wsUrl, { headers: { 'X-Forwarded-Proto': 'https' } }), 401,
    'public TLS ingress accepts native App clients and applies device authentication')
  assert.equal(await expectRejected(wsUrl, { headers: {
    'X-Forwarded-Proto': 'https', 'X-DSH-Client-Type': 'wechat-miniprogram',
  } }), 401, 'mini-program marker passes the public-route gate and reaches device authentication')

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
    'session-resume-v1',
    'history-format-version',
    'projection-baseline',
    'turn-outline-v1',
    'images',
    'session-create',
    'session-agent-preset',
    'agent-team-v1',
    'subagent-conversations-v1',
    'wechat-clawbot-control-v2',
    'commands',
    'tasks',
    'goals',
    'schedule-management',
    'plugin-management-v1',
    'llm-model-config-v1',
    'speech-input-v1',
    'session-cancel',
    'queue-control',
    'session-archive',
    'session-rename',
    'file-downloads',
    'file-references-v1',
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

  // Paired model configuration crosses the real WebSocket dispatch: discovery
  // sanitises Host fields, credentials are described/written, and the one-shot
  // apiKey or written value never comes back.
  const discovery = waitForMessage(pairedSocket, 'llm-discover-models')
  pairedSocket.send(JSON.stringify({ type: 'llm-discover-models', requestId: 'discover-paired',
    ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: 'sk-paired-test' }))
  const discoveryFrame = await discovery
  assert.equal(discoveryFrame.requestId, 'discover-paired')
  assert.deepEqual(discoveryFrame.models, [{ id: 'pi-ai/chat', name: 'Pi Chat' }])
  assert.equal(JSON.stringify(discoveryFrame).includes('sk-paired-test'), false)
  const credentialDescription = waitForMessage(pairedSocket, 'model-credential-describe')
  pairedSocket.send(JSON.stringify({ type: 'model-credential-describe', requestId: 'credential-paired',
    ref: 'PI_AI_API_KEY' }))
  assert.deepEqual(await credentialDescription, { kind: 'model-credential-describe',
    requestId: 'credential-paired', configured: false, writable: true })
  const credentialWrite = waitForMessage(pairedSocket, 'model-credential-set')
  pairedSocket.send(JSON.stringify({ type: 'model-credential-set', requestId: 'credential-write',
    ref: 'PI_AI_API_KEY', value: 'sk-paired-value' }))
  assert.deepEqual(await credentialWrite, { kind: 'model-credential-set',
    requestId: 'credential-write', saved: true })
  const missingRequestId = waitForMessage(pairedSocket, 'error')
  pairedSocket.send(JSON.stringify({ type: 'llm-discover-models', ns: 'llm-pi-ai', provider: 'pi-ai' }))
  assert.equal((await missingRequestId).code, 'bad-request')
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
  const wrongChannelModel = waitForMessage(conversationSocket, 'error')
  conversationSocket.send(JSON.stringify({ type: 'llm-discover-models', requestId: 'conversation-discover',
    ns: 'llm-pi-ai', provider: 'pi-ai' }))
  assert.equal((await wrongChannelModel).code, 'wrong-channel')
  const conversationClosed = once(conversationSocket, 'close')
  conversationSocket.close()
  await conversationClosed

  // The client's close event resolves before the server finishes its own
  // close bookkeeping, so poll instead of snapshotting one response.
  const settledDevice = await waitForDeviceConnections(base, 2)
  assert.equal(settledDevice.online, true)
  // Both channels arrived on the main listener, so the row badges 公网.
  assert.deepEqual(settledDevice.routes, ['public'])

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
  const rePairedDevice = await waitForDeviceConnections(base, 3)
  assert.equal(rePairedDevice.name, 'Integration iPhone Renamed')
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

  const selfPairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Self-removing phone', publicUrl: wsUrl }),
  })
  const selfPair = await selfPairResponse.json()
  assert.equal(selfPairResponse.status, 201)
  const selfDeviceId = '8f22f2b1-b4c0-42bd-bd91-b145f8b375b5'
  const selfSocket = new WebSocket(wsUrl, ['dsh-mobile-v1', `dsh-pair.${selfPair.payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': selfDeviceId },
  })
  const selfPairedPromise = waitForMessage(selfSocket, 'paired')
  await once(selfSocket, 'open')
  const selfPaired = await selfPairedPromise
  const forgottenPromise = waitForMessage(selfSocket, 'device-forgotten')
  const selfClosedPromise = once(selfSocket, 'close')
  selfSocket.send(JSON.stringify({ type: 'device-forget', requestId: 'forget-self-1' }))
  assert.equal((await forgottenPromise).requestId, 'forget-self-1')
  await selfClosedPromise
  const afterSelfForget = await (await fetch(`${base}/mgw/devices`)).json()
  assert.equal(afterSelfForget.devices.some((device) => device.id === selfPaired.device.id), false,
    'self-forget removes the authenticated device from the registry')
  assert.equal(await expectRejected(wsUrl, { headers: { Authorization: `Bearer ${selfPaired.token}` } }), 401)

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
    body: JSON.stringify({ name: 'Relay Probe', route: 'relay', publicUrl: 'ws://192.168.3.110:3081/ws/mobile' }),
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

  const autoWhileLegacyRelay = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      route: 'auto',
      publicUrl: 'wss://203.0.113.10/ws/mobile',
      appUrl: 'ws://192.168.1.20:3081/ws/mobile',
    }),
  })
  assert.equal(autoWhileLegacyRelay.status, 201)
  assert.equal((await autoWhileLegacyRelay.json()).payload.version, 2,
    'auto client-aware pairing works even if an older installation persisted relay mode')

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
  assert.deepEqual(directPayload.routes.lan,
    directPayload.endpoints.filter(endpoint => !endpoint.startsWith('wss://')),
    'the legacy direct QR advertises its LAN routes for auto network selection')
  assert.deepEqual(directPayload.routes.public,
    directPayload.endpoints.filter(endpoint => endpoint.startsWith('wss://')),
    'only verified public WSS endpoints join the public family')
  assert.equal(directPayload.routes.relay.nodeId, 'ecb2de50-7542-490b-af4f-aebfcb29c3c2',
    'a registered relay stays available as the off-LAN fallback in direct mode')
  assert.equal(directPayload.routes.relay.authMode, 'gateway')

  // Both clients receive the same ordered public and LAN candidates; the
  // mini-program also keeps its explicit route for older native App decoders.
  const autoPair = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      route: 'auto',
      publicUrl: 'wss://203.0.113.10/ws/mobile',
      lanUrl: 'ws://192.168.1.20:3081/ws/mobile',
    }),
  })
  assert.equal(autoPair.status, 201)
  const autoPayload = (await autoPair.json()).payload
  assert.equal(autoPayload.version, 2, 'existing native apps keep decoding the QR as v2')
  assert.equal(autoPayload.publicUrl, 'wss://203.0.113.10/ws/mobile')
  assert.equal(autoPayload.endpoints[0], 'wss://203.0.113.10/ws/mobile')
  assert.ok(autoPayload.endpoints.includes('ws://192.168.1.20:3081/ws/mobile'))
  assert.equal(autoPayload.miniProgramRoute.mode, 'direct')
  assert.equal(autoPayload.miniProgramRoute.publicUrl, 'wss://203.0.113.10/ws/mobile')
  assert.deepEqual(autoPayload.miniProgramRoute.endpoints, autoPayload.endpoints,
    'the mini-program gets the same public and LAN fallback candidates')
  assert.equal(JSON.stringify({ publicUrl: autoPayload.publicUrl, endpoints: autoPayload.endpoints }).includes('203.0.113.10'), true,
    'the native App receives the public endpoint as a candidate')
  assert.deepEqual(autoPayload.routes.public, ['wss://203.0.113.10/ws/mobile'],
    'the route table classifies the verified public WSS endpoint')
  assert.ok(autoPayload.routes.lan.includes('ws://192.168.1.20:3081/ws/mobile'),
    'the route table keeps LAN candidates for same-network connections')
  assert.equal(autoPayload.routes.relay.relay, 'wss://relay.example.com',
    'the route table also exposes the registered relay to capable clients')

  const configuredPublicUrlText = fs.readFileSync(publicUrlFile, 'utf8')
  fs.writeFileSync(publicUrlFile, '# temporarily test relay fallback without a public WSS route\n')
  const relayAutoPair = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ route: 'auto', publicUrl: 'ws://192.168.1.20:3081/ws/mobile', appUrl: 'ws://192.168.1.20:3081/ws/mobile' }),
  })
  assert.equal(relayAutoPair.status, 201)
  const relayAutoPayload = (await relayAutoPair.json()).payload
  assert.equal(relayAutoPayload.publicUrl, 'ws://192.168.1.20:3081/ws/mobile')
  assert.equal(relayAutoPayload.miniProgramRoute.mode, 'relay', 'auto falls back to the registered relay for the mini-program')
  assert.equal(relayAutoPayload.miniProgramRoute.relay, 'wss://relay.example.com')
  assert.equal('pairingCode' in relayAutoPayload.miniProgramRoute, false, 'the one-time code is shared only at the envelope level')
  assert.deepEqual(relayAutoPayload.routes.public, [],
    'without a verified public WSS endpoint the route table has no public family')
  assert.deepEqual(relayAutoPayload.routes.lan, ['ws://192.168.1.20:3081/ws/mobile'])
  assert.equal(relayAutoPayload.routes.relay.nodeId, 'ecb2de50-7542-490b-af4f-aebfcb29c3c2',
    'auto pairing still advertises the relay so the phone can connect off-LAN')
  fs.writeFileSync(publicUrlFile, configuredPublicUrlText)

  const unsafeAppEndpoint = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ route: 'auto', publicUrl: 'wss://203.0.113.10/ws/mobile', lanUrl: 'wss://203.0.113.10/ws/mobile' }),
  })
  assert.equal(unsafeAppEndpoint.status, 409, 'the LAN candidate must not be populated with a public endpoint')

  const unreadyCloudflare = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ route: 'cloudflare', publicUrl: 'wss://203.0.113.10/ws/mobile', lanUrl: 'ws://192.168.1.20:3081/ws/mobile' }),
  })
  assert.equal(unreadyCloudflare.status, 409, 'explicit Cloudflare routing requires a verified reachable tunnel')

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
