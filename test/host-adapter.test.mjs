import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDshHostAdapter, readHistoryRecords } from '../lib/dsh-host-adapter.mjs'

const gatewaySource = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(gatewaySource, /apiProxy|api\.events\.mux|api\.respond\s*\(/)
assert.doesNotMatch(gatewaySource, /typertGateway\.invoke|typertGateway\.stream/)

const packed = {
  type: 'event',
  event: {
    type: 'assistant/message', seq: 5, time: 107,
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '你好' }] },
      stream: [{ type: 'text-chunks', time0: 100, index: 0, texts: ['你', '好'], dt: [7] }] },
  },
}
assert.deepEqual(readHistoryRecords([packed]), [packed.event])
assert.throws(() => readHistoryRecords([{ type: 'chunks', event: packed.event }]), /requires event records/)

const calls = []
const gateway = {
  async invoke(call) {
    calls.push(call)
    if (call.namespace === 'session' && call.method === 'page') {
      return { records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }], hasMore: false }
    }
    if (call.namespace === 'session' && call.method === 'modelCatalog') {
      return {
        default: { provider: 'deepseek', model: 'chat' },
        routableProviders: ['deepseek'],
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
        failures: [],
      }
    }
    if (call.namespace === 'session' && call.method === 'list') return { items: [{ sessionId: 's1' }] }
    if (call.namespace === 'session' && call.method === 'canOpenWorkspacePath') return true
    if (call.namespace === 'permissionPresets' && call.method === 'catalog') return {
      options: [{ value: 'ask', name: 'Ask' }], defaultOptions: [{ value: 'ask', name: 'Ask' }], defaultPreset: 'ask',
    }
    if (call.namespace === 'llm' && call.method === 'listConfigurableProviders') return [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'deepseek', settingsPath: [] }]
    if (call.namespace === 'llm' && call.method === 'discoverModels') return [{ id: 'draft-chat', name: 'Draft Chat' }]
    if (call.namespace === 'goals' && call.method === 'edit') return { id: 'goal-1', revision: 2 }
    if (call.namespace === 'goals' && call.method === 'clear') return { id: 'goal-1', revision: 3 }
    if (call.namespace === 'commands' && call.method === 'list') return []
    if (call.namespace === 'schedule' && (call.method === 'catalog' || call.method === 'list')) return []
    if (call.namespace === 'schedule') return { id: 'task-1', deleted: true }
    return { accepted: true }
  },
  async stream(call) {
    calls.push(call)
    if (call.namespace === 'workspace') {
      return (async function* () {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] } }
      })()
    }
    if (call.namespace === 'session' && call.method === 'follow') {
      return (async function* () {
        yield {
          type: 'snapshot',
          header: { version: 4, id: 's1' },
          cursor: 9,
          records: [packed],
          hasMore: true,
          projections: { asOfSeq: 9, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'chat' } } } },
        }
      })()
    }
    throw new Error(`unexpected stream ${call.namespace}/${call.method}`)
  },
}

const host = createDshHostAdapter(gateway)

// 官方实验性语音 Remote 使用各自的真实参数名，并传递取消信号。
{
  const signal = new AbortController().signal
  const request = { audioBase64: 'AA==', providerId: 'sensevoice-local', language: 'zh' }
  await host.speech.catalog(signal)
  // The adapter speaks as the Host itself: every request names one owner Peer
  // (DSH 0.2.1-alpha requires it; older hosts ignore the field).
  const hostPeer = calls[0].peer
  assert.ok(hostPeer, 'adapter must name a Peer on every request')
  assert.equal(hostPeer.principal.kind, 'owner')
  assert.equal(hostPeer.interactions, 'none')
  assert.equal(hostPeer.signal.aborted, false)
  assert.equal(typeof hostPeer.id, 'string')
  assert.equal(typeof hostPeer.dispose, 'function')
  assert.equal(calls.every((call) => call.peer === hostPeer), true, 'one Peer per adapter, shared by every call')
  await host.speech.transcribe(request, signal)
  await host.speech.prepare('sensevoice-local', { downloadSource: 'https://hf-mirror.com' }, signal)
  await host.speech.configure({ language: 'zh' }, signal)
  await host.speech.cancelPreparation('sensevoice-local', signal)
  assert.deepEqual(calls.filter(call => call.namespace === 'speech'), [
    { namespace: 'speech', method: 'catalog', args: {}, signal, peer: hostPeer },
    { namespace: 'speech', method: 'transcribe', args: { request }, signal, peer: hostPeer },
    { namespace: 'speech', method: 'prepare', args: { providerId: 'sensevoice-local', options: { downloadSource: 'https://hf-mirror.com' } }, signal, peer: hostPeer },
    { namespace: 'speech', method: 'configure', args: { patch: { language: 'zh' } }, signal, peer: hostPeer },
    { namespace: 'speech', method: 'cancelPreparation', args: { providerId: 'sensevoice-local' }, signal, peer: hostPeer },
  ])
}

