import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleQuery, setLogFile } from '../lib/index.mjs'
import { handleModelConfigQuery } from '../lib/model-config.mjs'

// This test drives handleQuery directly and never boots the plugin, so it must
// redirect the log itself instead of appending to the operator's shared file.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-config-'))
const logFile = path.join(logDir, 'gateway.log')
setLogFile(logFile)

const SECRET_KEY = 'sk-discovery-test-0123456789'
const SECRET_VALUE = 'sk-written-test-0123456789'

const calls = []
let discovered = []
let discoveryError = null
let settingsError = null
let describeError = null
let setError = null
let credentialView = { configured: true, writable: true, source: 'credentials-file' }
const baseSettings = () => ({
  writable: true,
  namespaces: [
    { ns: 'bash-sandbox', revision: 1, value: {} },
    { ns: 'llm-pi-ai', revision: 3, value: { providers: {
      'pi-ai': { apiKeyEnv: 'PI_AI_API_KEY', api: 'openai', baseURL: 'https://api.example.com/v1' },
      blank: { api: 'openai', baseURL: 'https://blank.example.com/v1' },
      broken: null,
    } } },
  ],
})
let settings = baseSettings()

const api = {
  llm: {
    async discoverModels(ns, request) {
      calls.push({ kind: 'discoverModels', ns, request })
      if (discoveryError) throw discoveryError
      return discovered
    },
  },
  settings: {
    async describe() {
      calls.push({ kind: 'settings.describe' })
      if (settingsError) throw settingsError
      return settings
    },
  },
  pluginConfiguration: {
    async credentialDescribe(ref) {
      calls.push({ kind: 'credentialDescribe', ref })
      if (describeError) throw describeError
      return { [ref]: credentialView }
    },
    async credentialSet(ref, value) {
      calls.push({ kind: 'credentialSet', ref, value })
      if (setError) throw setError
    },
  },
}

const query = (msg, target = api) => handleQuery(target, target, null, msg)
const logText = () => {
  try { return fs.readFileSync(logFile, 'utf8') } catch { return '' }
}
const assertNoSecrets = frame => {
  const wire = JSON.stringify(frame)
  assert.equal(wire.includes(SECRET_KEY), false, 'response must not echo the apiKey')
  assert.equal(wire.includes(SECRET_VALUE), false, 'response must not echo a credential value')
}
const reset = () => {
  calls.length = 0
  discoveryError = null
  settingsError = null
  describeError = null
  setError = null
  discovered = []
  settings = baseSettings()
  credentialView = { configured: true, writable: true, source: 'credentials-file' }
}

// --- llm-discover-models ----------------------------------------------------

reset()
discovered = [
  { id: 'pi-ai/chat', name: 'Pi Chat', contextWindow: 128000, maxTokens: 16384,
    inputModalities: ['text', 'image', 'text'], vendor: 'third-party' },
  // duplicate id after trimming
  { id: '  pi-ai/chat  ', name: 'Duplicate' },
  { id: '', name: 'Empty' },
  { name: 'No id' },
  { id: 'text-only', contextWindow: -1, maxTokens: Number.NaN, inputModalities: ['text', 'audio'] },
  null,
  'not-an-object',
]
const discoveredFrame = await query({ type: 'llm-discover-models', requestId: 'discover-1',
  ns: 'llm-pi-ai', provider: 'pi-ai' })
assert.equal(discoveredFrame.kind, 'llm-discover-models')
assert.equal(discoveredFrame.requestId, 'discover-1')
assert.deepEqual(discoveredFrame.models, [
  { id: 'pi-ai/chat', name: 'Pi Chat', contextWindow: 128000, maxTokens: 16384,
    inputModalities: ['text', 'image'] },
  { id: 'text-only', inputModalities: ['text'] },
])
assert.deepEqual(calls.at(-1), { kind: 'discoverModels', ns: 'llm-pi-ai', request: { provider: 'pi-ai' } })
assertNoSecrets(discoveredFrame)

