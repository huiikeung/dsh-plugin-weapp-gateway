import assert from 'node:assert/strict'
import {
  CONTEXT_REQUEST_TYPES,
  applyContextEvent,
  buildCommsValue,
  buildFleetValue,
  contextProjectionDefinition,
  contextView,
  createState,
  handleContextComms,
  handleContextContent,
  handleContextFleet,
  handleContextInsights,
  handleContextQuery,
  registerContextProjection,
  registerContextServices,
} from '../lib/context-bridge.mjs'

// --- request types -----------------------------------------------------------

assert.deepEqual([...CONTEXT_REQUEST_TYPES].sort(), ['context-comms', 'context-content', 'context-dashboard', 'context-fleet', 'context-insights'])

// --- empty fold state --------------------------------------------------------

const emptyView = contextView(createState())
assert.deepEqual(emptyView, {
  v: 1,
  commandStats: { bg: 0, failed: 0, ms: 0, runs: 0 },
  commands: [],
  current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
  counts: { humanInputs: 0, answers: 0, toolCalls: 0, skillLoads: 0, injects: 0, compactions: 0, prunes: 0 },
  activity: { userInputs: 0, reads: 0, writes: 0, searches: 0, images: 0 },
  tools: { count: 0, names: [], total: 0 },
  timing: {
    wallMs: 0, ttftMs: 0, reasoningMs: 0, textMs: 0, toolArgMs: 0, toolsMs: 0, otherMs: 0,
    waitCount: 0, reasoningCount: 0, textCount: 0, toolArgCount: 0, toolCount: 0,
    speedTokens: 0, speedMs: 0,
  },
  spans: [],
  surface: [],
  archive: [],
  headerEpochs: [],
  fileOps: [],
  requests: [],
  events: [],
  truncated: { requests: false, events: false, surface: false },
})

// --- events that cannot change the served value keep the same state ----------

const untouched = createState()
assert.equal(applyContextEvent(untouched, null), untouched)
assert.equal(applyContextEvent(untouched, { type: 'not/a/known/event', seq: 1 }), untouched)
assert.equal(applyContextEvent(untouched, { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'x' }] } }), untouched)
assert.equal(applyContextEvent(untouched, { type: 'tool/call', seq: 1, data: { callId: '', name: 'x' } }), untouched)

// --- surface: append, token estimate, replacement by seq range --------------

let state = createState()
state = applyContextEvent(state, { type: 'user/message', seq: 10, time: 100, surfaceOp: { op: 'append' }, data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
let view = contextView(state)
assert.equal(view.current.user, 10) // ceil(5/4) + 4 block + 4 role
assert.equal(view.current.total, 10)
assert.equal(view.counts.humanInputs, 1)

state = applyContextEvent(state, { type: 'user/message', seq: 11, time: 101, surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 }, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
view = contextView(state)
assert.equal(view.current.user, 9) // ceil(2/4) + 4 block + 4 role
assert.equal(view.counts.humanInputs, 2)
assert.equal(view.requests.length, 0)

// --- injections and skills ---------------------------------------------------

state = applyContextEvent(state, { type: 'developer/message', seq: 20, time: 110, surfaceOp: {}, data: { message: { role: 'developer', content: [{ type: 'text', text: 'rules' }] } } })
view = contextView(state)
assert.equal(view.current.inject, 10) // ceil(5/4) + 4 block + 4 role
assert.equal(view.counts.injects, 1)
assert.deepEqual(view.events.at(-1), { seq: 20, time: 110, kind: 'inject', form: 'context' })

state = applyContextEvent(state, { type: 'user/message', seq: 21, time: 111, surfaceOp: {}, data: { role: 'user', source: { kind: 'skill-invocation', name: 'debug' }, content: [{ type: 'text', text: 'skill content' }] } })
view = contextView(state)
assert.ok(view.current.skill > 0)
assert.equal(view.counts.skillLoads, 1)
assert.equal(view.events.at(-1).kind, 'inject')
assert.equal(view.events.at(-1).sub, 'skill')
assert.equal(view.events.at(-1).name, 'debug')

// --- assistant messages record the assembled request ------------------------

state = applyContextEvent(state, { type: 'assistant/message', seq: 30, time: 120, surfaceOp: {}, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } })
view = contextView(state)
assert.equal(view.requests.length, 1)
assert.equal(view.requests[0].seq, 30)
assert.equal(view.requests[0].turn, 1)
assert.equal(view.requests[0].step, 0)
assert.equal(view.requests[0].total, view.current.total - view.current.assistant)
assert.ok(view.current.assistant > 0)
assert.equal(view.counts.answers, 1)

// --- tool calls pair with results -------------------------------------------

state = applyContextEvent(state, { type: 'tool/call', seq: 40, time: 130, data: { callId: 'call-1', name: 'read_file' } })
state = applyContextEvent(state, { type: 'tool/result', seq: 41, time: 131, surfaceOp: {}, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] } } })
view = contextView(state)
assert.equal(view.counts.toolCalls, 1)
assert.equal(view.current.tool, 9) // ceil(2/4) + 4 block + 4 role
assert.deepEqual(view.tools.names, [{ name: 'read_file', count: 1 }])