await host.sessions.list()
const sessionListCall = calls.find((call) => call.namespace === 'session' && call.method === 'list')
assert.deepEqual(sessionListCall.args, { _request: {} })

const history = await host.sessions.history({ sessionId: 's1' })
assert.equal(history.events.length, 1)
assert.equal(history.events[0].event.seq, 5)
assert.equal(history.historyFormatVersion, 4)
assert.equal(history.cursor, 9)
assert.equal(history.projections.asOfSeq, 9)

const older = await host.sessions.history({ sessionId: 's1', beforeSeq: 5, maxMessages: 20 })
assert.equal(older.events[0].event.type, 'user/message')
assert.equal(calls.filter(call => call.namespace === 'session' && call.method === 'follow').at(-1).args.request.maxMessages, 1)
const pageCall = calls.find((call) => call.namespace === 'session' && call.method === 'page')
assert.deepEqual(pageCall.args, {
  request: {
    address: { kind: 'session', sessionId: 's1' },
    throughSeq: 9,
    beforeSeq: 5,
    maxMessages: 20,
  },
})

await host.sessions.history({ sessionId: 's1', throughSeq: 7, beforeSeq: 8, maxMessages: 1 })
const pinnedPageCall = calls.filter(call => call.namespace === 'session' && call.method === 'page').at(-1)
assert.equal(pinnedPageCall.args.request.throughSeq, 7, 'targeted context reads must stay pinned to the selected event')

await host.sessions.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
const promptCall = calls.find((call) => call.namespace === 'session' && call.method === 'prompt')
assert.equal(typeof promptCall.args.request.requestId, 'string')
assert.equal(promptCall.args.request.sessionId, 's1')

assert.deepEqual(await host.sessions.cancel({ sessionId: 's1' }), { accepted: true })
const cancelCall = calls.find((call) => call.namespace === 'session' && call.method === 'cancel')
assert.deepEqual(cancelCall.args, { request: { sessionId: 's1' } })

assert.deepEqual(await host.sessions.updateQueue({
  sessionId: 's1',
  itemId: 'message-1',
  action: { kind: 'edit', content: [{ type: 'text', text: '修改后' }] },
}), { accepted: true })
const updateQueueCall = calls.find((call) => call.namespace === 'session' && call.method === 'updateQueue')
assert.deepEqual(updateQueueCall.args, {
  request: {
    sessionId: 's1',
    itemId: 'message-1',
    action: { kind: 'edit', content: [{ type: 'text', text: '修改后' }] },
  },
})

assert.deepEqual(await host.sessions.rename({ sessionId: 's1', title: '新名称' }), { accepted: true })
const renameCall = calls.find((call) => call.namespace === 'session' && call.method === 'rename')
assert.deepEqual(renameCall.args, { request: { sessionId: 's1', title: '新名称' } })

assert.deepEqual(await host.workspace.archiveSession({ sessionId: 's1' }), { accepted: true })
const archiveCall = calls.find((call) => call.namespace === 'workspace' && call.method === 'archiveSession')
assert.deepEqual(archiveCall.args, { request: { sessionId: 's1' } })

const workspaceStreamAbort = new AbortController()
const workspaceStream = await host.openWorkspaceStream(workspaceStreamAbort.signal)
const workspaceOpening = await workspaceStream[Symbol.asyncIterator]().next()
assert.equal(workspaceOpening.value.type, 'baseline')
assert.ok(calls.some((call) => call.namespace === 'workspace' && call.method === 'follow' && call.signal === workspaceStreamAbort.signal))
workspaceStreamAbort.abort()

await host.settings.update({ ns: 'permission', patch: { defaultPreset: 'ask' } })
const settingsCall = calls.find((call) => call.namespace === 'settings' && call.method === 'update')
assert.deepEqual(settingsCall.args, { ns: 'permission', patch: { defaultPreset: 'ask' } })
assert.equal((await host.permissionPresets.catalog()).defaultPreset, 'ask')
assert.deepEqual(calls.find((call) => call.namespace === 'permissionPresets').args, {})

