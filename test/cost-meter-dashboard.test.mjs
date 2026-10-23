import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-quota-')), 'dashboard.json')
process.env.DSH_WEAPP_COST_DASHBOARD_FILE = settingsFile
// Keep real credentials out of the test run.
delete process.env.SILICONFLOW_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.OPENCODE_API_KEY
delete process.env.DEEPSEEK_API_KEY

const mod = await import('../lib/cost-meter-dashboard-bridge.mjs')
const { handleCostMeterWithDashboard, __test } = mod

function credentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'store' } : null },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}

function host(creds = credentials()) {
  return { get: name => name === 'credentials' ? creds : undefined }
}

const emptyApi = { sessions: { list: async () => [] } }

async function call(action, extra = {}, { api = emptyApi, creds = credentials() } = {}) {
  return handleCostMeterWithDashboard(api, { type: 'cost-meter', requestId: 'req-' + action, action, ...extra }, { hostContext: host(creds) })
}

async function fresh() {
  __test.dropQuotaCaches()
  try { fs.unlinkSync(settingsFile) } catch { /* first run */ }
}

test('settings update persists display, sidebar styles, sources and never leaks keys', async () => {
  await fresh()
  const res = await call('update', { patch: {
    currency: 'USD',
    symbol: '$',
    decimals: 4,
    exchangeRate: 7.1,
    display: { sidebarStyle: 'summary', sidebarVisible: true, peakStyle: 'classic' },
    balance: { enabled: true, display: 'sidebar', refreshMinutes: 10 },
    goQuota: { enabled: true, display: 'both', main: 'weekly', barDirection: 'remaining', detail: false },
    peak: { enabled: true, windows: [{ start: 2, end: 5 }], display: 'sidebar' },
    codingPlans: { siliconflow: { enabled: true, display: 'sidebar', refreshMinutes: 30 } },
    customBalances: [{ enabled: true, label: 'My API', unit: 'USD', display: 'both', request: { url: 'https://example.com/balance', headers: { authorization: 'Bearer {{MY_TOKEN}}' } }, extract: { remaining: 'data.remaining' } }],
    gatewayQuotas: { sources: [] },
  } })
  assert.equal(res.kind, 'cost-meter')
  const config = res.config
  assert.equal(config.currency, 'USD')
  assert.equal(config.symbol, '$')
  assert.equal(config.decimals, 4)
  assert.equal(config.display.sidebarStyle, 'summary')
  assert.equal(config.display.sidebarVisible, true)
  assert.equal(config.display.peakStyle, 'classic')
  assert.equal(config.goQuota.main, 'weekly')
  assert.equal(config.goQuota.barDirection, 'remaining')
  assert.equal(config.codingPlans.siliconflow.enabled, true)
  assert.equal(config.codingPlans.siliconflow.refreshMinutes, 30)
  assert.equal(config.customBalances.length, 1)
  assert.equal(config.customBalances[0].request.headers.authorization, 'Bearer {{MY_TOKEN}}')

  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(saved.version, 2)
  assert.doesNotMatch(JSON.stringify(saved), /secret-value|private-key/)
  assert.doesNotMatch(JSON.stringify(res), /secret-value|private-key/)
})

test('invalid settings are rejected instead of silently written', async () => {
  await fresh()
  const bad = async patch => {
    const res = await call('update', { patch })
    assert.equal(res.kind, 'error', JSON.stringify(patch))
  }
  // EUR 自对齐参考实现后成为受支持币种；用一个真正非法的币种验证拒绝路径。
  await bad({ currency: 'JPY' })
  await bad({ display: { sidebarStyle: 'huge' } })
  await bad({ display: { peakTimeDisplay: 'sometimes' } })
  await bad({ balance: { barDirection: 'sideways' } })
  await bad({ budget: { period: 'decade' } })
  await bad({ peak: { peakAlertAhead: 99 } })
  await bad({ customBalances: [{ request: { url: 'file:///etc/passwd' } }] })
  await bad({ customBalances: new Array(9).fill({ request: { url: 'https://a.test/x' } }) })
})

test('EUR currency and the newly aligned display fields persist', async () => {
  await fresh()
  const res = await call('update', { patch: {
    currency: 'EUR',
    display: { peakTimeDisplay: 'countdown', sidebarTodayMetric: 'tokens', sidebarTodayBalanceInline: true },
    balance: { showProgressBar: true, barDirection: 'used' },
    budget: { period: 'custom', customStart: '2026-10-01', customEnd: '2026-10-31', detail: false, barDirection: 'remaining' },
    peak: { peakAlertEnabled: true, peakAlertAhead: 5, peakAlertTarget: 'peak', peakAlertPosition: 'center' },
  } })
  assert.notEqual(res.kind, 'error', res.message || '')
  assert.equal(res.config.currency, 'EUR')
  assert.equal(res.config.display.peakTimeDisplay, 'countdown')
  assert.equal(res.config.display.sidebarTodayMetric, 'tokens')
  assert.equal(res.config.display.sidebarTodayBalanceInline, true)
  assert.equal(res.config.balance.showProgressBar, true)
  assert.equal(res.config.balance.barDirection, 'used')
  assert.equal(res.config.budget.period, 'custom')
  assert.equal(res.config.budget.customStart, '2026-10-01')
  assert.equal(res.config.budget.customEnd, '2026-10-31')
  assert.equal(res.config.budget.detail, false)
  assert.equal(res.config.budget.barDirection, 'remaining')
  assert.equal(res.config.peak.peakAlertEnabled, true)
  assert.equal(res.config.peak.peakAlertAhead, 5)
  assert.equal(res.config.peak.peakAlertTarget, 'peak')
  assert.equal(res.config.peak.peakAlertPosition, 'center')
})