let fileState = createState()
fileState = applyContextEvent(fileState, {
  type: 'tool/call', seq: 70, time: 200,
  data: { callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/app.js', old_string: 'old', new_string: 'one\ntwo\n' }) },
})
fileState = applyContextEvent(fileState, {
  type: 'tool/result', seq: 71, time: 240, surfaceOp: { op: 'append' },
  data: { message: { role: 'tool', source: { callId: 'edit-1' }, content: [{ type: 'text', text: 'updated' }] } },
})
assert.deepEqual(contextView(fileState).fileOps, [{
  seq: 71, time: 240, path: 'src/app.js', kind: 'write', tool: 'edit', err: false, added: 2, removed: 1,
}])
fileState = applyContextEvent(fileState, {
  type: 'user/message', seq: 72, time: 250, surfaceOp: { op: 'replace', startSeq: 71, endSeq: 71 },
  data: { content: [{ type: 'text', text: 'compacted' }] },
})
assert.equal(contextView(fileState).fileOps[0].gone, 72)

// A skill tool's result moves from the tool bucket into the skill bucket.
let skillState = createState()
skillState = applyContextEvent(skillState, { type: 'tool/call', seq: 50, time: 140, data: { callId: 'call-2', name: 'skill' } })
skillState = applyContextEvent(skillState, { type: 'tool/result', seq: 51, time: 141, surfaceOp: {}, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'text', text: '<skill_content name="review">' }] } } })
const skillView = contextView(skillState)
assert.equal(skillView.current.tool, 0)
assert.ok(skillView.current.skill > 0)
assert.equal(skillView.counts.skillLoads, 1)
assert.equal(skillView.events.at(-1).name, 'review')
assert.equal(skillView.events.at(-1).sub, 'skill')

// --- compaction events -------------------------------------------------------

state = createState()
state = applyContextEvent(state, { type: 'compaction/summary', seq: 60, time: 150, data: { shadowedTokenCount: 120, shadowedSeqs: [1, 2, 3] } })
view = contextView(state)
assert.equal(view.counts.compactions, 1)
assert.deepEqual(view.events.at(-1), { seq: 60, time: 150, kind: 'compaction', tokens: 120, count: 3 })
state = applyContextEvent(state, { type: 'compaction/prune', seq: 61, time: 151, data: { shadowedTokenCount: 40 } })
view = contextView(state)
assert.equal(view.counts.prunes, 1)
assert.deepEqual(view.events.at(-1), { seq: 61, time: 151, kind: 'prune', tokens: 40 })

// --- step timing excludes approval waits ------------------------------------

state = createState()
state = applyContextEvent(state, { type: 'step/start', seq: 70, time: 1000 })
state = applyContextEvent(state, { type: 'approval/asked', seq: 71, time: 1100, data: { id: 'a1' } })
assert.equal(state.approvals.a1, 1100)
state = applyContextEvent(state, { type: 'approval/decided', seq: 72, time: 1200, data: { id: 'a1' } })
assert.equal(state.approvals.a1, undefined)
assert.equal(contextView(state).timing.wallMs, 0)
state = applyContextEvent(state, { type: 'step/end', seq: 73, time: 2000 })
assert.equal(contextView(state).timing.wallMs, 900) // 1000ms step - 100ms wait
assert.equal(state.stepStart, undefined)
assert.equal(state.approvals, undefined)

assert.equal(applyContextEvent(createState(), { type: 'approval/asked', seq: 1, time: 5, data: { id: 'a2' } }).approvals, undefined)
const noStep = createState()
assert.equal(applyContextEvent(noStep, { type: 'step/end', seq: 1, time: 5 }), noStep)

// --- per-request activeMs feeds the trend's duration curve ------------------

