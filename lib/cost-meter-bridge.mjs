/**
 * Cost Meter bridge — standalone, projection-based (no `dsh-cost-meter` plugin).
 *
 * Architecture mirrors the context dashboard: this module registers a DSH
 * session projection (`costMeter`) that folds every durable `assistant/message`
 * event's provider-reported `data.usage` into day / month / lifetime token and
 * cost buckets. The host replays the durable log into that projection and
 * persists it in the session projection cache, so answering a query costs one
 * cheap in-process snapshot per session instead of re-reading megabytes of
 * history over RPC (which blows the client's 8s budget on real profiles).
 *
 * The wire contract the mini program's `cost-view.js` expects is unchanged:
 *
 *   { type: 'cost-meter', requestId, action, patch? } ->
 *   { kind: 'cost-meter', requestId, action, summary, config? }
 *
 * Actions: summary (30s cache), config, update (allowlisted patch), refresh.
 *
 * Prices are a built-in USD-per-million estimate table keyed by model id
 * substring; `currency` / `exchangeRate` from the persisted config turn the USD
 * fold into the display currency.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const COST_METER_REQUEST_TYPES = new Set(['cost-meter'])

const MAX_REQUEST_ID = 128
const FINITE = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const CACHE_TTL_MS = 30_000
const MAX_SESSIONS = 400
const MAX_SNAPSHOT_SESSIONS = 40
const MAX_FALLBACK_SESSIONS = 8
const KEEP_DAYS = 45
const KEEP_MONTHS = 14

// A plain object with the only method the projection registry calls. Keeping
// this bridge free of a zod dependency lets the module load both in the host
// plugin and in plain-Node unit tests (same trick as context-bridge).
const passthroughSchema = Object.freeze({
  parse: value => value,
  safeParse: value => ({ success: true, data: value }),
  '~standard': Object.freeze({
    version: 1,
    vendor: 'weapp-gateway',
    validate: value => ({ value }),
  }),
})

// Built-in USD list prices per million tokens (display estimate only). Keys
// match by model id substring; '*' is the fallback for unknown/local models.
const DEFAULT_PRICES = {
  'deepseek-chat': { input: 0.27, cacheRead: 0.07, cacheWrite: 0.27, output: 1.10 },
  'deepseek-reasoner': { input: 0.55, cacheRead: 0.14, cacheWrite: 0.55, output: 2.19 },
  'deepseek-v3': { input: 0.27, cacheRead: 0.07, cacheWrite: 0.27, output: 1.10 },
  'deepseek-r1': { input: 0.55, cacheRead: 0.14, cacheWrite: 0.55, output: 2.19 },
  'deepseek': { input: 0.27, cacheRead: 0.07, cacheWrite: 0.27, output: 1.10 },
  'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, cacheWrite: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, cacheRead: 1.25, cacheWrite: 2.5, output: 10 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 },
  'gpt-6': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 },
  'claude-3-5-sonnet': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-3-5-haiku': { input: 0.8, cacheRead: 0.08, cacheWrite: 1, output: 4 },
  'claude': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'glm-4-flash': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.1, output: 0.1 },
  'glm': { input: 0.5, cacheRead: 0.05, cacheWrite: 0.5, output: 2 },
  'qwen-max': { input: 0.04, cacheRead: 0.004, cacheWrite: 0.04, output: 0.12 },
  'qwen-plus': { input: 0.008, cacheRead: 0.0008, cacheWrite: 0.008, output: 0.032 },
  'qwen-turbo': { input: 0.005, cacheRead: 0.0005, cacheWrite: 0.005, output: 0.02 },
  'qwen': { input: 0.04, cacheRead: 0.004, cacheWrite: 0.04, output: 0.12 },
  'step-': { input: 0.5, cacheRead: 0.05, cacheWrite: 0.5, output: 2 },
  'grok': { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 10 },
  'llama': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.2, output: 0.2 },
  'mistral': { input: 0.15, cacheRead: 0.015, cacheWrite: 0.15, output: 0.6 },
  '*': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.2, output: 0.2 },
}

const DEFAULT_CONFIG = Object.freeze({
  currency: 'CNY',
  exchangeRate: 7.2,
  budget: { enabled: false, amount: 0, period: 'month' },
  balance: { display: 'both' },
  hideBudget: false,
  showTotalWithPlan: false,
  includeSubagentCost: true,
  locale: 'zh',
})

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function numeric(v, fallback = 0) { return FINITE(v) ?? fallback }

function tokenCountOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

function priceOf(modelId) {
  const key = typeof modelId === 'string' ? modelId.toLowerCase() : ''
  if (key !== '') {
    for (const [name, price] of Object.entries(DEFAULT_PRICES)) {
      if (name === '*') continue
      if (key.includes(name)) return price
    }
  }
  return DEFAULT_PRICES['*']
}

/**
 * Bill one usage record. Provider usage may report `inputTokens` inclusive of
 * cache hits (DeepSeek's `prompt_tokens` does), so prefer `uncachedInputTokens`
 * and otherwise subtract the cache-read portion — otherwise cached tokens get
 * billed twice.
 */
