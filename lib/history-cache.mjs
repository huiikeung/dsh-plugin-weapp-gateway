// Short-lived LRU for immutable history pages (`beforeSeq` cut). The host has to
// re-read the session log for every page, so caching pages makes scrolling back
// through already-visited regions instant and lets a background prefetch warm
// the next pages before the client asks for them.

export function historyCacheKey(sessionId, msg) {
  const before = msg && typeof msg.beforeSeq === 'number' ? msg.beforeSeq : 'tail'
  return [sessionId, before, msg && msg.maxMessages, msg && msg.maxBytes, msg && msg.view].join('|')
}

export function createHistoryCache(options = {}) {
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 60
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 64 * 1024 * 1024
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 5 * 60 * 1000
  const entries = new Map()
  let totalBytes = 0

  function sizeOf(frame) {
    const bytes = Number(frame && frame.bytes)
    return Number.isFinite(bytes) && bytes > 0 ? Math.min(bytes, 4 * 1024 * 1024) : 64 * 1024
  }

  function drop(key) {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    totalBytes -= entry.size
  }

  function prune(now) {
    for (const [key, entry] of entries) {
      if (now - entry.at > ttlMs) drop(key)
    }
    while (entries.size > 0 && (entries.size > maxEntries || totalBytes > maxBytes)) {
      const oldest = entries.keys().next().value
      drop(oldest)
    }
  }

  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key)
      if (!entry) return null
      if (now - entry.at > ttlMs) { drop(key); return null }
      // Refresh recency without changing insertion semantics too much.
      entries.delete(key)
      entries.set(key, entry)
      return entry.frame
    },
    set(key, frame, now = Date.now()) {
      if (!frame || frame.kind !== 'history') return
      if (entries.has(key)) drop(key)
      const size = sizeOf(frame)
      entries.set(key, { frame, at: now, size })
      totalBytes += size
      prune(now)
    },
    has(key, now = Date.now()) { return this.get(key, now) !== null },
    get size() { return entries.size },
    get bytes() { return totalBytes },
    clear() { entries.clear(); totalBytes = 0 },
  }
}