state = createState()
state = applyContextEvent(state, { type: 'step/start', seq: 90, time: 1000 })
state = applyContextEvent(state, {
  type: 'assistant/message',
  seq: 91,
  time: 1450,
  data: { turn: 1, step: 1, usage: { outputTokens: 12 } },
})
let activeView = contextView(state)
assert.equal(activeView.requests.length, 1)
assert.equal(activeView.requests[0].activeMs, 450, 'the open step spans to this response')

// A log that starts mid-step has no boundary to measure, so the field is
// omitted rather than faking a duration.
state = createState()
state = applyContextEvent(state, {
  type: 'assistant/message',
  seq: 92,
  time: 2000,
  data: { turn: 1, step: 1 },
})
activeView = contextView(state)
assert.equal(activeView.requests.length, 1)
assert.equal(activeView.requests[0].activeMs, undefined)

// --- request header tools and context window --------------------------------

state = createState()
state = applyContextEvent(state, { type: 'request/header', seq: 80, data: { header: { config: { model: 'deepseek-chat', provider: 'deepseek' }, tools: [{ name: 'read_file' }] } } })
view = contextView(state)
assert.equal(view.model, 'deepseek-chat')
assert.equal(view.provider, 'deepseek')
assert.ok(view.current.tools > 0)
state = applyContextEvent(state, { type: 'request/context', seq: 81, data: { contextWindow: 128000, model: 'deepseek-v4' } })
view = contextView(state)
assert.equal(view.contextWindow, 128000)
assert.equal(view.model, 'deepseek-v4')

// --- projection definition ---------------------------------------------------

assert.equal(contextProjectionDefinition.key, 'mobileContext')
// v5 adds each request's own `activeMs` for the trend's duration curve; v6 adds
// the command ledger. The version must never decrease, or a host would restore a
// checkpoint folded by different code.
assert.equal(contextProjectionDefinition.stateVersion, 6)
const projectionInit = contextProjectionDefinition.init()
assert.deepEqual(contextProjectionDefinition.wire.view(projectionInit), contextView(projectionInit))
assert.equal(contextProjectionDefinition.apply(projectionInit, { type: 'unknown' }), projectionInit)

// --- fleet builder -----------------------------------------------------------

const fleetRecords = [
  { id: 'root', createdAt: 1 },
  { id: 'child-b', parentSessionId: 'root', origin: 'subagent', createdAt: 3 },
  { id: 'child-a', parentSessionId: 'root', origin: 'subagent', createdAt: 2 },
  { id: 'fork', parentSessionId: 'root', origin: 'fork', createdAt: 4 },
]
const fleetSnapshots = {
  'child-a': {
    subagent: { mode: 'one-shot', label: '分析' },
    contextPressure: { contextWindow: 128000, pressureTokens: 900 },
    tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1, outputTokens: 4 },
    sessionStats: { turns: 2, steps: 3 },
    mobileContext: {
      model: 'deepseek-chat',
      provider: 'deepseek',
      current: { system: 10, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5 },
      timing: { wallMs: 500 },
    },
  },
}
const fleet = buildFleetValue('child-a', fleetRecords, (id) => fleetSnapshots[id] ?? null, (id) => id === 'child-b')

// The task board carries the host `description` (the instructions shown under
// each subject); it must reach the client, bounded.
const teamFleet = buildFleetValue('root', fleetRecords, (id) => (id === 'root'
  ? { agentTeam: {
      members: [],
      tasks: [
        { id: 't1', subject: 'Extract dsh-mobile session spec', description: 'Read the iOS app source at /tmp/dsh-mobile. Focus ONLY on the session/conversation page.', status: 'completed' },
        { id: 't2', subject: 'Short', description: 'ok', status: 'pending' },
        { id: 't3', subject: 'No description', status: 'pending' },
        { id: 't4', subject: 'Truncated', description: 'x'.repeat(900), status: 'pending' },
      ],
      failure: '',
    } }
  : null), () => false)