function usageRow(usage, modelId) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const cacheRead = tokenCountOf(u.cacheReadTokens) ?? tokenCountOf(u.cachedInputTokens) ?? 0
  const cacheWrite = tokenCountOf(u.cacheWriteTokens) ?? 0
  const output = tokenCountOf(u.outputTokens) ?? tokenCountOf(u.completionTokens) ?? 0
  const reasoning = tokenCountOf(u.reasoningTokens) ?? 0
  let input = tokenCountOf(u.uncachedInputTokens)
  if (input === null) {
    const raw = tokenCountOf(u.inputTokens) ?? tokenCountOf(u.promptTokens) ?? 0
    input = Math.max(0, raw - cacheRead)
  }
  const price = priceOf(modelId)
  const cost = (
    input * numeric(price.input)
    + cacheRead * numeric(price.cacheRead)
    + cacheWrite * numeric(price.cacheWrite)
    + (output + reasoning) * numeric(price.output)
  ) / 1_000_000
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    tokens: input + cacheRead + cacheWrite + output + reasoning,
    cost,
    calls: 1,
  }
}

function emptyBucket() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, tokens: 0, cost: 0, calls: 0 }
}

function addRow(target, row) {
  if (!target || !row) return target
  target.input += numeric(row.input)
  target.cacheRead += numeric(row.cacheRead)
  target.cacheWrite += numeric(row.cacheWrite)
  target.output += numeric(row.output)
  target.reasoning += numeric(row.reasoning)
  target.tokens += numeric(row.tokens)
  target.cost += numeric(row.cost)
  target.calls += numeric(row.calls)
  return target
}

