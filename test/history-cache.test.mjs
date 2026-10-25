import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistoryCache, historyCacheKey } from '../lib/history-cache.mjs'

const page = (bytes = 10) => ({ kind: 'history', bytes, events: [] })

test('history cache keys isolate session target, cursor and view', () => {
  const base = { beforeSeq: 20, maxMessages: 50, maxBytes: 1024, view: 'conversation' }
  assert.notEqual(historyCacheKey('a', base), historyCacheKey('b', base))
  assert.notEqual(historyCacheKey('a', base), historyCacheKey('a', { ...base, beforeSeq: 10 }))
  assert.notEqual(historyCacheKey('a', base), historyCacheKey('a', { ...base, view: 'context' }))
  assert.notEqual(historyCacheKey('a', { ...base, parentSessionId: 'parent', subagentMode: 'continuable' }),
    historyCacheKey('a', { ...base, parentSessionId: 'other-parent', subagentMode: 'continuable' }))
  assert.equal(historyCacheKey('a', {}), 'a|||tail|||')
})

test('history cache expires entries and refreshes LRU recency on reads', () => {
  const cache = createHistoryCache({ maxEntries: 2, ttlMs: 50 })
  cache.set('a', page(), 0)
  cache.set('b', page(), 1)
  assert.equal(cache.get('a', 20).kind, 'history')
  cache.set('c', page(), 21)
  assert.equal(cache.get('b', 22), null)
  assert.equal(cache.get('a', 22).kind, 'history')
  assert.equal(cache.get('a', 71), null)
  assert.equal(cache.size, 1)
})

test('history cache enforces byte and entry limits and ignores invalid frames', () => {
  const cache = createHistoryCache({ maxEntries: 2, maxBytes: 15 })
  cache.set('invalid', { kind: 'sessions', bytes: 1 }, 0)
  cache.set('large', page(20), 0)
  assert.equal(cache.size, 0, 'an individually oversized history page is not retained')
  cache.set('a', page(8), 1)
  cache.set('b', page(8), 2)
  assert.equal(cache.get('a', 3), null, 'byte pressure removes the least recently used page')
  cache.set('c', page(5), 4)
  cache.set('d', page(5), 5)
  assert.equal(cache.size, 2)
  assert.equal(cache.bytes, 10)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.bytes, 0)
})