assert.equal(teamFleet.team.tasks.length, 4)
assert.deepEqual(teamFleet.team.tasks.map(task => [task.id, task.subject, task.description, task.status]), [
  ['t1', 'Extract dsh-mobile session spec', 'Read the iOS app source at /tmp/dsh-mobile. Focus ONLY on the session/conversation page.', 'completed'],
  ['t2', 'Short', 'ok', 'pending'],
  ['t3', 'No description', undefined, 'pending'],
  ['t4', 'Truncated', 'x'.repeat(400), 'pending'],
], 'descriptions ride through, capped, and stay optional')
assert.equal(fleet.rootSessionId, 'root')
assert.equal(fleet.currentSessionId, 'child-a')
assert.deepEqual(fleet.agents.map(agent => [agent.sessionId, agent.depth, agent.isCurrent, agent.isRoot, agent.running]), [
  ['root', 0, false, true, false],
  ['child-a', 1, true, false, false],
  ['child-b', 1, false, false, true],
])
assert.equal(fleet.agents.some(agent => agent.sessionId === 'fork'), false)
assert.equal(fleet.counts.agents, 3)
assert.equal(fleet.counts.running, 1)
assert.equal(fleet.counts.subagents, 2)
const childA = fleet.agents.find(agent => agent.sessionId === 'child-a')
assert.equal(childA.mode, 'one-shot')
assert.equal(childA.label, '分析')
assert.equal(childA.model, 'deepseek-chat')
assert.equal(childA.provider, 'deepseek')
assert.equal(childA.contextWindow, 128000)
assert.equal(childA.pressureTokens, 900)
assert.equal(childA.tokensTotal, 20)
assert.equal(childA.turns, 2)
assert.equal(childA.steps, 3)
assert.equal(childA.activeMs, 500)
assert.deepEqual(childA.composition, { system: 10, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 24 })

const taskNamesFleet = buildFleetValue('root', [
  { id: 'root' },
  { id: 'catalog-child', parentSessionId: 'root', origin: 'subagent', title: 'Catalog task' },
  { id: 'labeled-child', parentSessionId: 'root', origin: 'subagent', title: 'Catalog fallback' },
], (id) => id === 'catalog-child'
  ? { title: 'Generic conversation title' }
  : id === 'labeled-child'
    ? { title: 'Another generic title', subagent: { label: 'Actual task name' } }
    : null, () => false)
assert.equal(taskNamesFleet.agents.find(agent => agent.sessionId === 'catalog-child').title, 'Catalog task')
assert.equal(taskNamesFleet.agents.find(agent => agent.sessionId === 'labeled-child').title, 'Actual task name')

const nativeProjectionFleet = buildFleetValue('native-child', [
  { id: 'native-root' },
  { id: 'native-child', parentSessionId: 'native-root', origin: 'subagent' },
], (id) => id === 'native-child' ? {
  contextTimeline: {
    contextWindow: 128000,
    current: { system: 1, user: 2, total: 600 },
    last: { prompt: 700, total: 550 },
    counts: { steps: 8 },
    cost: { provider: { model: {
      peak: { uncached: 1000, cacheRead: 200, cacheWrite: 100, output: 500 },
      off: { uncached: 1200, cacheRead: 300, cacheWrite: 100, output: 400 },
    } } },
  },
  subagentTiming: { lastTurnCompleted: false, settledMs: 4000 },
} : null, () => false)
const nativeChild = nativeProjectionFleet.agents.find(agent => agent.sessionId === 'native-child')
assert.equal(nativeChild.pressureTokens, 750, 'falls back to DSH headline anchor plus current movement')
assert.equal(nativeChild.tokensTotal, 3800, 'uses DSH billing ledger, not context occupancy')
assert.equal(nativeChild.contextTokens, 600)
assert.equal(nativeChild.steps, 8)
assert.equal(nativeChild.activeMs, 4000)
assert.equal(nativeChild.completed, undefined, 'a stopped subagent without a normal-completion signal stays incomplete')

// A fork is not a subagent edge, but the current fork must still render after
// its ancestor chain.
const forkFleet = buildFleetValue('fork', fleetRecords, () => null, () => false)
assert.deepEqual(forkFleet.agents.map(agent => [agent.sessionId, agent.depth, agent.isCurrent]), [
  ['root', 0, false],
  ['child-a', 1, false],
  ['child-b', 1, false],
  ['fork', 1, true],
])
assert.equal(forkFleet.counts.subagents, 2)

// The family is bounded; a wider tree must not grow past MAX_FLEET_AGENTS.
const wideRecords = [{ id: 'root', createdAt: 1 }]
for (let index = 0; index < 45; index += 1) {
  wideRecords.push({ id: `c${index}`, parentSessionId: 'root', origin: 'subagent', createdAt: 10 + index })
}
const wideFleet = buildFleetValue('root', wideRecords, () => null, () => false)
assert.equal(wideFleet.agents.length, 40)
assert.equal(wideFleet.agents[0].sessionId, 'root')
assert.equal(wideFleet.agents[39].sessionId, 'c38')

// A damaged parent chain terminates instead of looping forever.
const cyclicFleet = buildFleetValue('a', [
  { id: 'a', parentSessionId: 'b', createdAt: 1 },
  { id: 'b', parentSessionId: 'a', createdAt: 2 },
], () => null, () => false)
assert.equal(cyclicFleet.agents.length, 2)
assert.equal(cyclicFleet.agents.some(agent => agent.sessionId === 'a'), true)

