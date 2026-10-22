import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Keep the config file out of the real ~/.dsh profile.
const stateFile = path.join(os.tmpdir(), `weapp-cost-test-${process.pid}.json`)
process.env.DSH_WEAPP_COST_STATE_FILE = stateFile
try { fs.unlinkSync(stateFile) } catch { /* first run */ }

const mod = await import('../lib/cost-meter-bridge.mjs')
const {
  COST_METER_REQUEST_TYPES,
  applyCostEvent,
  costMeterProjectionDefinition,
  handleCostMeter,
  registerCostMeterProjection,
  registerCostMeterServices,
  resetCostMeterForTests,
} = mod

// ---------------------------------------------------------------------------
// Wire request types
// ---------------------------------------------------------------------------
assert.deepEqual([...COST_METER_REQUEST_TYPES], ['cost-meter'])

// ---------------------------------------------------------------------------
// Projection definition shape
// ---------------------------------------------------------------------------
assert.equal(costMeterProjectionDefinition.key, 'costMeter')
assert.equal(typeof costMeterProjectionDefinition.init, 'function')
assert.equal(typeof costMeterProjectionDefinition.apply, 'function')
assert.equal(typeof costMeterProjectionDefinition.wire.view, 'function')
const freshState = costMeterProjectionDefinition.init()
assert.deepEqual(costMeterProjectionDefinition.wire.view(freshState).total.calls, 0)

// ---------------------------------------------------------------------------
// applyCostEvent: only assistant/message events with usage are billed, and the
// cache-read portion is not billed twice when inputTokens is inclusive.
// ---------------------------------------------------------------------------
const DAY = 86_400_000
const t0 = new Date(2026, 9, 22, 10, 0, 0).getTime() // 2026-10-22 10:00 local
let state = costMeterProjectionDefinition.init()

// Ignored: not an assistant message.
applyCostEvent(state, { type: 'user/message', seq: 1, time: t0, data: {} })
// Ignored: assistant message without usage.
applyCostEvent(state, { type: 'assistant/message', seq: 2, time: t0, data: { message: {} } })
assert.equal(state.total.calls, 0)

// inputTokens is inclusive of cacheReadTokens: uncached = 1000 - 800 = 200.
applyCostEvent(state, {
  type: 'assistant/message', seq: 3, time: t0,
  data: { source: { model: 'deepseek-chat' }, usage: { inputTokens: 1000, cacheReadTokens: 800, outputTokens: 100 } },
})
assert.equal(state.total.calls, 1)
assert.equal(state.total.input, 200, 'cache-read tokens must not be billed as fresh input')
assert.equal(state.total.cacheRead, 800)
assert.equal(state.total.output, 100)
assert.equal(state.total.tokens, 200 + 800 + 100)

// Explicit uncachedInputTokens wins over inputTokens.
applyCostEvent(state, {
  type: 'assistant/message', seq: 4, time: t0 + 60_000,
  data: { model: 'deepseek-reasoner', usage: { inputTokens: 5000, uncachedInputTokens: 400, cacheReadTokens: 4600, outputTokens: 50 } },
})
assert.equal(state.total.input, 200 + 400)
assert.equal(state.total.calls, 2)

// A different day lands in its own bucket.
applyCostEvent(state, {
  type: 'assistant/message', seq: 5, time: t0 + 2 * DAY,
  data: { source: { model: 'deepseek-chat' }, usage: { inputTokens: 10, outputTokens: 10 } },
})
assert.equal(Object.keys(state.days).length, 2, 'two distinct day buckets')
const view = costMeterProjectionDefinition.wire.view(state)
assert.equal(view.v, 2)
assert.equal(view.total.calls, 3)
assert.equal(Object.keys(view.days).length, 2)
assert.equal(view.days['2026-10-22'].calls, 2)
assert.equal(view.days['2026-10-24'].calls, 1)
assert.ok(view.total.cost > 0, 'cost must be priced above zero')
assert.ok(view.days['2026-10-22'].cost > 0)
assert.ok(view.days['2026-10-22'].byProviderModel, 'per-provider/model buckets back local Coding Plan estimates')
assert.equal(Object.keys(view.days['2026-10-22'].byProviderModel).length, 2)

// The view must be plain JSON (it is persisted in the host projection cache).
assert.deepEqual(JSON.parse(JSON.stringify(view)), view)

// ---------------------------------------------------------------------------
// Registration hooks are optional-safe.
// ---------------------------------------------------------------------------
assert.equal(registerCostMeterProjection(null), false)
assert.equal(registerCostMeterProjection({}), false)
assert.equal(registerCostMeterServices(null), false)