function dayKeyOf(time) {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKeyOf(time) {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function modelOf(event) {
  const data = event && event.data !== null && typeof event.data === 'object' ? event.data : null
  if (!data) return ''
  if (typeof data.model === 'string' && data.model !== '') return data.model
  const source = data.source && typeof data.source === 'object' ? data.source : null
  if (source && typeof source.model === 'string' && source.model !== '') return source.model
  return ''
}

// ---------------------------------------------------------------------------
// Projection state (plain JSON; safe to persist in the host projection cache)
// ---------------------------------------------------------------------------

function createCostState() {
  return { v: 1, days: {}, months: {}, total: emptyBucket(), lastTime: 0 }
}

function pruneState(state) {
  const newest = numeric(state.lastTime)
  if (newest <= 0) return state
  const dayCutoff = newest - KEEP_DAYS * 86_400_000
  for (const key of Object.keys(state.days)) {
    const t = Date.parse(key + 'T00:00:00')
    if (!Number.isFinite(t) || t < dayCutoff) delete state.days[key]
  }
  const monthCutoff = newest - KEEP_MONTHS * 31 * 86_400_000
  for (const key of Object.keys(state.months)) {
    const t = Date.parse(key + '-01T00:00:00')
    if (!Number.isFinite(t) || t < monthCutoff) delete state.months[key]
  }
  return state
}

/** Fold one durable event into the cost projection state (mutating). */
export function applyCostEvent(state, event) {
  if (!state || typeof state !== 'object') return state
  if (!event || typeof event !== 'object' || event.type !== 'assistant/message') return state
  const data = event.data !== null && typeof event.data === 'object' ? event.data : null
  const usage = data && data.usage !== null && typeof data.usage === 'object' ? data.usage : null
  if (!usage) return state
  const row = usageRow(usage, modelOf(event))
  if (row.tokens === 0) return state
  const time = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0
    ? event.time
    : (typeof data.time === 'number' && Number.isFinite(data.time) && data.time > 0 ? data.time : 0)
  const stamp = time > 0 ? time : numeric(state.lastTime)
  const dk = dayKeyOf(stamp || Date.now())
  const mk = monthKeyOf(stamp || Date.now())
  if (state.days[dk] === undefined) {
    state.days[dk] = emptyBucket()
    if (stamp > 0) {
      state.lastTime = Math.max(numeric(state.lastTime), stamp)
      pruneState(state)
    }
  }
  addRow(state.days[dk], row)
  if (state.months[mk] === undefined) state.months[mk] = emptyBucket()
  addRow(state.months[mk], row)
  addRow(state.total, row)
  if (stamp > 0) state.lastTime = Math.max(numeric(state.lastTime), stamp)
  return state
}

/** Time-independent view: the bridge selects today/month at request time. */
function costViewOf(state) {
  if (!state || typeof state !== 'object') return null
  const days = {}
  for (const [key, bucket] of Object.entries(state.days || {})) {
    if (bucket && numeric(bucket.calls) > 0) days[key] = { ...emptyBucket(), ...bucket }
  }
  const months = {}
  for (const [key, bucket] of Object.entries(state.months || {})) {
    if (bucket && numeric(bucket.calls) > 0) months[key] = { ...emptyBucket(), ...bucket }
  }
  const total = state.total && numeric(state.total.calls) > 0 ? { ...emptyBucket(), ...state.total } : emptyBucket()
  return { v: 1, days, months, total, lastTime: numeric(state.lastTime) }
}

/** The `costMeter` projection definition registered on `ctx.sessionProjections`. */
export const costMeterProjectionDefinition = {
  key: 'costMeter',
  stateVersion: 1,
  stateSchema: passthroughSchema,
  init: () => createCostState(),
  apply: (state, event) => applyCostEvent(state, event),
  wire: { viewSchema: passthroughSchema, view: state => costViewOf(state) },
}

// ---------------------------------------------------------------------------
// Host services (in-process, same pattern as context-bridge)
// ---------------------------------------------------------------------------

let hostSessions = null
let hostProjections = null

/** Register the cost projection so the host folds it into the projection cache. */
export function registerCostMeterProjection(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['sessionProjections'], (sub) => {
      if (!sub || !sub.sessionProjections || typeof sub.sessionProjections.register !== 'function') return
      sub.sessionProjections.register(costMeterProjectionDefinition)
    })
    return true
  } catch (_) {
    return false
  }
}

/** Capture the host services the summary query reads. */
export function registerCostMeterServices(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['sessions', 'sessionProjections'], (sub) => {
      if (!sub || !sub.sessions || !sub.sessionProjections) return
      hostSessions = sub.sessions
      hostProjections = sub.sessionProjections
      sub.effect(() => () => {
        hostSessions = null
        hostProjections = null
      })
    })
    return true
  } catch (_) {
    return false
  }
}

function hostReady() {
  return hostSessions !== null && typeof hostSessions.list === 'function'
}

function hostSessionList() {
  try {
    const result = hostSessions.list()
    return Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
  } catch (_) {
    return []
  }
}

function newAccumulator() {
  return { days: {}, months: {}, total: emptyBucket(), sessions: 0, covered: 0 }
}

/** Merge one `costMeter` projection view into the accumulator. */
function mergeCostValue(acc, value) {
  if (!value || typeof value !== 'object') return false
  acc.covered += 1
  for (const [key, bucket] of Object.entries(value.days || {})) {
    if (!acc.days[key]) acc.days[key] = emptyBucket()
    addRow(acc.days[key], bucket)
  }
  for (const [key, bucket] of Object.entries(value.months || {})) {
    if (!acc.months[key]) acc.months[key] = emptyBucket()
    addRow(acc.months[key], bucket)
  }
  addRow(acc.total, value.total)
  return true
}