// Unknown current session with no records yields an empty family.
assert.deepEqual(buildFleetValue('missing', [], () => null, () => false), {
  rootSessionId: '',
  currentSessionId: 'missing',
  agents: [],
  counts: { agents: 0, running: 0, subagents: 0 },
})

// --- context-dashboard query -------------------------------------------------

assert.deepEqual(
  await handleContextQuery(null, { type: 'context-dashboard' }),
  { kind: 'error', code: 'bad-request', requestType: 'context-dashboard', message: 'context-dashboard requires a sessionId' },
)
assert.deepEqual(
  await handleContextQuery(null, { type: 'context-dashboard', sessionId: 's1' }),
  { kind: 'error', code: 'context-unavailable', requestType: 'context-dashboard', sessionId: 's1', message: 'Session history is unavailable on this host' },
)

const historyCalls = []
const historyApi = {
  sessions: {
    async history(request) {
      historyCalls.push(request)
      return {
        kind: 'history',
        projections: {
          asOfSeq: 42,
          values: {
            mobileContext: { v: 1, current: { total: 7 } },
            contextBreakdown: { total: 7 },
            tokenUsage: { totals: {} },
            sessionStats: { turns: 1 },
          },
        },
      }
    },
  },
}

// The real host adapter returns the raw session/follow snapshot with no `kind`
// (only proxyQuery adds one). Accept that shape too — live 0.8.16 regression.
const snapshotApi = {
  sessions: {
    async history() {
      return {
        cursor: 42,
        events: [],
        hasMore: false,
        projections: historyApi.sessions.history ? {
          asOfSeq: 42,
          values: {
            mobileContext: { v: 1, current: { total: 7 } },
            contextBreakdown: { total: 7 },
            tokenUsage: { totals: {} },
            sessionStats: { turns: 1 },
          },
        } : undefined,
      }
    },
  },
}
const snapshotDashboard = await handleContextQuery(snapshotApi, { type: 'context-dashboard', sessionId: 's1' })
assert.equal(snapshotDashboard.kind, 'context-dashboard')
assert.equal(snapshotDashboard.asOfSeq, 42)
assert.equal(snapshotDashboard.value.v, 1)

const dashboard = await handleContextQuery(historyApi, { type: 'context-dashboard', sessionId: ' s1 ' })
assert.equal(dashboard.kind, 'context-dashboard')
assert.equal(dashboard.sessionId, 's1')
assert.equal(dashboard.asOfSeq, 42)
assert.deepEqual(dashboard.value, {
  v: 1,
  current: { total: 7 },
  breakdown: { total: 7 },
  usage: { totals: {} },
  stats: { turns: 1 },
})
assert.deepEqual(historyCalls, [{ sessionId: 's1', maxMessages: 1 }])

const historyErrorApi = { sessions: { async history() { return { kind: 'error', code: 'history-unavailable', message: 'no history' } } } }
assert.deepEqual(
  await handleContextQuery(historyErrorApi, { type: 'context-dashboard', sessionId: 's1' }),
  { kind: 'error', code: 'history-unavailable', message: 'no history', requestType: 'context-dashboard', sessionId: 's1' },
)

const emptyProjectionApi = { sessions: { async history() { return { kind: 'history', projections: { asOfSeq: 5, values: {} } } } } }
assert.deepEqual(
  await handleContextQuery(emptyProjectionApi, { type: 'context-dashboard', sessionId: 's1' }),
  { kind: 'error', code: 'context-unavailable', requestType: 'context-dashboard', sessionId: 's1', message: 'The context projection is not registered on this host' },
)

const throwingHistoryApi = { sessions: { async history() { throw new Error('boom') } } }
assert.equal(
  (await handleContextQuery(throwingHistoryApi, { type: 'context-dashboard', sessionId: 's1' })).code,
  'context-unavailable',
)

const detailCalls = []
const detailFrame = await handleContextContent({ sessions: { async history(request) {
  detailCalls.push(request)
  return { events: [
    { event: { type: 'user/message', seq: 18, time: 1234, data: { content: [{ type: 'text', text: 'the actual prompt' }] } } },
    { event: { type: 'assistant/message', seq: 19, time: 1235, data: { message: { content: [{ type: 'text', text: 'not the selected event' }] } } } },
  ] }
} } }, { type: 'context-content', sessionId: 's1', seq: 18 })
assert.deepEqual(detailCalls, [{ sessionId: 's1', throughSeq: 18, beforeSeq: 19, maxMessages: 1 }])
assert.deepEqual(detailFrame, {
  kind: 'context-content', sessionId: 's1', seq: 18,
  value: { seq: 18, time: 1234, type: 'user/message', text: 'the actual prompt' },
})
assert.equal((await handleContextContent(null, { type: 'context-content', sessionId: 's1' })).code, 'bad-request')

