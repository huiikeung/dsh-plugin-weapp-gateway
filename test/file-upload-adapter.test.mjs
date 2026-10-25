import assert from 'node:assert/strict'
import { createDshHostAdapter } from '../lib/dsh-host-adapter.mjs'

const peerAbort = new AbortController()
const peer = { id: 'test-peer', principal: { kind: 'owner' }, interactions: 'none', signal: peerAbort.signal,
  async dispose() { peerAbort.abort() } }
let requestSeen
let peerSeen
const connection = {
  createPeer(options) {
    assert.deepEqual(options, { principal: { kind: 'owner' }, interactions: 'none' })
    return peer
  },
  createSharedFetchHandler(prefix) {
    assert.equal(prefix, '/api')
    return {
      requestBodyMode({ method, url }) {
        assert.equal(method, 'POST')
        assert.equal(url.pathname, '/api/session/uploadFileBinary')
        return 'streaming'
      },
      async fetch(request, passedPeer) {
        requestSeen = request
        peerSeen = passedPeer
        const bytes = Buffer.from(await request.arrayBuffer())
        return Response.json({ ok: true, value: { receiptId: 'receipt-1', file: {
          attachmentId: 'opaque-file', name: 'report.pdf', bytes: bytes.length,
        } } })
      },
    }
  },
}
const adapter = createDshHostAdapter({ invoke: async () => ({}), stream: async () => (async function* () {})() }, connection)
assert.equal(adapter.files.available(), true)
const uploaded = await adapter.files.upload({ sessionId: 's1', name: 'report.pdf',
  data: (async function* () { yield Buffer.from('pdf-bytes') })() })
assert.equal(uploaded.receiptId, 'receipt-1')
const requestUrl = new URL(requestSeen.url)
assert.equal(requestUrl.searchParams.get('sessionId'), 's1')
assert.equal(requestUrl.searchParams.get('name'), 'report.pdf')
assert.equal(requestSeen.headers.get('content-type'), 'application/octet-stream')
assert.equal(peerSeen, peer)
await adapter.dispose()
assert.equal(peer.signal.aborted, true)

const unavailable = createDshHostAdapter({ invoke: async () => ({}), stream: async () => (async function* () {})() })
assert.equal(unavailable.files.available(), false)
await assert.rejects(() => unavailable.files.upload({ sessionId: 's1', name: 'a', data: [] }),
  { code: 'file-upload-unavailable' })
await unavailable.dispose()

console.log('FILE UPLOAD HOST ADAPTER TESTS PASSED')