assert.deepEqual(await host.schedule.catalog(), { items: [] })
assert.deepEqual(await host.schedule.list({ sessionId: 's1' }), { items: [] })
assert.deepEqual(await host.schedule.delete({ sessionId: 's1', id: 'task-1' }), { id: 'task-1', deleted: true })
assert.deepEqual(calls.find((call) => call.namespace === 'schedule' && call.method === 'catalog').args, {})
assert.deepEqual(calls.find((call) => call.namespace === 'schedule' && call.method === 'list').args, { request: { sessionId: 's1' } })
assert.deepEqual(calls.find((call) => call.namespace === 'schedule' && call.method === 'delete').args, { request: { sessionId: 's1', id: 'task-1' } })

assert.deepEqual(
  await host.goals.edit({ sessionId: 's1', ref: { id: 'goal-1', revision: 1 }, objective: '完成重构' }),
  { ref: { id: 'goal-1', revision: 2 } },
)
const goalCall = calls.find((call) => call.namespace === 'goals' && call.method === 'edit')
assert.deepEqual(goalCall.args, {
  agentId: 's1',
  ref: { id: 'goal-1', revision: 1 },
  request: { objective: '完成重构' },
})

assert.deepEqual(await host.workspace.list(), { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] })
assert.deepEqual(await host.llm.providers(), {
  providers: [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'deepseek', settingsPath: [] }],
})

// Model discovery is one direct Remote call carrying the settings namespace and
// the draft request; the Host performs the interrogation and its result crosses
// back unfiltered (sanitisation belongs to the gateway handler).
{
  const signal = new AbortController().signal
  const request = { provider: 'pi-ai', baseURL: 'https://api.example.com/v1', api: 'openai', apiKey: 'sk-draft-only' }
  assert.deepEqual(await host.llm.discoverModels('llm-pi-ai', request, signal), [{ id: 'draft-chat', name: 'Draft Chat' }])
  const discoveryCall = calls.filter((call) => call.namespace === 'llm' && call.method === 'discoverModels').at(-1)
  assert.deepEqual(discoveryCall.args, { settingsNs: 'llm-pi-ai', request })
  assert.equal(discoveryCall.signal, signal)
  assert.equal(discoveryCall.peer.principal.kind, 'owner')
}

assert.equal('clawbot' in host, false, 'ClawBot runs in the gateway and must not delegate control to another plugin')

const sessionModels = await host.sessions.models({ sessionId: 's1' })
assert.deepEqual(sessionModels.current, { provider: 'deepseek', model: 'chat' })
assert.equal(sessionModels.routable, true)

await host.commands.execute('s1', '/plan-toggle', [{ type: 'image', mediaType: 'image/png', data: 'AA==' }])
const commandExecuteCall = calls.find((call) => call.namespace === 'commands' && call.method === 'execute')
assert.deepEqual(commandExecuteCall.args, {
  agentId: 's1',
  line: '/plan-toggle',
  submittedAttachments: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
})

console.log('DSH HOST ADAPTER TESTS PASSED')

const followAbort = new AbortController()
await host.openSessionStream('s1', followAbort.signal)
const followCall = calls.at(-1)
assert.equal(followCall.peer.principal.kind, 'owner')
assert.deepEqual({ ...followCall, peer: undefined }, { namespace: 'session', method: 'follow',
  args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 12, assistantStream: true } },
  signal: followAbort.signal, peer: undefined })
followAbort.abort()
const badHost = createDshHostAdapter({ invoke: async () => ({}), stream: async () => (async function* () {
  yield { type: 'snapshot', header: { id: 's1', version: 2 }, cursor: 0, records: [], projections: {} }
})() })
await assert.rejects(() => badHost.sessions.history({ sessionId: 's1' }), { code: 'unsupported-session-format' })

// Reading a snapshot must release its follow even with a caller-owned signal.
{
  const caller = new AbortController()
  let returned = false
  const snapshotHost = createDshHostAdapter({
    invoke: async () => ({}),
    stream: async call => ({
      [Symbol.asyncIterator]() { return this },
      async next() { return { done: false, value: { type: 'snapshot', header: { id: 's1', version: 4 },
        cursor: -1, records: [], projections: { asOfSeq: -1, values: {} } } } },
      async return() {
        assert.equal(call.signal.aborted, true)
        returned = true
        return { done: true }
      },
    }),
  })
  await snapshotHost.sessions.history({ sessionId: 's1' }, caller.signal)
  assert.equal(returned, true)
  assert.equal(caller.signal.aborted, false)
}