const boundedFrame = await handleContextContent({ sessions: { async history() {
  return { events: [{ seq: 21, type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(25000) }] } }] }
} } }, { type: 'context-content', sessionId: 's1', seq: 21 })
assert.equal(boundedFrame.value.text.length, 24000)
assert.equal(boundedFrame.value.truncated, true)

const boundedSchema = await handleContextContent({ sessions: { async history() {
  return { events: [{ seq: 22, type: 'request/header', data: { header: { tools: [{
    name: 'tool', parameters: 'x'.repeat(6000),
  }] } } }] }
} } }, { type: 'context-content', sessionId: 's1', seq: 22 })
const schemaText = boundedSchema.value.text.split('Schema: ')[1]
assert.equal(schemaText.length, 5000)
assert.equal(schemaText.includes('x'.repeat(5000)), false)
assert.equal(boundedSchema.value.truncated, true)

// --- context-fleet query -----------------------------------------------------

assert.deepEqual(
  await handleContextFleet({ type: 'context-fleet' }),
  { kind: 'error', code: 'bad-request', requestType: 'context-fleet', message: 'context-fleet requires a sessionId' },
)
assert.deepEqual(
  await handleContextFleet({ type: 'context-fleet', sessionId: 's1' }),
  { kind: 'error', code: 'context-unavailable', requestType: 'context-fleet', sessionId: 's1', message: 'Session services are unavailable on this host' },
)

const injectCalls = []
let sessionsSubscriber
let agentsSubscriber
let sessionQuerySubscriber
const serviceCtx = {
  inject(names, callback) {
    injectCalls.push([...names])
    if (names[0] === 'sessions') sessionsSubscriber = callback
    else if (names[0] === 'sessionQuery') sessionQuerySubscriber = callback
    else if (names[0] === 'agents') agentsSubscriber = callback
  },
}
assert.equal(registerContextServices(serviceCtx), true)
assert.deepEqual(injectCalls, [['sessions', 'sessionProjections'], ['sessionQuery'], ['agents'], ['skills'], ['agentPresets']])
assert.equal(typeof sessionsSubscriber, 'function')
assert.equal(typeof sessionQuerySubscriber, 'function')
assert.equal(typeof agentsSubscriber, 'function')

const hostSessions = [
  { id: 'root', header: { createdAt: 1 }, title: 'Root' },
  { id: 'child', header: { parentSession: 'root', origin: 'subagent', createdAt: 2 } },
]
const effects = []
const hostProjections = {
  snapshot(session) {
    if (session.id === 'root') return { values: {
      contextTimeline: {
        current: { system: 10, user: 20, total: 30 },
        counts: { steps: 7 },
        timing: { wallMs: 5000 },
        last: { prompt: 100, total: 120 },
      },
      contextPressure: { projectedTokens: 110, contextWindow: 200000 },
      subagentCatalog: [
        { id: 'child', label: 'Warm child', createdAt: 2 },
        { id: 'cold-child', label: 'Cold child', createdAt: 3 },
      ],
    } }
    if (session.id === 'child') return { values: {
      subagent: { mode: 'continuable' },
      contextTimeline: { current: { user: 3, total: 3 }, counts: { steps: 2 } },
      tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1, outputTokens: 4 },
    } }
    return { values: {} }
  },
}
const coldValues = {
  contextTimeline: { current: { assistant: 12, total: 12 }, counts: { steps: 4 }, timing: { wallMs: 9000 } },
  contextPressure: { pressureTokens: 15, contextWindow: 100000 },
  subagent: { mode: 'one-shot', label: 'Cold child' },
}
sessionsSubscriber({
  sessions: { list: () => hostSessions, get: () => null },
  sessionProjections: hostProjections,
  effect: (fn) => { effects.push(fn()) },
})
sessionQuerySubscriber({
  sessionQuery: {
    async observeSession(id) {
      if (id !== 'cold-child') return null
      return {
        header: { id, parentSession: 'root', origin: 'subagent', createdAt: 3 },
        projections: { values: coldValues },
        [Symbol.dispose]() {},
      }
    },
  },
  effect: (fn) => { effects.push(fn()) },
})
const fleetFrame = await handleContextFleet({ type: 'context-fleet', sessionId: 'child' })
assert.equal(fleetFrame.kind, 'context-fleet')
assert.equal(fleetFrame.sessionId, 'child')
assert.equal(fleetFrame.value.rootSessionId, 'root')
assert.deepEqual(fleetFrame.value.agents.map(agent => agent.sessionId), ['root', 'child', 'cold-child'])
assert.deepEqual(fleetFrame.value.agents.map(agent => agent.title), ['Root', 'Warm child', 'Cold child'],
  'catalog labels repair already-listed sessions and remain visible as task titles')