let registeredProjection = null
let registeredServices = null
const fakeCtx = {
  inject(names, callback) {
    if (names.includes('sessionProjections') && names.includes('sessions')) {
      const sub = {
        sessions: { list: () => [] },
        sessionProjections: { register: () => {}, snapshot: () => null },
        effect: () => {},
      }
      registeredServices = sub
      callback(sub)
    } else if (names.includes('sessionProjections')) {
      const sub = { sessionProjections: { register: (def) => { registeredProjection = def } }, effect: () => {} }
      callback(sub)
    }
  },
}
assert.equal(registerCostMeterProjection(fakeCtx), true)
assert.equal(registeredProjection, costMeterProjectionDefinition)
assert.equal(registerCostMeterServices(fakeCtx), true)
assert.ok(registeredServices)

// ---------------------------------------------------------------------------
// handleCostMeter over a fake host: sessions.list() + projections.snapshot()
// returning the `costMeter` view, exactly like the real host adapter does.
// ---------------------------------------------------------------------------
resetCostMeterForTests()

const now = new Date(2026, 9, 22, 12, 0, 0).getTime()
const dayKey = '2026-10-22'
const monthKey = '2026-10'

function bucket(overrides) {
  return {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
    tokens: 0, cost: 0, calls: 0, ...overrides,
  }
}

const sessionA = { sessionId: 'session-a' }
const sessionB = { sessionId: 'session-b' }
function costValue(days, months, total) {
  return { v: 1, days, months, total, lastTime: now }
}
// `session/list` ships each item's projections, so one RPC covers the profile.
const listItems = [
  {
    sessionId: 'session-a',
    projections: {
      values: {
        costMeter: costValue(
          { [dayKey]: bucket({ tokens: 1000, cost: 0.001, calls: 2 }) },
          { [monthKey]: bucket({ tokens: 5000, cost: 0.005, calls: 6 }) },
          bucket({ tokens: 9000, cost: 0.009, calls: 10 }),
        ),
      },
    },
  },
  {
    sessionId: 'session-b',
    projections: {
      values: {
        costMeter: costValue(
          {},
          { [monthKey]: bucket({ tokens: 2000, cost: 0.002, calls: 3 }) },
          bucket({ tokens: 2000, cost: 0.002, calls: 3 }),
        ),
      },
    },
  },
  // A session whose projection has not folded yet is skipped, never fatal.
  { sessionId: 'session-cold', projections: { values: { tokenUsage: { totals: {} } } } },
]

let listCalls = 0
const fakeApi = {
  sessions: {
    list: async () => { listCalls += 1; return { items: listItems } },
    history: async () => ({ events: [], hasMore: false }),
  },
}

const options = { now: () => now, configOverride: { currency: 'CNY', exchangeRate: 7.2, budget: { enabled: false, amount: 0, period: 'month' } } }

// summary: today = only session A's day bucket; month/total = A + B.
let frame = await handleCostMeter(fakeApi, { type: 'cost-meter', requestId: 'r1', action: 'summary' }, options)
assert.equal(frame.kind, 'cost-meter')
assert.equal(frame.requestId, 'r1')
assert.equal(frame.summary.available, true)
assert.equal(frame.summary.currency, 'CNY')
assert.equal(frame.summary.today.calls, 2)
assert.equal(frame.summary.today.tokens, 1000)
assert.equal(frame.summary.month.calls, 9)
assert.equal(frame.summary.month.tokens, 7000)
assert.equal(frame.summary.total.calls, 13)
assert.equal(frame.summary.total.tokens, 11000)
// 0.001 USD * 7.2 = 0.0072 CNY
assert.ok(Math.abs(frame.summary.today.amount - 0.0072) < 1e-9)
assert.equal(frame.summary.balance, null)
assert.equal(frame.summary.budget.enabled, false)
// Exactly one session/list RPC: the fast path never pages history.
assert.equal(listCalls, 1)

// The wire frame must be plain JSON.
assert.deepEqual(JSON.parse(JSON.stringify(frame)), frame)

// config action
frame = await handleCostMeter(fakeApi, { type: 'cost-meter', requestId: 'r2', action: 'config' }, options)
assert.equal(frame.action, 'config')
assert.equal(frame.config.currency, 'CNY')
assert.equal(frame.config.budget.period, 'month')
assert.equal(frame.config.includeSubagentCost, true)

// update: enables a monthly budget and reflects it immediately
frame = await handleCostMeter(fakeApi, {
  type: 'cost-meter', requestId: 'r3', action: 'update',
  patch: { budget: { enabled: true, amount: 100, period: 'month' } },
}, options)
assert.equal(frame.action, 'update')
assert.equal(frame.config.budget.enabled, true)
assert.equal(frame.summary.budget.enabled, true)
assert.equal(frame.summary.budget.amount, 100)
assert.ok(frame.summary.budget.percent > 0)