function sessionIdOfRecord(session) {
  if (typeof session === 'string') return session
  if (!session || typeof session !== 'object') return ''
  if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
  if (typeof session.id === 'string' && session.id !== '') return session.id
  if (session.header && typeof session.header.id === 'string' && session.header.id !== '') return session.header.id
  return ''
}

/**
 * Fold the `costMeter` projections that `session/list` already ships on every
 * item. This is the fast path the wire test documents (`items[].projections`):
 * one RPC for the whole profile, so it always fits the client's 8s budget.
 */
async function sumListProjections(api, signal) {
  const acc = newAccumulator()
  if (!api || !api.sessions || typeof api.sessions.list !== 'function') return acc
  let items = []
  try {
    const result = await api.sessions.list({}, signal)
    items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
  } catch (_) {
    return acc
  }
  for (const item of items.slice(0, MAX_SESSIONS)) {
    acc.sessions += 1
    const projections = item && typeof item === 'object' ? item.projections : null
    const values = projections && typeof projections === 'object' && projections.values && typeof projections.values === 'object'
      ? projections.values
      : projections && typeof projections === 'object' && !Array.isArray(projections)
        ? projections
        : null
    mergeCostValue(acc, values ? values.costMeter : null)
  }
  return acc
}

/**
 * In-process fallback for hosts whose session list does not carry projections.
 * Bounded to MAX_SNAPSHOT_SESSIONS so a cold profile cannot blow the client
 * timeout while projections fold for the first time.
 */
function sumSnapshotProjections() {
  const acc = newAccumulator()
  if (hostProjections === null || typeof hostProjections.snapshot !== 'function') return acc
  const list = hostSessionList()
  for (const session of list.slice(0, Math.min(list.length, MAX_SNAPSHOT_SESSIONS))) {
    acc.sessions += 1
    let values = null
    try {
      const snapshot = hostProjections.snapshot(session)
      values = snapshot !== null && typeof snapshot === 'object' && snapshot.values !== null && typeof snapshot.values === 'object'
        ? snapshot.values
        : null
    } catch (_) {
      values = null
    }
    mergeCostValue(acc, values ? values.costMeter : null)
  }
  return acc
}

/**
 * Collect the cost totals for the whole profile.
 *
 * Order matters: the single-RPC session list first, then a bounded in-process
 * snapshot pass for sessions the list did not describe, then the history fold
 * for hosts that expose neither. Every path degrades to partial data rather
 * than an error, except when nothing at all is readable.
 */
async function collectTotals(api, signal) {
  const diag = []
  const list = await sumListProjections(api, signal)
  diag.push({ path: 'list', sessions: list.sessions, covered: list.covered })

  if (list.covered === 0 && hostReady()) {
    const snap = sumSnapshotProjections()
    diag.push({ path: 'snapshot', sessions: snap.sessions, covered: snap.covered })
    if (snap.covered > 0) return { acc: snap, diag }
  }

  if (list.covered > 0) {
    // Sessions whose projections the list omitted still count toward the
    // profile total; fold a bounded slice of them in-process.
    const snap = sumSnapshotProjections()
    if (snap.covered > 0) {
      for (const [key, bucket] of Object.entries(snap.days)) {
        if (!list.days[key]) list.days[key] = emptyBucket()
        addRow(list.days[key], bucket)
      }
      for (const [key, bucket] of Object.entries(snap.months)) {
        if (!list.months[key]) list.months[key] = emptyBucket()
        addRow(list.months[key], bucket)
      }
      // Only add the snapshot total when the list contributed nothing for the
      // lifetime bucket, otherwise the same sessions would be counted twice.
      if (list.total.calls === 0) addRow(list.total, snap.total)
      diag.push({ path: 'snapshot+list', sessions: list.sessions, covered: list.covered + snap.covered })
    }
    return { acc: list, diag }
  }

  const fb = await sumFallback(api, signal)
  diag.push({ path: 'fallback', sessions: fb.sessions, covered: fb.covered })
  writeDiag(diag)
  return { acc: fb, diag }
}