assert.equal(fleetFrame.value.agents[1].mode, 'continuable')
assert.deepEqual(fleetFrame.value.agents[1].composition, { system: 0, tools: 0, user: 3, inject: 0, skill: 0, assistant: 0, tool: 0, total: 3 })
assert.equal(fleetFrame.value.counts.agents, 3)
assert.equal(fleetFrame.value.counts.subagents, 2)
assert.equal(fleetFrame.value.agents[0].pressureTokens, 110, 'headline context comes from DSH pressure projection')
assert.equal(fleetFrame.value.agents[0].tokensTotal, undefined, 'context headline is not billed usage')
assert.equal(fleetFrame.value.agents[0].steps, 7)
assert.equal(fleetFrame.value.agents[2].pressureTokens, 15, 'cold Agent uses its DSH projection snapshot')
assert.equal(fleetFrame.value.agents[2].steps, 4)
assert.equal(fleetFrame.value.agents[2].tokensTotal, undefined, 'missing billing data stays missing')
assert.equal(effects.length, 2)

// A non-array session listing degrades to an empty family.
sessionsSubscriber({
  sessions: { list: () => null },
  sessionProjections: hostProjections,
  effect: (fn) => { fn() },
})
const emptyFleet = await handleContextFleet({ type: 'context-fleet', sessionId: 'root' })
assert.deepEqual(emptyFleet.value.agents, [])

// A throwing service is reported as unavailable, never as a raw exception.
sessionsSubscriber({
  sessions: { list() { throw new Error('boom') } },
  sessionProjections: hostProjections,
  effect: (fn) => { fn() },
})
assert.equal(
  (await handleContextFleet({ type: 'context-fleet', sessionId: 'root' })).code,
  'context-unavailable',
)


// --- context-insights query --------------------------------------------------

assert.equal((await handleContextInsights({ type: 'context-insights' })).code, 'context-unavailable')

const insightsSessions = [
  { id: 'ins-a', header: { createdAt: 1000 }, title: '会话 A' },
  { id: 'ins-b', header: { createdAt: 2000 } },
]
const insightsProjections = {
  snapshot(session) {
    if (session.id === 'ins-a') {
      return { values: {
        title: '会话 A',
        mobileContext: {
          model: 'deepseek-v4', provider: 'deepseek', contextWindow: 200000,
          current: { system: 10, tools: 20, user: 30, inject: 0, skill: 0, assistant: 5, tool: 15 },
          counts: { toolCalls: 7 }, timing: { wallMs: 90000 },
        },
        contextPressure: { pressureTokens: 80, contextWindow: 200000 },
        sessionStats: { turns: 4, steps: 9 },
        costMeter: {
          lastTime: 1700000000000,
          total: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 },
          days: { '2026-10-20': { input: 40, output: 10, cacheRead: 60, cacheWrite: 0 }, '2026-10-21': { input: 60, output: 40, cacheRead: 140, cacheWrite: 10 } },
        },
      } }
    }
    return { values: { costMeter: { lastTime: 1690000000000, total: { input: 5, output: 5 }, days: {} } } }
  },
}
sessionsSubscriber({
  sessions: { list: () => insightsSessions },
  sessionProjections: insightsProjections,
  effect: (fn) => { fn() },
})
const insightsFrame = await handleContextInsights({ type: 'context-insights' })
assert.equal(insightsFrame.kind, 'context-insights')
assert.equal(insightsFrame.value.v, 1)
assert.equal(insightsFrame.value.sessions.length, 2)
const [first, second] = insightsFrame.value.sessions
assert.equal(first.id, 'ins-a')
assert.equal(first.title, '会话 A')
assert.equal(first.model, 'deepseek-v4')
assert.equal(first.billedTokens, 360)
assert.equal(first.inputTokens, 310)
assert.equal(first.cacheReadTokens, 200)
assert.equal(first.turns, 4)
assert.equal(first.steps, 9)
assert.equal(first.toolCalls, 7)
assert.equal(first.activeMs, 90000)
assert.equal(first.pressureTokens, 80)
assert.equal(first.composition.user, 30)
assert.equal(second.id, 'ins-b')
assert.equal(second.billedTokens, 10, 'legacy costMeter remains the usage fallback')
assert.equal(second.lastActive, 1690000000000, 'legacy ledger retains its activity timestamp')
assert.equal(insightsFrame.value.days.length, 2)
assert.equal(insightsFrame.value.days[0].day, '2026-10-20')
assert.equal(insightsFrame.value.days[0].tokens, 110)

