import assert from 'node:assert/strict'
import { createCompletionNotifications } from '../lib/completion-notifications.mjs'

const ticketA = 'a'.repeat(43)
const ticketB = 'b'.repeat(43)
const delay = () => new Promise(resolve => setTimeout(resolve, 0))

const sent = []
const notifications = createCompletionNotifications({
  serviceUrl: 'https://notify.example.test',
  fetchImpl: async (url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return { ok: true } },
})

const first = notifications.register('session-1', ticketA)
assert.ok(first)
notifications.onSessionEvent('session-1', { type: 'turn/start', seq: 1, data: { turn: 0 } })
notifications.onSessionEvent('session-1', { type: 'turn/end', seq: 2, data: { turn: 0 } })
await delay()
assert.equal(sent.length, 1)
assert.equal(sent[0].body.ticket, ticketA)
assert.deepEqual(sent[0].body, { ticket: ticketA, sessionId: 'session-1', status: 'completed' })

// A queued mobile task must not be notified when the currently running desktop task ends.
notifications.onSessionEvent('session-2', { type: 'turn/start', seq: 3, data: { turn: 4 } })
notifications.register('session-2', ticketB, 'queue')
notifications.onSessionEvent('session-2', { type: 'turn/end', seq: 4, data: { turn: 4 } })
await delay()
assert.equal(sent.length, 1)
notifications.onSessionEvent('session-2', { type: 'turn/start', seq: 5, data: { turn: 5 } })
notifications.onSessionEvent('session-2', { type: 'turn/end', seq: 6, data: { turn: 5 } })
await delay()
assert.equal(sent.length, 2)
assert.equal(sent[1].body.ticket, ticketB)

const steerTicket = 'c'.repeat(43)
notifications.onSessionEvent('session-3', { type: 'turn/start', seq: 7, data: { turn: 8 } })
notifications.register('session-3', steerTicket, 'steer')
notifications.onSessionEvent('session-3', { type: 'turn/end', seq: 8, data: { turn: 8 } })
await delay()
assert.equal(sent.length, 3)
assert.equal(sent[2].body.ticket, steerTicket)

const fallbackTicket = 'e'.repeat(43)
notifications.register('session-5', fallbackTicket)
notifications.onSessionEvent('session-5', { type: 'turn/start', seq: 10 })
notifications.onSessionEvent('session-5', { type: 'turn/end', seq: 11 })
await delay()
assert.equal(sent.length, 4)
assert.equal(sent[3].body.ticket, fallbackTicket)

const discarded = notifications.register('session-4', 'd'.repeat(43))
notifications.discard('session-4', discarded)
notifications.onSessionEvent('session-4', { type: 'turn/start', seq: 9, data: { turn: 9 } })
notifications.onSessionEvent('session-4', { type: 'turn/end', seq: 10, data: { turn: 9 } })
await delay()
assert.equal(sent.length, 4)

assert.throws(() => createCompletionNotifications({ serviceUrl: 'http://attacker.example' }), /HTTPS/)
console.log('Completion notification tests passed')