// invalid patch is rejected without touching state
frame = await handleCostMeter(fakeApi, {
  type: 'cost-meter', requestId: 'r4', action: 'update',
  patch: { budget: { amount: -1 } },
}, options)
assert.equal(frame.kind, 'error')
assert.equal(frame.code, 'bad-request')

// unknown action
frame = await handleCostMeter(fakeApi, { type: 'cost-meter', requestId: 'r5', action: 'nope' }, options)
assert.equal(frame.kind, 'error')
assert.equal(frame.code, 'bad-request')

// missing requestId
frame = await handleCostMeter(fakeApi, { type: 'cost-meter', action: 'summary' }, options)
assert.equal(frame.kind, 'error')
assert.equal(frame.code, 'bad-request')

// refresh recomputes rather than serving the cached summary
frame = await handleCostMeter(fakeApi, { type: 'cost-meter', requestId: 'r6', action: 'refresh' }, options)
assert.equal(frame.action, 'summary')
assert.equal(frame.summary.total.calls, 13)

// ---------------------------------------------------------------------------
// Unavailable path: the list carries no costMeter projections, the in-process
// snapshots are empty, and there is no usable history.
// ---------------------------------------------------------------------------
resetCostMeterForTests()
const emptyCtx = {
  inject(names, callback) {
    if (names.includes('sessions') && names.includes('sessionProjections')) {
      callback({
        sessions: { list: () => [sessionA] },
        sessionProjections: { register: () => {}, snapshot: () => ({ values: {} }) },
        effect: () => {},
      })
    }
  },
}
registerCostMeterServices(emptyCtx)
const emptyApi = {
  sessions: {
    list: async () => ({ items: [{ sessionId: 'session-a' }] }),
    history: async () => ({ events: [], hasMore: false }),
  },
}
frame = await handleCostMeter(emptyApi, { type: 'cost-meter', requestId: 'r7', action: 'summary' }, options)
assert.equal(frame.kind, 'error')
assert.equal(frame.code, 'cost-meter-unavailable')

// ---------------------------------------------------------------------------
// In-process fallback: the list omits projections but snapshots carry them.
// ---------------------------------------------------------------------------
resetCostMeterForTests()
const snapshotValues = new Map([
  ['session-a', { costMeter: costValue({ [dayKey]: bucket({ tokens: 10, cost: 0.01, calls: 1 }) }, { [monthKey]: bucket({ tokens: 10, cost: 0.01, calls: 1 }) }, bucket({ tokens: 10, cost: 0.01, calls: 1 })) }],
])
const snapshotCtx = {
  inject(names, callback) {
    if (names.includes('sessions') && names.includes('sessionProjections')) {
      callback({
        sessions: { list: () => [{ id: 'session-a', header: { id: 'session-a' } }] },
        sessionProjections: {
          register: () => {},
          snapshot: (session) => ({ values: snapshotValues.get(session?.id) ?? {} }),
        },
        effect: () => {},
      })
    }
  },
}
registerCostMeterServices(snapshotCtx)
const noProjectionApi = {
  sessions: {
    list: async () => ({ items: [{ sessionId: 'session-a' }] }),
    history: async () => ({ events: [], hasMore: false }),
  },
}
frame = await handleCostMeter(noProjectionApi, { type: 'cost-meter', requestId: 'r9', action: 'summary' }, options)
assert.equal(frame.kind, 'cost-meter')
assert.equal(frame.summary.total.calls, 1)
assert.equal(frame.summary.total.tokens, 10)

// ---------------------------------------------------------------------------
// Fallback path: no projections anywhere, but session history is readable.
// ---------------------------------------------------------------------------
resetCostMeterForTests()
const fallbackApi = {
  sessions: {
    list: async () => ({ items: [{ sessionId: 'session-x' }] }),
    history: async () => ({
      events: [
        { event: { type: 'assistant/message', seq: 1, time: now, data: { source: { model: 'deepseek-chat' }, usage: { inputTokens: 100, outputTokens: 20 } } } },
      ],
      hasMore: false,
    }),
  },
}
frame = await handleCostMeter(fallbackApi, { type: 'cost-meter', requestId: 'r8', action: 'summary' }, options)
assert.equal(frame.kind, 'cost-meter')
assert.equal(frame.summary.total.calls, 1)
assert.equal(frame.summary.total.tokens, 120)
assert.equal(frame.summary.today.calls, 1)

try { fs.unlinkSync(stateFile) } catch { /* ignore */ }

console.log('PASS cost meter: projection fold, cache-read de-duplication, day/month buckets, wire contract, config/update validation, unavailable and fallback paths')
