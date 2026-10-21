import assert from 'node:assert/strict'
import { ACCOUNT_REQUEST_TYPES, handleAccount } from '../lib/account-bridge.mjs'

assert.ok(ACCOUNT_REQUEST_TYPES.has('account'))

const state = { signedIn: true, userId: 'u-1' }
const profile = { name: '测试用户' }
const balance = { currency: 'CNY', total: 12 }
const lookups = []
const api = {
  account: {
    async getState() { return state },
    async getProfile(client) { lookups.push(['profile', client]); return profile },
    async getBalance(client) { lookups.push(['balance', client]); return balance },
  },
}

// Paired client: state plus localized profile and balance, echoing requestId.
assert.deepEqual(
  await handleAccount(api, { requestId: 'req-1', client: { version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28800 } }),
  { kind: 'account', requestId: 'req-1', state, profile, balance },
)
assert.deepEqual(lookups, [
  ['profile', { version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28800 }],
  ['balance', { version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28800 }],
])

// No client: only the host account state is read.
lookups.length = 0
assert.deepEqual(
  await handleAccount(api, { requestId: 'req-2' }),
  { kind: 'account', requestId: 'req-2', state, profile: null, balance: null },
)
assert.equal(lookups.length, 0)

// A client without a usable version is ignored; bad locale/offset fall back to defaults.
lookups.length = 0
assert.deepEqual(
  await handleAccount(api, { requestId: 'req-3', client: { locale: 'zh', timezoneOffsetSeconds: 'bad' } }),
  { kind: 'account', requestId: 'req-3', state, profile: null, balance: null },
)
assert.equal(lookups.length, 0)

const echoApi = {
  account: {
    async getState() { return null },
    async getProfile(client) { return client },
    async getBalance() { return null },
  },
}
assert.deepEqual(
  (await handleAccount(echoApi, { requestId: 'req-4', client: { version: '9.9.9', locale: '', timezoneOffsetSeconds: 1.9 } })).profile,
  { version: '9.9.9', locale: 'en', timezoneOffsetSeconds: 1 },
)

// Missing requestId is rejected before touching the account service.
assert.deepEqual(
  await handleAccount(api, { client: { version: '1.0.0' } }),
  { kind: 'error', requestType: 'account', code: 'bad-request', message: 'account requires a requestId' },
)

// Hosts without an account service degrade instead of throwing.
assert.deepEqual(
  await handleAccount({}, { requestId: 'req-5' }),
  { kind: 'error', requestType: 'account', requestId: 'req-5', code: 'account-unavailable', message: 'Account service is unavailable on this host' },
)

// A state lookup that throws before returning a promise is reported as unavailable.
const broken = { account: { getState() { throw new Error('boom') } } }
assert.deepEqual(
  await handleAccount(broken, { requestId: 'req-6' }),
  { kind: 'error', requestType: 'account', requestId: 'req-6', code: 'account-unavailable', message: 'Account information is unavailable' },
)

// A rejected state promise is swallowed into null; profile/balance failures stay null per field.
const partial = {
  account: {
    async getState() { return Promise.reject(new Error('offline')) },
    async getProfile() { throw new Error('no profile') },
    async getBalance() { return balance },
  },
}
assert.deepEqual(
  await handleAccount(partial, { requestId: 'req-7', client: { version: '2.0.0' } }),
  { kind: 'account', requestId: 'req-7', state: null, profile: null, balance },
)

// requestId is truncated to the documented 128 character limit.
const long = 'x'.repeat(200)
const truncated = await handleAccount(api, { requestId: long })
assert.equal(truncated.requestId.length, 128)
assert.equal(truncated.requestId, long.slice(0, 128))

console.log('account bridge tests passed')