// Opt-in diagnostics: set DSH_WEAPP_COST_DEBUG=1 to record which read path
// answered. Off by default so a healthy gateway never touches the disk.
function writeDiag(diag) {
  if (process.env.DSH_WEAPP_COST_DEBUG !== '1') return
  try {
    const file = process.env.DSH_WEAPP_COST_STATE_FILE
      ? process.env.DSH_WEAPP_COST_STATE_FILE.replace(/\.json$/, '-diag.json')
      : path.join(os.homedir(), '.dsh', 'storages', 'weapp-cost-meter-diag.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), diag }, null, 2))
  } catch (_) { /* diagnostics must never break a query */ }
}

// ---------------------------------------------------------------------------
// RPC fallback: only when the projection is not populated on this host, and
// strictly bounded so the client's 8s budget can never be blown.
// ---------------------------------------------------------------------------

function historyAvailable(api) {
  return !!(api && api.sessions && typeof api.sessions.history === 'function')
}

function unwrapHistory(history) {
  if (!history || typeof history !== 'object' || history.kind === 'error') return { events: [], hasMore: false }
  const raw = Array.isArray(history.events) ? history.events : []
  const events = []
  for (const entry of raw) {
    const event = entry && typeof entry === 'object' && entry.event && typeof entry.event === 'object' ? entry.event : entry
    if (event && typeof event.type === 'string') events.push(event)
  }
  return { events, hasMore: history.hasMore === true }
}

async function sumFallback(api, signal) {
  const acc = { days: {}, months: {}, total: emptyBucket(), sessions: 0, covered: 0 }
  if (!historyAvailable(api) || typeof api.sessions.list !== 'function') return acc
  const ids = []
  try {
    const result = await api.sessions.list({}, signal)
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    for (const item of items.slice(0, MAX_FALLBACK_SESSIONS)) {
      const id = item && typeof item.sessionId === 'string' ? item.sessionId : ''
      if (id !== '') ids.push(id)
    }
  } catch (_) {
    return acc
  }
  for (const sessionId of ids) {
    if (signal && signal.aborted) break
    acc.sessions += 1
    let history
    try {
      history = await api.sessions.history({ sessionId }, signal)
    } catch (_) {
      continue
    }
    const page = unwrapHistory(history)
    if (page.events.length === 0) continue
    const state = createCostState()
    for (const event of page.events) applyCostEvent(state, event)
    if (state.total.calls === 0) continue
    acc.covered += 1
    for (const [key, bucket] of Object.entries(state.days)) {
      if (!acc.days[key]) acc.days[key] = emptyBucket()
      addRow(acc.days[key], bucket)
    }
    for (const [key, bucket] of Object.entries(state.months)) {
      if (!acc.months[key]) acc.months[key] = emptyBucket()
      addRow(acc.months[key], bucket)
    }
    addRow(acc.total, state.total)
  }
  return acc
}

// ---------------------------------------------------------------------------
// Config persistence (best-effort; never throws)
// ---------------------------------------------------------------------------

function configFile() {
  return process.env.DSH_WEAPP_COST_STATE_FILE
    || path.join(os.homedir(), '.dsh', 'storages', 'weapp-cost-meter.json')
}

function readConfig() {
  const merged = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget }, balance: { ...DEFAULT_CONFIG.balance } }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    const cfg = parsed && typeof parsed === 'object' && parsed.config && typeof parsed.config === 'object' ? parsed.config : null
    if (cfg) {
      if (typeof cfg.currency === 'string') merged.currency = cfg.currency
      merged.exchangeRate = numeric(cfg.exchangeRate, merged.exchangeRate) || merged.exchangeRate
      merged.hideBudget = cfg.hideBudget === true
      merged.showTotalWithPlan = cfg.showTotalWithPlan === true
      merged.includeSubagentCost = cfg.includeSubagentCost !== false
      if (typeof cfg.locale === 'string') merged.locale = cfg.locale
      if (cfg.budget && typeof cfg.budget === 'object') Object.assign(merged.budget, cfg.budget)
      if (cfg.balance && typeof cfg.balance === 'object') Object.assign(merged.balance, cfg.balance)
    }
  } catch { /* defaults */ }
  return merged
}

