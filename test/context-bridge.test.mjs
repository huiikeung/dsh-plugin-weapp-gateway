import assert from 'node:assert/strict'
import {
  CONTEXT_REQUEST_TYPES,
  applyContextEvent,
  buildFleetValue,
  contextProjectionDefinition,
  contextView,
  createState,
  handleContextFleet,
  handleContextQuery,
  registerContextProjection,
  registerContextServices,
} from '../lib/context-bridge.mjs'

// --- request types -----------------------------------------------------------

assert.deepEqual([...CONTEXT_REQUEST_TYPES].sort(), ['context-dashboard', 'context-fleet'])

// --- empty fold state --------------------------------------------------------

const emptyView = contextView(createState())
assert.deepEqual(emptyView, {
  v: 1,
  current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
  counts: { humanInputs: 0, answers: 0, toolCalls: 0, skillLoads: 0, injects: 0, compactions: 0, prunes: 0 },
  tools: { total: 0, names: [] },
  timing: { wallMs: 0 },
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
assert.equal(contextProjectionDefinition.stateVersion, 1)
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
const serviceCtx = {
  inject(names, callback) {
    injectCalls.push([...names])
    if (names[0] === 'sessions') sessionsSubscriber = callback
    else agentsSubscriber = callback
  },
}
assert.equal(registerContextServices(serviceCtx), true)
assert.deepEqual(injectCalls, [['sessions', 'sessionProjections'], ['agents']])
assert.equal(typeof sessionsSubscriber, 'function')
assert.equal(typeof agentsSubscriber, 'function')

const hostSessions = [
  { id: 'root', header: { createdAt: 1 } },
  { id: 'child', header: { parentSession: 'root', origin: 'subagent', createdAt: 2 } },
]
const effects = []
const hostProjections = {
  snapshot(session) {
    return session.id === 'child'
      ? { values: { subagent: { mode: 'continuable' }, mobileContext: { current: { user: 3 } } } }
      : { values: {} }
  },
}
sessionsSubscriber({
  sessions: { list: () => hostSessions },
  sessionProjections: hostProjections,
  effect: (fn) => { effects.push(fn()) },
})
const fleetFrame = await handleContextFleet({ type: 'context-fleet', sessionId: 'child' })
assert.equal(fleetFrame.kind, 'context-fleet')
assert.equal(fleetFrame.sessionId, 'child')
assert.equal(fleetFrame.value.rootSessionId, 'root')
assert.deepEqual(fleetFrame.value.agents.map(agent => agent.sessionId), ['root', 'child'])
assert.equal(fleetFrame.value.agents[1].mode, 'continuable')
assert.deepEqual(fleetFrame.value.agents[1].composition, { system: 0, tools: 0, user: 3, inject: 0, skill: 0, assistant: 0, tool: 0, total: 3 })
assert.equal(effects.length, 1)

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