// ---------------------------------------------------------------------------
// DSH 0.2.1-alpha host shape. The installed runtime (0.2.1-alpha.4) made the
// Peer explicit for in-process Remote calls: TypertGatewayService.prepareInvocation
// runs assertPeerLive(request.peer) and methodSignal() joins request.peer.signal
// into every stream. A request without a peer therefore fails every call with
// "Cannot read properties of undefined (reading 'signal')" — which is exactly
// what the NAS logged for workspace/follow and session/control. This fake host
// reproduces those reads so a regression fails here instead of in production.
// ---------------------------------------------------------------------------
function createHost021Gateway() {
  const seen = []
  const assertPeer = (request, endpoint) => {
    if (!request.peer) throw new TypeError(`Cannot read properties of undefined (reading 'signal') at ${endpoint}`)
    if (request.peer.signal.aborted) throw new Error('gateway/peer-disposed')
    if (request.peer.principal.kind !== 'owner') throw new Error('remote-access/denied')
    seen.push(endpoint)
  }
  return {
    seen,
    async invoke(request) {
      assertPeer(request, `${request.namespace}/${request.method}`)
      if (request.namespace === 'session' && request.method === 'page') {
        return { records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }], hasMore: false }
      }
      if (request.namespace === 'session' && request.method === 'modelCatalog') {
        return {
          default: { provider: 'deepseek', model: 'chat' },
          routableProviders: ['deepseek'],
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
          failures: [],
        }
      }
      if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }] }
      return { accepted: true }
    },
    async stream(request) {
      assertPeer(request, `${request.namespace}/${request.method}`)
      // methodSignal() on 0.2.1 joins the Peer signal into stream methods.
      if (request.namespace === 'workspace') {
        return (async function* () {
          yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] } }
        })()
      }
      if (request.namespace === 'session' && request.method === 'follow') {
        return (async function* () {
          yield { type: 'snapshot', header: { version: 4, id: 's1' }, cursor: 9, records: [packed], hasMore: true,
            projections: { asOfSeq: 9, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'chat' } } } } }
        })()
      }
      if (request.namespace === 'session' && request.method === 'control') {
        return (async function* () {
          yield { type: 'baseline', value: { projections: { asOfSeq: 0, values: {} } } }
        })()
      }
      throw new Error(`unexpected stream ${request.namespace}/${request.method}`)
    },
  }
}

{
  const host021 = createDshHostAdapter(createHost021Gateway())
  // Every domain operation the NAS actually uses must survive the 0.2.1 reads.
  assert.deepEqual(await host021.sessions.list(), { items: [{ sessionId: 's1' }] })
  const history = await host021.sessions.history({ sessionId: 's1' })
  assert.equal(history.events.length, 1)
  assert.equal(history.cursor, 9)
  const workspace = await host021.workspace.list()
  assert.deepEqual(workspace.items, [{ workspaceId: 'w1' }])
  const snapshot = await host021.sessions.models({ sessionId: 's1' })
  assert.deepEqual(snapshot.current, { provider: 'deepseek', model: 'chat' })
  // The two background streams that retried every second on the NAS.
  for await (const frame of await host021.openWorkspaceStream(new AbortController().signal)) {
    assert.equal(frame.type, 'baseline')
  }
  const control = await host021.openControlStream(new AbortController().signal)
  assert.equal(typeof control[Symbol.asyncIterator], 'function')
  const sessionStream = await host021.openSessionStream('s1', new AbortController().signal)
  assert.equal(typeof sessionStream[Symbol.asyncIterator], 'function')
}

// A host that never receives a peer must keep failing: the guard stays honest.
{
  const noPeer = {
    async invoke(request) { if (!request.peer) throw new TypeError("Cannot read properties of undefined (reading 'signal')"); return {} },
    async stream(request) { if (!request.peer) throw new TypeError("Cannot read properties of undefined (reading 'signal')"); return (async function* () { yield {} })() },
  }
  // Prove the failure mode is what production hit, by calling the raw service.
  await assert.rejects(() => noPeer.invoke({ namespace: 'session', method: 'list', args: {} }),
    /Cannot read properties of undefined \(reading 'signal'\)/)
}

// dispose() ends the Peer: streams opened afterwards must not outlive the plugin.
{
  const host021 = createDshHostAdapter(createHost021Gateway())
  await host021.sessions.list()
  host021.dispose()
  await assert.rejects(() => host021.sessions.list(), /peer-disposed/)
}