// baseURL / api / one-shot apiKey are forwarded verbatim; the apiKey never
// appears in the response or the gateway log.
reset()
discovered = [{ id: 'm1' }]
const forwardFrame = await query({ type: 'llm-discover-models', requestId: 'discover-2',
  ns: ' custom-ns ', baseURL: 'https://endpoint.example.com/v1', api: 'openai-chat', apiKey: SECRET_KEY })
assert.equal(forwardFrame.kind, 'llm-discover-models')
assert.deepEqual(forwardFrame.models, [{ id: 'm1' }])
assert.deepEqual(calls.at(-1), { kind: 'discoverModels', ns: 'custom-ns',
  request: { baseURL: 'https://endpoint.example.com/v1', api: 'openai-chat', apiKey: SECRET_KEY } })
assertNoSecrets(forwardFrame)
assert.equal(logText().includes(SECRET_KEY), false, 'gateway log must never contain the apiKey')
assert.equal(logText().includes('endpoint.example.com'), false, 'gateway log must not record the endpoint')

// An empty apiKey counts as absent rather than an empty header value.
reset()
await query({ type: 'llm-discover-models', requestId: 'discover-3', ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: '' })
assert.deepEqual(calls.at(-1).request, { provider: 'pi-ai' })

// Host failures become llm-discovery-failed: redacted, truncated, no secret.
reset()
discoveryError = new Error(`upstream refused key ${SECRET_KEY} ` + 'x'.repeat(2000))
const failedFrame = await query({ type: 'llm-discover-models', requestId: 'discover-4',
  ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: SECRET_KEY })
assert.equal(failedFrame.kind, 'error')
assert.equal(failedFrame.code, 'llm-discovery-failed')
assert.equal(failedFrame.requestType, 'llm-discover-models')
assert.equal(failedFrame.requestId, 'discover-4')
assert.ok(failedFrame.message.length <= 500, 'host error messages are truncated to 500 characters')
assert.equal(failedFrame.message.includes(SECRET_KEY), false)
assert.ok(failedFrame.message.includes('[redacted]'))
assertNoSecrets(failedFrame)
assert.equal(logText().includes(SECRET_KEY), false, 'failure logs must not contain the apiKey')

// A host without discovery support fails cleanly.
reset()
const unsupported = await query({ type: 'llm-discover-models', requestId: 'discover-5',
  ns: 'llm-pi-ai', provider: 'pi-ai' }, { settings: api.settings, pluginConfiguration: api.pluginConfiguration })
assert.equal(unsupported.code, 'llm-discovery-failed')

// A malformed host result yields an empty model list, never a crash.
reset()
discovered = { not: 'an array' }
const malformed = await query({ type: 'llm-discover-models', requestId: 'discover-6',
  ns: 'llm-pi-ai', provider: 'pi-ai' })
assert.deepEqual(malformed.models, [])

// Validation failures never reach the Host.
reset()
const badDiscovery = [
  { ns: 'llm-pi-ai', provider: 'pi-ai' }, // missing requestId
  { requestId: 'd1', provider: 'pi-ai' }, // missing ns
  { requestId: 'd2', ns: '   ', provider: 'pi-ai' },
  { requestId: 'd3', ns: 'x'.repeat(201), provider: 'pi-ai' },
  { requestId: 'd4', ns: 42, provider: 'pi-ai' },
  { requestId: 'd5', ns: 'llm-pi-ai' }, // neither provider nor baseURL
  { requestId: 'd6', ns: 'llm-pi-ai', provider: '   ' },
  { requestId: 'd7', ns: 'llm-pi-ai', provider: 'x'.repeat(201) },
  { requestId: 'd8', ns: 'llm-pi-ai', baseURL: 'https://' },
  { requestId: 'd9', ns: 'llm-pi-ai', baseURL: 'endpoint.example.com/v1' },
  { requestId: 'd10', ns: 'llm-pi-ai', baseURL: 'ftp://endpoint.example.com/v1' },
  { requestId: 'd11', ns: 'llm-pi-ai', baseURL: `https://endpoint.example.com/${'x'.repeat(2048)}` },
  { requestId: 'd12', ns: 'llm-pi-ai', baseURL: 42 },
  { requestId: 'd13', ns: 'llm-pi-ai', provider: 'pi-ai', api: '' },
  { requestId: 'd14', ns: 'llm-pi-ai', provider: 'pi-ai', api: 'x'.repeat(81) },
  { requestId: 'd15', ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: 'key\nwith-newline' },
  { requestId: 'd16', ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: 'k'.repeat(8193) },
  { requestId: 'd17', ns: 'llm-pi-ai', provider: 'pi-ai', apiKey: 42 },
  { requestId: 'x'.repeat(129), ns: 'llm-pi-ai', provider: 'pi-ai' },
]
for (const message of badDiscovery) {
  const frame = await query({ type: 'llm-discover-models', ...message })
  assert.equal(frame.kind, 'error', JSON.stringify(message))
  assert.equal(frame.code, 'bad-request', JSON.stringify(message))
  assert.equal(frame.requestType, 'llm-discover-models')
  assertNoSecrets(frame)
}
assert.equal(calls.length, 0, 'validation failures must not call the Host')