function writeConfig(config) {
  const file = configFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: Date.now(), config }, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    return true
  } catch (_) {
    return false
  }
}

// ---------------------------------------------------------------------------
// Wire projection
// ---------------------------------------------------------------------------

function amountOf(bucket, config) {
  const base = bucket ? numeric(bucket.cost) : 0
  const rate = numeric(config.exchangeRate, 1) || 1
  return config.currency === 'USD' ? base : base * rate
}

function publicBucket(bucket, config) {
  if (!bucket || numeric(bucket.calls) === 0) return null
  return { amount: amountOf(bucket, config), tokens: numeric(bucket.tokens), calls: numeric(bucket.calls) }
}

function summaryOf(acc, config, now = Date.now()) {
  const currency = ['CNY', 'USD', 'EUR'].includes(config.currency) ? config.currency : 'CNY'
  const todayKey = dayKeyOf(now)
  const monthKey = monthKeyOf(now)
  const budget = config.budget || {}
  const budgetAmount = numeric(budget.amount)
  const budgetBucket = budget.period === 'day'
    ? acc.days[todayKey]
    : budget.period === 'all' ? acc.total : acc.months[monthKey]
  const budgetUsed = budgetAmount > 0 ? amountOf(budgetBucket, config) : 0
  const budgetPercent = budgetAmount > 0 ? Math.min(999, Math.round(budgetUsed / budgetAmount * 1000) / 10) : null
  return {
    available: true,
    currency,
    today: publicBucket(acc.days[todayKey], config),
    month: publicBucket(acc.months[monthKey], config),
    total: publicBucket(acc.total, config),
    budget: {
      enabled: budget.enabled === true,
      amount: budgetAmount,
      period: budget.period || 'month',
      used: budgetUsed,
      percent: budgetPercent,
    },
    balance: null,
    updatedAt: now,
  }
}

function configOf(config) {
  return {
    currency: ['CNY', 'USD', 'EUR'].includes(config.currency) ? config.currency : 'CNY',
    budget: {
      enabled: config.budget?.enabled === true,
      amount: numeric(config.budget?.amount),
      period: ['day', 'month', 'all'].includes(config.budget?.period) ? config.budget.period : 'month',
    },
    balance: { display: ['sidebar', 'settings', 'both', 'off'].includes(config.balance?.display) ? config.balance.display : 'both' },
    hideBudget: config.hideBudget === true,
    showTotalWithPlan: config.showTotalWithPlan === true,
    locale: ['zh', 'en', 'auto'].includes(config.locale) ? config.locale : 'zh',
    includeSubagentCost: config.includeSubagentCost !== false,
  }
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, message: 'patch 必须是对象' }
  const errors = []
  if (patch.currency !== undefined && !['CNY', 'USD', 'EUR'].includes(patch.currency)) errors.push('currency 必须是 CNY、USD 或 EUR')
  const b = patch.budget
  if (b !== undefined) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) errors.push('budget 必须是对象')
    else {
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') errors.push('budget.enabled 必须是布尔值')
      if (b.amount !== undefined && !FINITE(b.amount)) errors.push('budget.amount 必须是非负数')
      if (b.period !== undefined && !['day', 'month', 'all'].includes(b.period)) errors.push('budget.period 必须是 day、month 或 all')
    }
  }
  const bal = patch.balance
  if (bal !== undefined && bal !== null) {
    if (!bal || typeof bal !== 'object') errors.push('balance 必须是对象')
    else if (bal.display !== undefined && !['sidebar', 'settings', 'both', 'off'].includes(bal.display)) errors.push('balance.display 必须是 sidebar、settings、both 或 off')
  }
  if (patch.hideBudget !== undefined && typeof patch.hideBudget !== 'boolean') errors.push('hideBudget 必须是布尔值')
  if (patch.showTotalWithPlan !== undefined && typeof patch.showTotalWithPlan !== 'boolean') errors.push('showTotalWithPlan 必须是布尔值')
  if (patch.includeSubagentCost !== undefined && typeof patch.includeSubagentCost !== 'boolean') errors.push('includeSubagentCost 必须是布尔值')
  return { ok: errors.length === 0, message: errors.join(';') || null }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedAt = 0
