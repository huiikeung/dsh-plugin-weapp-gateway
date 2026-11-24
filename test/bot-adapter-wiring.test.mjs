import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshHostAdapter } from '../lib/dsh-host-adapter.mjs'
import { createTestPeer } from './helpers/peer.mjs'

// 网关侧 Bot 桥接线：宿主动适配器必须真的把 bot 通道接到固定 /api/bot 路由，
// 并把 send-attachments 落到官方会话提交入口。

function makeHarness() {
  const requests = []
  const invoked = []
  const handler = {
    requestBodyMode: () => 'streaming',
    async fetch(request, peer) {
      const body = await request.text()
      requests.push({ url: request.url, body, peer })
      if (request.url.endsWith('/api/bot/feed')) {
        return new Response('event: message\ndata: {"hello":{"api":1}}\n\n', { status: 200 })
      }
      const msg = JSON.parse(body)
      const value = msg.endpoint === 'state'
        ? { readOnly: false, bots: [{ id: 'chief', sessionId: 'session-1' }], rooms: [] }
        : { api: 1, capabilities: ['chat'] }
      return new Response(JSON.stringify({ ok: true, value }), { status: 200 })
    },
  }
  const connection = { createSharedFetchHandler: (prefix) => { assert.equal(prefix, '/api'); return handler } }
  const gateway = {
    async invoke(args) { invoked.push(args); return { ok: true } },
    async stream() { return [] },
  }
  return { requests, invoked, connection, gateway }
}

test('host adapter exposes the bot channel on the fixed local route', async () => {
  const { requests, connection, gateway } = makeHarness()
  const api = createDshHostAdapter(gateway, createTestPeer(), connection, {
    runtimeVersion: '0.2.2-rc.5',
    parseWireImages: () => ({ value: [] }),
  })
  assert.ok(api.bot, 'adapter must expose bot')
  const bot = api.bot.forConnection()
  const hello = await bot.call('hello', { api: [1] })
  assert.equal(hello.api, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://localhost/api/bot')
  assert.deepEqual(JSON.parse(requests[0].body), { endpoint: 'hello', payload: { api: [1] } })
})

test('send-attachments submits through the official session prompt', async () => {
  const { invoked, connection, gateway } = makeHarness()
  const api = createDshHostAdapter(gateway, createTestPeer(), connection, {
    runtimeVersion: '0.2.2-rc.5',
    parseWireImages: () => ({ value: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }] }),
  })
  const bot = api.bot.forConnection()
  const value = await bot.call('send-attachments', {
    chatId: 'chief', sessionId: 'session-1', text: 'hi',
    images: [{ mediaType: 'image/png', data: 'AA==' }], receipts: ['receipt-1'],
  })
  assert.equal(value, true)
  const prompt = invoked.find(item => item.namespace === 'session' && item.method === 'prompt')
  assert.ok(prompt, 'must call session/prompt')
  assert.equal(prompt.args.request.mode, 'queue')
  assert.equal(prompt.args.request.sessionId, 'session-1')
  const content = prompt.args.request.content
  assert.deepEqual(content[0], { type: 'text', text: 'hi' })
  assert.equal(content[1].type, 'image')
  assert.deepEqual(content[2], { type: 'file', receiptId: 'receipt-1' })
})

test('image endpoint goes through the wired image bridge before reading', async () => {
  const { requests, connection, gateway } = makeHarness()
  const api = createDshHostAdapter(gateway, createTestPeer(), connection, {
    runtimeVersion: '0.2.2-rc.5',
    parseWireImages: () => ({ value: [] }),
  })
  const bot = api.bot.forConnection()
  await assert.rejects(() => bot.call('image', { chatId: 'chief', attachmentId: 'missing' }))
  assert.ok(requests.some(item => JSON.parse(item.body).endpoint === 'state'),
    'image read must first resolve public state')
})

test('existing adapter surfaces stay intact', async () => {
  const { invoked, connection, gateway } = makeHarness()
  const api = createDshHostAdapter(gateway, createTestPeer(), connection, { runtimeVersion: '0.2.2-rc.5' })
  assert.equal(typeof api.sessions.prompt, 'function')
  assert.equal(typeof api.files.stat, 'function')
  await api.files.stat({ sessionId: 'session-1', path: 'a.txt' })
  assert.ok(invoked.some(item => item.namespace === 'workspaceFiles' && item.method === 'stat'))
})