test('coding plan uses the configured credential and reports normalized windows', async () => {
  await fresh()
  const creds = credentials({ SILICONFLOW_API_KEY: 'sk-test-key' })
  await call('update', { patch: { codingPlans: { siliconflow: { enabled: true, display: 'settings', refreshMinutes: 5 } } } }, { creds })
  let calls = 0
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    calls += 1
    assert.match(String(url), /api\.siliconflow\.cn/)
    return { ok: true, status: 200, json: async () => ({ data: { balance: 12.5 } }) }
  }
  try {
    const res = await call('refresh', {}, { creds })
    const plan = res.dashboard.plans.find(item => item.id === 'siliconflow')
    assert.equal(plan.status, 'ok')
    assert.ok(plan.windows && plan.windows.balance)
    assert.equal(calls, 1)
    assert.doesNotMatch(JSON.stringify(res), /sk-test-key/, 'credentials never cross the wire')
  } finally { globalThis.fetch = previous }
})

test('SCNet local estimate folds per-model usage from session projections', async () => {
  await fresh()
  await call('update', { patch: { codingPlans: { scnet: { enabled: true, display: 'settings', planCredits: 10000 } } } })
  const today = new Date()
  const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 1_000_000, calls: 1 }
  const api = {
    sessions: {
      list: async () => [{
        sessionId: 's1',
        projections: { values: { costMeter: {
          v: 2,
          days: { [dayKey]: { byProviderModel: { 'scnet:GLM-5.2': bucket } } },
          months: {}, total: bucket, lastTime: Date.now(),
        } } },
      }],
    },
  }
  const res = await call('refresh', {}, { api })
  const plan = res.dashboard.plans.find(item => item.id === 'scnet')
  assert.equal(plan.status, 'ok')
  assert.ok(plan.estimate.used > 7000)
  assert.ok(plan.windows.monthly.percent > 70)
})

test('custom provider balance is fetched through the configurable HTTP extract rules', async () => {
  await fresh()
  await call('update', { patch: { customBalances: [{
    enabled: true, label: 'Provider', unit: 'USD', display: 'both', refreshMinutes: 5,
    request: { url: 'https://api.example.test/me', method: 'GET' },
    extract: { remaining: 'data.remaining', maxBudget: 'data.limit' },
  }] } })
  const previous = globalThis.fetch
  let auth = ''
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.example.test/me')
    auth = (init && init.headers && init.headers.authorization) || ''
    return { ok: true, status: 200, json: async () => ({ data: { remaining: 42.5, limit: 100 } }) }
  }
  try {
    const res = await call('refresh')
    const entry = res.dashboard.customBalances[0]
    assert.equal(entry.status, 'ok')
    assert.equal(entry.remaining, 42.5)
    assert.equal(entry.maxBudget, 100)
    assert.equal(entry.percent, 42.5)
    assert.equal(auth, '')
  } finally { globalThis.fetch = previous }
})

test('official balance exposes granted and topped-up amounts', async () => {
  await fresh()
  const api = {
    sessions: { list: async () => [] },
    account: {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: 10 }],
        bonusWallets: [{ currency: 'CNY', balance: 2 }],
      }),
    },
  }
  const res = await call('summary', {}, { api })
  assert.equal(res.dashboard.balance.status, 'ok')
  assert.equal(res.dashboard.balance.totalBalance, 12)
  assert.equal(res.dashboard.balance.granted, 2)
  assert.equal(res.dashboard.balance.toppedUp, 10)
})

test('source keys are written to the credential store only', async () => {
  await fresh()
  const creds = credentials()
  await call('update', { patch: { codingPlans: { zai: { enabled: true, display: 'settings' } } } }, { creds })
  const saved = await call('set-source-key', { source: 'plan:zai', value: 'zai-secret-key' }, { creds })
  assert.equal(saved.kind, 'cost-meter')
  assert.equal(creds.store.get('ZAI_API_KEY'), 'zai-secret-key')
  const config = await call('config', {}, { creds })
  assert.doesNotMatch(JSON.stringify(config), /zai-secret-key/)
  const plan = config.sources.plans.find(item => item.id === 'zai')
  assert.equal(plan.configured, true)
  const cleared = await call('clear-source-key', { source: 'plan:zai' }, { creds })
  assert.equal(cleared.kind, 'cost-meter')
  assert.equal(creds.store.has('ZAI_API_KEY'), false)
})

test('gateway sources reject hosts outside the explicit allowlist', async () => {
  await fresh()
  const rejected = await call('update', { patch: { gatewayQuotas: { sources: [{
    id: 'gw1', type: 'cliproxyapi', baseURL: 'https://gateway.example.test',
  }] } } })
  assert.equal(rejected.kind, 'error')
  const ok = await call('update', { patch: { gatewayQuotas: { sources: [{
    id: 'gw1', type: 'cliproxyapi', baseURL: 'https://gateway.example.test',
    allowedHosts: ['gateway.example.test'], enabled: true, display: 'both',
  }] } } })
  assert.equal(ok.config.gatewayQuotas.sources[0].id, 'gw1')
})
