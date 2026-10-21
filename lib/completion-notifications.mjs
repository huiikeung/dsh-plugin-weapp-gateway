const TICKET_RE = /^[A-Za-z0-9_-]{43}$/
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

function eventTurnKey(event) {
  const value = event?.data?.turn
  if (typeof value === 'string' || typeof value === 'number') return `${typeof value}:${String(value)}`
  return null
}

function finiteCount(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

function addUsage(target, usage) {
  if (!target || !usage || typeof usage !== 'object') return
  const input = finiteCount(usage.inputTokens, usage.promptTokens)
  const uncachedInput = finiteCount(usage.uncachedInputTokens, usage.uncached_input_tokens)
  const output = finiteCount(usage.outputTokens, usage.completionTokens)
  const total = finiteCount(usage.totalTokens)
  const cacheRead = finiteCount(usage.cacheReadTokens, usage.cachedInputTokens, usage.cacheReadInputTokens)
  if (input !== null) { target.inputTokens += input; target.hasInputTokens = true }
  if (uncachedInput !== null) { target.uncachedInputTokens += uncachedInput; target.hasUncachedInputTokens = true }
  if (output !== null) { target.outputTokens += output; target.hasOutputTokens = true }
  if (total !== null) { target.totalTokens += total; target.hasTotalTokens = true }
  if (cacheRead !== null) { target.cacheReadTokens += cacheRead; target.hasCacheReadTokens = true }
}

function turnMetrics(state, key, endedAt) {
  const usage = state.turnUsage.get(key)
  const start = state.turnStartedAt.get(key)
  const result = {}
  if (state.taskName) result.taskName = state.taskName
  if (start !== undefined && Number.isFinite(endedAt) && endedAt >= start) result.durationMs = endedAt - start
  if (usage && (usage.hasTotalTokens || usage.hasInputTokens || usage.hasOutputTokens)) {
    result.tokens = usage.hasTotalTokens ? usage.totalTokens : usage.inputTokens + usage.outputTokens
  } else if (usage?.hasUncachedInputTokens || usage?.hasCacheReadTokens || usage?.hasOutputTokens) {
    result.tokens = usage.uncachedInputTokens + usage.cacheReadTokens + usage.outputTokens
  }
  if (usage?.hasCacheReadTokens && (usage.hasUncachedInputTokens || usage.hasInputTokens)) {
    const inputBase = usage.hasUncachedInputTokens ? usage.uncachedInputTokens : usage.inputTokens
    const denominator = inputBase + usage.cacheReadTokens
    if (denominator > 0) result.cacheHitRate = Math.min(1, usage.cacheReadTokens / denominator)
  }
  return result
}

function completionUrl(baseUrl) {
  if (!baseUrl) return null
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('notificationServiceUrl must be an HTTPS URL') }
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('notificationServiceUrl must be HTTPS without credentials, query, or fragment')
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/notifications/complete`
}

export function createCompletionNotifications({ serviceUrl, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const endpoint = completionUrl(serviceUrl)
  const sessions = new Map()
  if (endpoint && typeof fetchImpl !== 'function') throw new Error('fetch is required for completion notifications')

  function sessionState(sessionId, create = false) {
    let value = sessions.get(sessionId)
    if (!value && create) {
      value = {
        pending: [], active: new Map(), currentTurn: null, currentTurnAt: null,
        taskName: null, taskNameAt: null, turnStartedAt: new Map(), turnUsage: new Map(),
      }
      sessions.set(sessionId, value)
    }
    return value
  }

  function prune() {
    const cutoff = now() - MAX_AGE_MS
    for (const [sessionId, state] of sessions) {
      state.pending = state.pending.filter(item => item.createdAt > cutoff)
      if (state.currentTurnAt !== null && state.currentTurnAt <= cutoff) {
        state.currentTurn = null
        state.currentTurnAt = null
      }
      for (const [key, items] of state.active) {
        const live = items.filter(item => item.createdAt > cutoff)
        if (live.length) state.active.set(key, live)
        else state.active.delete(key)
      }
      if (state.taskNameAt !== null && state.taskNameAt <= cutoff) {
        state.taskName = null
        state.taskNameAt = null
      }
      for (const [key, startedAt] of state.turnStartedAt) {
        if (startedAt <= cutoff) {
          state.turnStartedAt.delete(key)
          state.turnUsage.delete(key)
        }
      }
      if (!state.pending.length && !state.active.size && state.currentTurn === null && state.taskNameAt === null) sessions.delete(sessionId)
    }
  }

  function register(sessionId, ticket, mode = 'queue') {
    if (!endpoint || typeof sessionId !== 'string' || !sessionId || !TICKET_RE.test(ticket || '')) return null
    prune()
    const state = sessionState(sessionId, true)
    const activeCount = [...state.active.values()].reduce((sum, items) => sum + items.length, 0)
    if (state.pending.length + activeCount >= 64) return null
    const registration = { ticket, mode: mode === 'steer' ? 'steer' : 'queue', createdAt: now(), turn: null }
    if (registration.mode === 'steer' && state.currentTurn !== null) {
      registration.turn = state.currentTurn
      const active = state.active.get(state.currentTurn) || []
      active.push(registration)
      state.active.set(state.currentTurn, active)
    } else state.pending.push(registration)
    return registration
  }

  function discard(sessionId, registration) {
    if (!registration) return
    const state = sessionState(sessionId)
    if (!state) return
    state.pending = state.pending.filter(item => item !== registration)
    for (const [key, items] of state.active) {
      const remaining = items.filter(item => item !== registration)
      if (remaining.length) state.active.set(key, remaining)
      else state.active.delete(key)
    }
    if (!state.pending.length && !state.active.size && state.currentTurn === null && state.taskNameAt === null) sessions.delete(sessionId)
  }

  async function deliver(sessionId, records, metrics) {
    if (!endpoint || !records.length) return
    for (const record of records) {
      let response
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: record.ticket, sessionId, status: 'completed', ...metrics }),
          })
          if (response.ok) break
        } catch (_) { response = null }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
      }
      if (!response?.ok) log(`completion notification delivery failed for session ${sessionId}`)
    }
  }

  function onSessionEvent(sessionId, event) {
    if (!endpoint || typeof sessionId !== 'string' || !event) return
    prune()
    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title.trim().slice(0, 200) : ''
      if (title) {
        const state = sessionState(sessionId, true)
        state.taskName = title
        state.taskNameAt = now()
      }
      return
    }
    if (event.type === 'turn/start') {
      const state = sessionState(sessionId, true)
      const key = eventTurnKey(event) || (Number.isSafeInteger(event.seq) ? `seq:${event.seq}` : null)
      if (key === null) return
      state.currentTurn = key
      state.currentTurnAt = now()
      state.turnStartedAt.set(key, state.currentTurnAt)
      state.turnUsage.set(key, {
        inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0,
        hasInputTokens: false, hasUncachedInputTokens: false, hasOutputTokens: false,
        hasTotalTokens: false, hasCacheReadTokens: false,
      })
      if (!state.active.has(key)) state.active.set(key, [])
      const next = state.pending.shift()
      if (next) {
        next.turn = key
        state.active.get(key).push(next)
      }
      return
    }
    if (event.type === 'assistant/message') {
      const state = sessionState(sessionId)
      const key = eventTurnKey(event) || state?.currentTurn
      if (state && key !== null && key !== undefined) addUsage(state.turnUsage.get(key), event.data?.usage)
      return
    }
    if (event.type !== 'turn/end') return
    const state = sessionState(sessionId)
    if (!state) return
    // Event sequence numbers differ between start and end; if turn metadata is
    // absent on the end event, close the turn already tracked as current.
    const key = eventTurnKey(event) || state.currentTurn
    const records = key === null ? [] : state.active.get(key) || []
    const metrics = key === null ? {} : turnMetrics(state, key, now())
    if (key !== null) state.active.delete(key)
    if (key !== null) {
      state.turnStartedAt.delete(key)
      state.turnUsage.delete(key)
    }
    if (state.currentTurn === key) { state.currentTurn = null; state.currentTurnAt = null }
    void deliver(sessionId, records, metrics).catch(() => log(`completion notification delivery failed for session ${sessionId}`))
    if (!state.pending.length && !state.active.size && state.currentTurn === null && state.taskNameAt === null) sessions.delete(sessionId)
  }

  return { register, discard, onSessionEvent, clear() { sessions.clear() } }
}

export { completionUrl }