// --- model-credential-describe ---------------------------------------------

reset()
const describedFrame = await query({ type: 'model-credential-describe', requestId: 'describe-1', ref: 'PI_AI_API_KEY' })
assert.deepEqual(describedFrame, {
  kind: 'model-credential-describe', requestId: 'describe-1',
  configured: true, writable: true, source: 'credentials-file',
})
assert.deepEqual(calls.map(call => call.kind), ['settings.describe', 'credentialDescribe'])
assert.equal(calls[1].ref, 'PI_AI_API_KEY')
assertNoSecrets(describedFrame)

// Credential writability comes from the credentials store, not the settings
// document's own writable bit (the value is stored in the credentials store).
reset()
settings = { ...baseSettings(), writable: false }
const readOnlySettings = await query({ type: 'model-credential-describe', requestId: 'describe-2', ref: 'PI_AI_API_KEY' })
assert.equal(readOnlySettings.configured, true)
assert.equal(readOnlySettings.writable, true)
reset()
credentialView = { configured: true, writable: false }
const readOnlyCredential = await query({ type: 'model-credential-describe', requestId: 'describe-2b', ref: 'PI_AI_API_KEY' })
assert.equal(readOnlyCredential.writable, false)

// An unconfigured reference keeps configured:false and carries no value.
reset()
credentialView = { configured: false, writable: true }
const missing = await query({ type: 'model-credential-describe', requestId: 'describe-3', ref: 'PI_AI_API_KEY' })
assert.equal(missing.configured, false)
assert.equal('source' in missing, false)
assertNoSecrets(missing)

// profiles may be an array (older profile shapes) instead of a route dict.
reset()
settings = { writable: true, namespaces: [{ ns: 'llm-pi-ai', value: {
  providers: [{ apiKeyEnv: 'ARRAY_API_KEY' }],
} }] }
const arrayScoped = await query({ type: 'model-credential-describe', requestId: 'describe-4', ref: 'ARRAY_API_KEY' })
assert.equal(arrayScoped.kind, 'model-credential-describe')

// Invalid and undeclared references are bad-request before any credential read.
reset()
for (const ref of ['1abc', 'a-b', 'a b', 'a'.repeat(257), '', undefined, 42]) {
  const frame = await query({ type: 'model-credential-describe', requestId: 'describe-bad', ref })
  assert.equal(frame.code, 'bad-request', JSON.stringify(ref))
  assert.equal(frame.requestType, 'model-credential-describe')
}
assert.equal(calls.length, 0)
const undeclared = await query({ type: 'model-credential-describe', requestId: 'describe-5', ref: 'SOME_OTHER_KEY' })
assert.equal(undeclared.code, 'bad-request')
assert.equal(calls.some(call => call.kind === 'credentialDescribe'), false)
// Missing llm-pi-ai namespace / provider list also rejects.
settings = { writable: true, namespaces: [{ ns: 'other', value: {} }] }
assert.equal((await query({ type: 'model-credential-describe', requestId: 'describe-6', ref: 'PI_AI_API_KEY' })).code, 'bad-request')

