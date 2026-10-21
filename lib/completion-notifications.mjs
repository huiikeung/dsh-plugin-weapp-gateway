const TICKET_RE = /^[A-Za-z0-9_-]{43}$/
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

function turnKey(event) {
  const value = event?.data?.turn
  if (typeof value === 'string' || typeof value === 'number') return `${typeof value}:${String(value)}`
  return Number.isSafeInteger(event?.seq) ? `seq:${event.seq}` : null
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
      value = { pending: [], active: new Map(), currentTurn: null, currentTurnAt: null }
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
      if (!state.pending.length && !state.active.size && state.currentTurn === null) sessions.delete(sessionId)
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
    if (!state.pending.length && !state.active.size && state.currentTurn === null) sessions.delete(sessionId)
  }

  async function deliver(sessionId, records) {
    if (!endpoint || !records.length) return
    for (const record of records) {
      let response
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: record.ticket, sessionId, status: 'completed' }),
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
    if (event.type === 'turn/start') {
      const state = sessionState(sessionId, true)
      const key = turnKey(event)
      if (key === null) return
      state.currentTurn = key
      state.currentTurnAt = now()
      if (!state.active.has(key)) state.active.set(key, [])
      const next = state.pending.shift()
      if (next) {
        next.turn = key
        state.active.get(key).push(next)
      }
      return
    }
    if (event.type !== 'turn/end') return
    const state = sessionState(sessionId)
    if (!state) return
    const key = turnKey(event) || state.currentTurn
    const records = key === null ? [] : state.active.get(key) || []
    if (key !== null) state.active.delete(key)
    if (state.currentTurn === key) { state.currentTurn = null; state.currentTurnAt = null }
    void deliver(sessionId, records).catch(() => log(`completion notification delivery failed for session ${sessionId}`))
    if (!state.pending.length && !state.active.size && state.currentTurn === null) sessions.delete(sessionId)
  }

  return { register, discard, onSessionEvent, clear() { sessions.clear() } }
}

export { completionUrl }