// A broken listing degrades to context-unavailable.
sessionsSubscriber({
  sessions: { list() { throw new Error('boom') } },
  sessionProjections: insightsProjections,
  effect: (fn) => { fn() },
})
assert.equal((await handleContextInsights({ type: 'context-insights' })).code, 'context-unavailable')

// --- registration ------------------------------------------------------------

assert.equal(registerContextProjection(null), false)
assert.equal(registerContextProjection({}), false)
assert.equal(registerContextServices(null), false)

const projectionRegistrations = []
let projectionSubscriber
const projectionCtx = {
  inject(names, callback) {
    projectionSubscriber = callback
  },
}
assert.equal(registerContextProjection(projectionCtx), true)
projectionSubscriber({
  sessionProjections: { register: (definition) => projectionRegistrations.push(definition) },
  effect: (fn) => { fn() },
})
assert.deepEqual(projectionRegistrations, [contextProjectionDefinition])

console.log('context bridge tests passed')

// 子 Agent 会话必须带 durable parent address + 匹配 mode 才可读：
// 不传地址时宿主拒绝，扫描结果只剩父会话（通讯记录永远为空）。
{
  const calls = []
  const api = {
    sessions: {
      history: async (payload) => {
        calls.push(payload)
        const isChild = payload.sessionId.startsWith('child')
        if (isChild && (payload.parentSessionId !== 'parent' || payload.mode === undefined)) {
          throw new Error('subagent Sessions require their durable parent address')
        }
        const text = isChild ? 'completed the task' : ''
        return {
          title: payload.sessionId,
          events: text === '' ? [] : [{
            type: 'user/message',
            seq: 1,
            time: 1000,
            data: { source: { kind: 'subagent-settled', summary: text, senderSessionId: payload.sessionId }, content: [{ type: 'text', text }] },
          }],
        }
      },
    },
  }
  const withoutAddress = await handleContextComms(api, { type: 'context-comms', sessionIds: ['parent', 'child1'] })
  assert.equal(withoutAddress.value.scanned, 1)
  assert.equal(withoutAddress.value.total, 0)
  const withAddress = await handleContextComms(api, {
    type: 'context-comms',
    sessionIds: ['parent', 'child1'],
    sessions: [{ id: 'child1', parentSessionId: 'parent', mode: 'continuable' }],
  })
  assert.equal(withAddress.value.scanned, 2)
  assert.equal(withAddress.value.total, 1)
  assert.equal(withAddress.value.messages[0].to, 'child1')
  assert.equal(withAddress.value.messages[0].from, 'child1')
  assert.ok(calls.some((call) => call.parentSessionId === 'parent' && call.mode === 'continuable'))
  console.log('context bridge comms addressing tests passed')
}

{
  const value = buildCommsValue([
    { id: 'parent', title: 'Parent', events: [] },
    {
      id: 'child', title: 'Child', parentSessionId: 'parent', mode: 'continuable',
      projections: { values: { subagentTiming: { lastTurnCompleted: true } } },
      events: [
        { type: 'tool/call', seq: 10, time: 10000, data: {
          callId: 'send-ok', name: 'send_message',
          arguments: JSON.stringify({ agent_id: 'parent', message: 'actual DSH private message' }),
        } },
        { type: 'tool/result', seq: 11, time: 10001, data: {
          message: { source: { callId: 'send-ok' }, content: [{ type: 'text', text: 'accepted' }] },
        } },
        { type: 'turn/end', seq: 12, time: 11000, data: { reason: { kind: 'completed' } } },
      ],
    },
  ])
  assert.deepEqual(value.messages.map((message) => [message.kind, message.from, message.to]), [
    ['settled', 'child', 'parent'],
    ['relay', 'child', 'parent'],
  ])
  assert.equal(value.messages[1].text, 'actual DSH private message')
  console.log('context bridge comms parses send_message and completed child reports')
}