// Host failures surface their code, truncated, without leaking the reference value.
reset()
settingsError = new Error('settings store exploded')
const settingsFailed = await query({ type: 'model-credential-describe', requestId: 'describe-7', ref: 'PI_AI_API_KEY' })
assert.equal(settingsFailed.code, 'model-credentials-unavailable')
reset()
describeError = Object.assign(new Error('credential describe failed'), { code: 'credentials/unavailable' })
const describeFailed = await query({ type: 'model-credential-describe', requestId: 'describe-8', ref: 'PI_AI_API_KEY' })
assert.equal(describeFailed.code, 'credentials/unavailable')
assert.equal(describeFailed.requestId, 'describe-8')

// --- model-credential-set ---------------------------------------------------

reset()
const savedFrame = await query({ type: 'model-credential-set', requestId: 'set-1',
  ref: 'PI_AI_API_KEY', value: SECRET_VALUE })
assert.deepEqual(savedFrame, { kind: 'model-credential-set', requestId: 'set-1', saved: true })
assert.deepEqual(calls.map(call => call.kind), ['settings.describe', 'credentialSet'])
assert.deepEqual({ ref: calls[1].ref, value: calls[1].value }, { ref: 'PI_AI_API_KEY', value: SECRET_VALUE })
assertNoSecrets(savedFrame)
assert.equal(logText().includes(SECRET_VALUE), false, 'gateway log must never contain a credential value')

// Boundaries: the longest acceptable value still saves.
reset()
assert.equal((await query({ type: 'model-credential-set', requestId: 'set-2',
  ref: 'PI_AI_API_KEY', value: 'a'.repeat(8192) })).saved, true)

// Invalid values never reach the Host.
reset()
const badValues = [undefined, '', '   ', 'key with space', 'sk-秘密', 'line\nbreak', 'x'.repeat(8193), 42, null]
for (const value of badValues) {
  const frame = await query({ type: 'model-credential-set', requestId: 'set-bad', ref: 'PI_AI_API_KEY', value })
  assert.equal(frame.code, 'bad-request', JSON.stringify(value))
  assert.equal(frame.requestType, 'model-credential-set')
  assertNoSecrets(frame)
}
assert.equal(calls.length, 0)
// Undeclared or malformed references are rejected before any write.
for (const ref of ['SOME_OTHER_KEY', '1abc', 'a'.repeat(257)]) {
  const frame = await query({ type: 'model-credential-set', requestId: 'set-bad-ref', ref, value: SECRET_VALUE })
  assert.equal(frame.code, 'bad-request', JSON.stringify(ref))
}
assert.equal(calls.some(call => call.kind === 'credentialSet'), false)
// Missing requestId.
reset()
const noId = await query({ type: 'model-credential-set', ref: 'PI_AI_API_KEY', value: SECRET_VALUE })
assert.equal(noId.code, 'bad-request')
assert.equal(noId.requestId, undefined)
assert.equal(calls.length, 0)

// Write failures are mapped to model-credential-write-failed and redacted.
reset()
setError = new Error(`credential store rejected ${SECRET_VALUE}`)
const writeFailed = await query({ type: 'model-credential-set', requestId: 'set-3',
  ref: 'PI_AI_API_KEY', value: SECRET_VALUE })
assert.equal(writeFailed.code, 'model-credential-write-failed')
assert.equal(writeFailed.requestType, 'model-credential-set')
assert.equal(writeFailed.requestId, 'set-3')
assert.equal(writeFailed.message.includes(SECRET_VALUE), false)
assert.ok(writeFailed.message.includes('[redacted]'))
assertNoSecrets(writeFailed)
assert.equal(logText().includes(SECRET_VALUE), false)

// Unknown types belong to other handlers.
assert.equal(await handleModelConfigQuery(api, { type: 'models' }), null)

console.log('model config tests passed')
