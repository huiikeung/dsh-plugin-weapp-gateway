import assert from 'node:assert/strict'
import { parseSessionTarget, sessionAddress } from '../lib/session-target.mjs'

assert.deepEqual(parseSessionTarget({ type: 'history', sessionId: 's1' }), { value: { sessionId: 's1' } })
assert.deepEqual(parseSessionTarget({ type: 'history', sessionId: 'child', parentSessionId: 'parent',
  subagentMode: 'continuable' }), { value: { sessionId: 'child', parentSessionId: 'parent', subagentMode: 'continuable' } })
assert.deepEqual(sessionAddress({ sessionId: 'child', parentSessionId: 'parent', subagentMode: 'one-shot' }),
  { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' })
assert.deepEqual(parseSessionTarget({ type: 'subscribe' }, { optional: true }), { value: {} })

for (const invalid of [
  { sessionId: '' },
  { sessionId: 'child', parentSessionId: '' , subagentMode: 'continuable' },
  { sessionId: 'same', parentSessionId: 'same', subagentMode: 'continuable' },
  { sessionId: 'child', parentSessionId: 'parent' },
  { sessionId: 'child', parentSessionId: 'parent', subagentMode: 'external' },
]) {
  assert.equal(parseSessionTarget({ type: 'history', ...invalid }).error.code, 'bad-request')
}

console.log('SESSION TARGET TESTS PASSED')
