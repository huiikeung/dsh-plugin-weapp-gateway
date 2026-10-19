import test from 'node:test'
import assert from 'node:assert/strict'
import { handleWorkspaceChanges, WORKSPACE_CHANGES_TYPES } from '../lib/workspace-changes-bridge.mjs'

const summary = { turn: 1, total: 2, added: 5, deleted: 3, files: [
  { path: 'src/app.js', display: 'src/app.js', added: 5, deleted: 3 },
  { path: 'assets/logo.png', display: 'assets/logo.png', added: 0, deleted: 0, binary: true },
] }
const query = { type: 'workspace-changes-summary', requestId: 'request', sessionId: 'session', seq: 42 }

test('summaries retain recorded filenames and counts without leaking internal snapshot metadata', async () => {
  assert.deepEqual([...WORKSPACE_CHANGES_TYPES], ['workspace-changes-summary', 'workspace-changes-diff'])
  const api = { workspaceChanges: { summary(id, seq) {
    assert.equal(id, 'session'); assert.equal(seq, 42)
    return { ...summary, cwd: '/private', snapshotDirectory: '/private/snapshot',
      files: summary.files.map(file => ({ ...file, beforeFile: '/private/blob', afterFile: '/private/next' })) }
  } } }
  const frame = await handleWorkspaceChanges(api, query)
  assert.deepEqual(frame, { kind: query.type, requestId: 'request', sessionId: 'session', seq: 42, value: summary })
})

test('diff requests bind session, event sequence and file index and use a cancellation signal', async () => {
  const value = { kind: 'binary', path: 'assets/logo.png', display: 'assets/logo.png' }
  const api = { workspaceChanges: { summary: () => summary, async diff(id, seq, index, signal) {
    assert.deepEqual([id, seq, index], ['session', 42, 1]); assert.ok(signal instanceof AbortSignal)
    return value
  } } }
  const frame = await handleWorkspaceChanges(api, { ...query, type: 'workspace-changes-diff', index: 1 })
  assert.equal(frame.index, 1); assert.equal(frame.value, value)
  assert.equal((await handleWorkspaceChanges(api, { ...query, type: 'workspace-changes-diff', index: 2 })).value, null)
})

test('missing services, expired snapshots and malformed requests fail safely', async () => {
  assert.equal((await handleWorkspaceChanges({}, query)).code, 'workspace-changes-unavailable')
  const missing = { workspaceChanges: { summary() { return undefined }, diff() { throw Error('must not run') } } }
  for (const type of WORKSPACE_CHANGES_TYPES) {
    assert.equal((await handleWorkspaceChanges(missing, { ...query, type, index: 0 })).value, null)
  }
  for (const invalid of [{ requestId: '' }, { requestId: 'x'.repeat(129) }, { sessionId: ' ' },
    { sessionId: 'x'.repeat(513) }, { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'workspace-changes-diff', index: -1 }, { type: 'workspace-changes-diff', index: '0' }]) {
    assert.equal((await handleWorkspaceChanges(missing, { ...query, ...invalid })).code, 'bad-request')
  }
  const failed = await handleWorkspaceChanges({ workspaceChanges: { summary() { throw Error('/private/path') } } }, query)
  assert.equal(failed.code, 'workspace-changes-failed'); assert.ok(!failed.message.includes('/private'))
})