let cachedValue = null
function dropCache() { cachedAt = 0; cachedValue = null }

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Serve one `cost-meter` request.
 *
 * @param {object} api DSH host adapter (only used by the bounded fallback)
 * @param {{requestId?:string, action?:string, patch?:object}} msg mobile frame
 * @param {{now?:Function, signal?:object, configOverride?:object}} [options] tests
 * @returns {Promise<object>} wire frame
 */
export async function handleCostMeter(api, msg, options) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID) : ''
  if (!requestId) return { kind: 'error', requestType: 'cost-meter', code: 'bad-request', message: 'cost-meter requires a requestId' }
  const action = typeof msg?.action === 'string' ? msg.action : 'summary'
  const now = options && typeof options.now === 'function' ? options.now() : Date.now()
  const signal = options && options.signal
  const config = options && options.configOverride
    ? {
        ...DEFAULT_CONFIG,
        ...options.configOverride,
        budget: { ...DEFAULT_CONFIG.budget, ...(options.configOverride.budget || {}) },
        balance: { ...DEFAULT_CONFIG.balance, ...(options.configOverride.balance || {}) },
      }
    : readConfig()

  const fail = (code, message) => ({ kind: 'error', requestType: 'cost-meter', requestId, code, message })

  if (action === 'config') {
    return { kind: 'cost-meter', requestId, action: 'config', config: configOf(config) }
  }

  if (action === 'update') {
    const validated = validatePatch(msg.patch)
    if (!validated.ok) return fail('bad-request', validated.message)
    const patch = msg.patch
    const next = { ...config, budget: { ...config.budget }, balance: { ...config.balance } }
    if (patch.currency !== undefined) next.currency = patch.currency
    if (patch.budget !== undefined) Object.assign(next.budget, patch.budget)
    if (patch.balance !== undefined && patch.balance !== null) Object.assign(next.balance, patch.balance)
    if (patch.hideBudget !== undefined) next.hideBudget = patch.hideBudget
    if (patch.showTotalWithPlan !== undefined) next.showTotalWithPlan = patch.showTotalWithPlan
    if (patch.includeSubagentCost !== undefined) next.includeSubagentCost = patch.includeSubagentCost
    writeConfig(next)
    dropCache()
    const { acc } = await collectTotals(api, signal)
    return { kind: 'cost-meter', requestId, action: 'update', summary: summaryOf(acc, next, now), config: configOf(next) }
  }

  if (action !== 'summary' && action !== 'refresh') {
    return fail('bad-request', `未知的 cost-meter action: ${action}`)
  }

  if (action === 'refresh') dropCache()
  else if (cachedValue !== null && Date.now() - cachedAt < CACHE_TTL_MS
    && JSON.stringify(cachedValue.config) === JSON.stringify(configOf(config))) {
    return { kind: 'cost-meter', requestId, action: 'summary', summary: cachedValue.summary }
  }

  try {
    const { acc } = await collectTotals(api, signal)
    if (acc.covered === 0) return fail('cost-meter-unavailable', 'Host cost projection is unavailable')
    const summary = summaryOf(acc, config, now)
    cachedAt = Date.now()
    cachedValue = { summary, config: configOf(config) }
    return { kind: 'cost-meter', requestId, action: 'summary', summary }
  } catch (e) {
    writeDiag([{ path: 'throw', error: e && e.message ? String(e.message) : String(e), code: e && e.code }])
    return fail('cost-meter-unavailable', '费用数据读取失败')
  }
}

/** Test seam: reset captured host services and the cache. */
export function resetCostMeterForTests() {
  hostSessions = null
  hostProjections = null
  dropCache()
}
