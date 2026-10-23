/**
 * Native quota dashboard for the WeChat gateway.
 *
 * Integrates the useful quota sources of the dsh-cost-meter plugin WITHOUT
 * requiring that plugin: official DeepSeek balance, OpenCode Go, the Coding
 * Plan vendors, CLIProxyAPI gateway quotas and configurable custom Provider
 * balances all live in the gateway. The mini program only talks to these
 * actions.
 *
 * Wire (mobile -> gateway):
 *   { type:'cost-meter', requestId, action, patch?, ...actionArgs }
 * Actions:
 *   summary | config | refresh | update | refresh-source | source-config
 *   set-source-key | clear-source-key
 *   set-go-key | clear-go-key | set-balance-key | clear-balance-key (legacy)
 *
 * Secrets are written to the DSH credential store only. The persisted settings
 * file never contains a key value, and responses only expose `configured`
 * booleans.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { handleCostMeter as handleBaseCostMeter, collectUsageDays } from './cost-meter-bridge.mjs'
import {
  CODING_PLAN_PROVIDER_IDS,
  queryCodingPlan,
  normalizeMiniMaxBaseUrl,
  scnetTokenPlanWindows,
  qwenTokenPlanWindows,
  scnetCanonModelId,
  SCNET_CREDIT_RATES,
  QWEN_CREDIT_RATES,
} from './vendor/cost-meter/coding-plans.mjs'
import { queryCustomBalance } from './vendor/cost-meter/custom-balance.mjs'
import {
  queryGatewayQuota,
  normalizeGatewaySource,
  validateGatewaySource,
  managementKeyVarOf,
} from './vendor/cost-meter/gateway-quotas.mjs'

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const GO_KEY_REF = 'OPENCODE_GO_API_KEY'
const BALANCE_API_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_KEY_REF = 'DSH_WEAPP_DEEPSEEK_BALANCE_API_KEY'
const CUSTOM_KEY_PREFIX = 'WEAPP_CUSTOM_BALANCE_'
const MAX_CUSTOM_BALANCES = 8
const MAX_GATEWAY_SOURCES = 4
const DISPLAYS = ['sidebar', 'settings', 'both', 'off']
const SIDEBAR_STYLES = ['summary', 'simple', 'standard', 'compact']
const CUSTOM_ADAPTERS = ['custom', 'aliyun', 'tokenrhythm']
const CURRENCIES = ['CNY', 'USD', 'EUR']
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }
const BAR_DIRECTIONS = ['used', 'remaining']
const PEAK_TIME_DISPLAYS = ['both', 'countdown', 'switch']
const PEAK_ALERT_TARGETS = ['both', 'peak', 'offpeak']
const PEAK_ALERT_POSITIONS = ['corner', 'center']
const DEFAULT_PEAK_WINDOWS = Object.freeze([{ start: 1, end: 4 }, { start: 6, end: 10 }])
/** 侧栏卡片栈可排序的键：固定分区 + plan:<id> / gateway:<sourceId>。 */
const SIDEBAR_ORDER_KEYS = ['balance', 'customBalance', 'today', 'peak', 'models', 'go', 'budget', 'codex']
const MAX_SIDEBAR_ORDER = 64
const SESSION_COST_POSITIONS = ['dock', 'header', 'off']

const DEFAULT_SETTINGS = Object.freeze({
  currency: 'CNY',
  symbol: '¥',
  exchangeRate: 7.2,
  exchangeRateAuto: false,
  decimals: 3,
  display: {
    sidebarStyle: 'standard', sidebarVisible: false, sidebarTodayMetric: 'both', peakStyle: 'progress',
    peakTimeDisplay: 'both', sidebarTodayBalanceInline: false,
  },
  balance: { enabled: true, display: 'both', refreshMinutes: 5, showProgressBar: false, barDirection: 'remaining' },
  goQuota: { enabled: false, display: 'both', refreshMinutes: 15, detail: true, main: 'rolling', barDirection: 'used' },
  peak: {
    enabled: true, display: 'both', effectiveAt: '', windows: DEFAULT_PEAK_WINDOWS, holidays: [],
    peakAlertEnabled: false, peakAlertAhead: 2, peakAlertTarget: 'both', peakAlertPosition: 'corner',
  },
  budget: { display: 'both', enabled: false, amount: 100, period: 'month', customStart: '', customEnd: '', detail: true, barDirection: 'used' },
  codingPlans: {},
  customBalances: [],
  gatewayQuotas: { sources: [] },
  sidebarOrder: [],
  quotaStrip: { enabled: false, budget: true, go: true, plans: true },
  corner: { enabled: false, goRolling: true, goWeekly: true, goMonthly: true, budget: true },
  sessionCost: { position: 'off', compact: false, hideTurnCost: false, hideHeader: false, hideDock: false },
})

/** Vendor order mirrors the plugin's quota page. */
const PLAN_LABELS = {
  opendesign: 'OpenDesign',
  factory: 'Factory (Droid)',
  anthropic: 'Anthropic Claude',
  zai: 'Z.ai / 智谱 GLM',
  minimax: 'MiniMax Token Plan',
  kimi: 'Kimi / Moonshot',
  openrouter: 'OpenRouter',
  siliconflow: 'SiliconFlow 硅基流动',
  commandcode: 'CommandCode',
  clinepass: 'Cline Pass',
  scnet: 'SCNet Token Plan',
  volcengine: '火山方舟 Coding Plan',
  qwen: '千问 Token Plan',
  mimo: '小米 MiMo Token Plan',
  workbuddy: 'WorkBuddy 积分',
}

/** Credential refs resolved from the DSH credential store or the environment. */
const PLAN_KEY_REFS = {
  opendesign: ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'],
  factory: ['FACTORY_API_KEY'],
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  zai: ['ZAI_API_KEY', 'BIGMODEL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  kimi: ['KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  commandcode: ['COMMANDCODE_API_KEY'],
  clinepass: ['CLINE_PASS_API_KEY'],
  scnet: [],
  volcengine: ['VOLC_ACCESSKEY', 'VOLCENGINE_ACCESS_KEY_ID', 'VOLCENGINE_ACCESS_KEY', 'ARK_ACCESS_KEY_ID'],
  qwen: [],
  mimo: ['MIMO_COOKIE', 'XIAOMI_MIMO_COOKIE'],
  workbuddy: [],
}
const VOLC_SECRET_REFS = ['VOLC_SECRETKEY', 'VOLCENGINE_SECRET_ACCESS_KEY', 'VOLCENGINE_SECRET_KEY', 'ARK_SECRET_ACCESS_KEY']
const PLAN_EXTRA_FIELDS = {
  opendesign: ['workspaceId'],
  factory: ['orgId', 'factoryPool'],
  minimax: ['baseUrl'],
  scnet: ['planCredits', 'planStart'],
  qwen: ['planCredits', 'planStart'],
}

const SCNET_MODELS = new Set(Object.keys(SCNET_CREDIT_RATES).map(scnetCanonModelId))
const QWEN_MODELS = new Set(Object.keys(QWEN_CREDIT_RATES).map(scnetCanonModelId))

const GO_CACHE_TTL_MS = 60_000
const BALANCE_CACHE_TTL_MS = 60_000
let goCache = { at: 0, value: null }
let balanceCache = { at: 0, value: null }
const sourceCache = new Map()

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function settingsFile() {
  if (process.env.DSH_WEAPP_COST_DASHBOARD_FILE) return process.env.DSH_WEAPP_COST_DASHBOARD_FILE
  const configuredHome = String(process.env.DSH_HOME || '').trim()
  const dshHome = configuredHome === '~' ? os.homedir()
    : configuredHome.startsWith('~/') ? path.join(os.homedir(), configuredHome.slice(2))
      : configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'storages', 'weapp-cost-dashboard.json')
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Bound host projection reads so a slow account service cannot time out the whole config request. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ])
}

function displayOf(value, fallback = 'both') {
  return DISPLAYS.includes(value) ? value : fallback
}

function refreshOf(value, fallback = 15) {
  const n = Math.floor(Number(value))
  return Number.isInteger(n) ? Math.max(1, Math.min(1440, n)) : fallback
}

function normalizePeakWindows(rows) {
  const windows = Array.isArray(rows) ? rows
    .filter(row => row && Number.isInteger(row.start) && row.start >= 0 && row.start <= 23
      && Number.isInteger(row.end) && row.end >= 0 && row.end <= 24 && row.start !== row.end)
    .slice(0, 8).map(row => ({ start: row.start, end: row.end })) : []
  return windows.length ? windows : DEFAULT_PEAK_WINDOWS.map(row => ({ ...row }))
}

function normalizeCustomEntry(raw) {
  const input = record(raw) || {}
  const request = record(input.request) || {}
  const extract = record(input.extract) || {}
  const headers = {}
  for (const [name, value] of Object.entries(record(request.headers) || {})) {
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name)) continue
    if (typeof value !== 'string' || value.length > 1024) continue
    headers[name] = value
  }
  const allowedHosts = Array.isArray(input.allowedHosts)
    ? [...new Set(input.allowedHosts.map(item => text(item).toLowerCase()).filter(Boolean))].slice(0, 16) : []
  const adapter = CUSTOM_ADAPTERS.includes(input.adapter) ? input.adapter : 'custom'
  const method = ['GET', 'POST'].includes(String(request.method || '').toUpperCase())
    ? String(request.method).toUpperCase() : 'GET'
  const copyRule = rule => {
    if (typeof rule === 'string' && rule.trim()) return rule.trim().slice(0, 200)
    const value = record(rule)
    if (!value) return ''
    if (Array.isArray(value.paths) && value.paths.every(item => typeof item === 'string')) {
      return { op: value.op === 'add' ? 'add' : 'subtract', paths: value.paths.map(item => item.slice(0, 200)).slice(0, 4) }
    }
    return ''
  }
  return {
    enabled: input.enabled === true,
    adapter,
    label: text(input.label).slice(0, 40),
    unit: text(input.unit).slice(0, 16) || 'USD',
    display: displayOf(input.display),
    refreshMinutes: refreshOf(input.refreshMinutes, 15),
    convertToDisplayCurrency: input.convertToDisplayCurrency === true,
    allowInsecureHttp: input.allowInsecureHttp === true,
    allowedHosts,
    secretHeader: text(input.secretHeader).slice(0, 80),
    request: {
      url: text(request.url).slice(0, 2048),
      method,
      headers,
      ...(typeof request.body === 'string' && request.body.length <= 8192
        ? { body: request.body }
        : request.body !== undefined && request.body !== null && typeof request.body === 'object'
          ? { body: request.body } : {}),
    },
    extract: {
      remaining: copyRule(extract.remaining),
      maxBudget: copyRule(extract.maxBudget),
      spend: copyRule(extract.spend),
      ...(typeof extract.unit === 'string' && extract.unit.trim() ? { unit: extract.unit.trim().slice(0, 16) } : {}),
    },
  }
}

function normalizePlanSettings(id, raw) {
  const input = record(raw) || {}
  const extra = PLAN_EXTRA_FIELDS[id] || []
  const settings = {
    enabled: input.enabled === true,
    display: displayOf(input.display),
    refreshMinutes: refreshOf(input.refreshMinutes, 15),
  }
  if (extra.includes('workspaceId')) settings.workspaceId = text(input.workspaceId).slice(0, 128)
  if (extra.includes('orgId')) settings.orgId = text(input.orgId).slice(0, 128)
  if (extra.includes('factoryPool')) settings.factoryPool = ['standard', 'enterprise'].includes(input.factoryPool) ? input.factoryPool : 'standard'
  if (extra.includes('baseUrl')) {
    const normalized = normalizeMiniMaxBaseUrl(input.baseUrl)
    settings.baseUrl = normalized === null ? '' : normalized
  }
  if (extra.includes('planCredits')) {
    const credits = Number(input.planCredits)
    settings.planCredits = Number.isFinite(credits) && credits > 0 ? credits : 0
    settings.planStart = typeof input.planStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.planStart) ? input.planStart : ''
  }
  return settings
}

/** 侧栏排序键：固定分区名或 plan:<id> / gateway:<sourceId>，去重且限长。 */
function normalizeSidebarOrder(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const key = value.trim()
    if (!key || seen.has(key) || out.length >= MAX_SIDEBAR_ORDER) continue
    if (SIDEBAR_ORDER_KEYS.includes(key) || /^plan:[a-z0-9][a-z0-9_-]{0,47}$/.test(key) || /^gateway:[a-z0-9][a-z0-9_-]{0,47}$/.test(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

function normalizeSettings(raw) {
  const input = record(raw) || {}
  const go = record(input.goQuota) || {}
  const peak = record(input.peak) || {}
  const display = record(input.display) || {}
  const balance = record(input.balance) || {}
  const budget = record(input.budget) || {}
  const quotaStrip = record(input.quotaStrip) || {}
  const corner = record(input.corner) || {}
  const sessionCost = record(input.sessionCost) || {}
  const codingPlans = {}
  for (const id of CODING_PLAN_PROVIDER_IDS) {
    const saved = record((record(input.codingPlans) || {})[id])
    if (saved) codingPlans[id] = normalizePlanSettings(id, saved)
  }
  const customBalances = Array.isArray(input.customBalances)
    ? input.customBalances.slice(0, MAX_CUSTOM_BALANCES).map(normalizeCustomEntry) : []
  const rawSources = record(input.gatewayQuotas)
  const gatewaySources = Array.isArray(rawSources && rawSources.sources)
    ? rawSources.sources.slice(0, MAX_GATEWAY_SOURCES).map(source => {
      try { return normalizeGatewaySource(source) } catch { return null }
    }).filter(Boolean)
    : []
  return {
    currency: CURRENCIES.includes(input.currency) ? input.currency : 'CNY',
    symbol: typeof input.symbol === 'string' && input.symbol.trim() && input.symbol.trim().length <= 8
      ? input.symbol.trim() : CURRENCY_SYMBOLS[CURRENCIES.includes(input.currency) ? input.currency : 'CNY'],
    exchangeRate: Math.max(0.01, Math.min(1000, finite(input.exchangeRate, DEFAULT_SETTINGS.exchangeRate))),
    exchangeRateAuto: input.exchangeRateAuto === true,
    decimals: Math.max(2, Math.min(6, Math.floor(finite(input.decimals, DEFAULT_SETTINGS.decimals)))),
    display: {
      sidebarStyle: SIDEBAR_STYLES.includes(display.sidebarStyle) ? display.sidebarStyle : 'standard',
      sidebarVisible: display.sidebarVisible === true,
      sidebarTodayMetric: ['amount', 'tokens', 'both'].includes(display.sidebarTodayMetric) ? display.sidebarTodayMetric : 'both',
      peakStyle: display.peakStyle === 'classic' ? 'classic' : 'progress',
      peakTimeDisplay: PEAK_TIME_DISPLAYS.includes(display.peakTimeDisplay) ? display.peakTimeDisplay : 'both',
      sidebarTodayBalanceInline: display.sidebarTodayBalanceInline === true,
    },
    balance: {
      enabled: balance.enabled !== false,
      display: displayOf(balance.display),
      refreshMinutes: refreshOf(balance.refreshMinutes, 5),
      showProgressBar: balance.showProgressBar === true,
      barDirection: BAR_DIRECTIONS.includes(balance.barDirection) ? balance.barDirection : 'remaining',
    },
    goQuota: {
      enabled: go.enabled === true,
      display: displayOf(go.display),
      refreshMinutes: refreshOf(go.refreshMinutes, 15),
      detail: go.detail !== false,
      main: ['weekly', 'monthly'].includes(go.main) ? go.main : 'rolling',
      barDirection: BAR_DIRECTIONS.includes(go.barDirection) ? go.barDirection : 'used',
    },
    peak: {
      enabled: peak.enabled !== false,
      display: displayOf(peak.display),
      effectiveAt: typeof peak.effectiveAt === 'string' ? peak.effectiveAt.slice(0, 32) : '',
      windows: normalizePeakWindows(peak.windows),
      holidays: Array.isArray(peak.holidays)
        ? peak.holidays.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)).slice(0, 100) : [],
      peakAlertEnabled: peak.peakAlertEnabled === true,
      peakAlertAhead: Math.max(1, Math.min(30, Math.floor(finite(peak.peakAlertAhead, 2)))),
      peakAlertTarget: PEAK_ALERT_TARGETS.includes(peak.peakAlertTarget) ? peak.peakAlertTarget : 'both',
      peakAlertPosition: PEAK_ALERT_POSITIONS.includes(peak.peakAlertPosition) ? peak.peakAlertPosition : 'corner',
    },
    budget: {
      display: displayOf(budget.display),
      enabled: budget.enabled === true,
      amount: Math.max(0, finite(budget.amount, 100)),
      period: ['day', 'month', 'all', 'custom'].includes(budget.period) ? budget.period : 'month',
      customStart: typeof budget.customStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.customStart) ? budget.customStart : '',
      customEnd: typeof budget.customEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.customEnd) ? budget.customEnd : '',
      detail: budget.detail !== false,
      barDirection: BAR_DIRECTIONS.includes(budget.barDirection) ? budget.barDirection : 'used',
    },
    codingPlans,
    customBalances,
    gatewayQuotas: { sources: gatewaySources },
    sidebarOrder: normalizeSidebarOrder(input.sidebarOrder),
    quotaStrip: {
      enabled: quotaStrip.enabled === true,
      budget: quotaStrip.budget !== false,
      go: quotaStrip.go !== false,
      plans: quotaStrip.plans !== false,
    },
    corner: {
      enabled: corner.enabled === true,
      goRolling: corner.goRolling !== false,
      goWeekly: corner.goWeekly !== false,
      goMonthly: corner.goMonthly !== false,
      budget: corner.budget !== false,
    },
    sessionCost: {
      position: SESSION_COST_POSITIONS.includes(sessionCost.position) ? sessionCost.position : 'off',
      compact: sessionCost.compact === true,
      hideTurnCost: sessionCost.hideTurnCost === true,
      hideHeader: sessionCost.hideHeader === true,
      hideDock: sessionCost.hideDock === true,
    },
  }
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    return normalizeSettings(parsed && parsed.settings)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

function writeSettings(settings) {
  const file = settingsFile()
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify({ version: 2, updatedAt: Date.now(), settings }, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    return true
  } catch {
    try { fs.unlinkSync(temp) } catch { /* ignore cleanup errors */ }
    return false
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function credentialService(hostContext) {
  try { return hostContext && typeof hostContext.get === 'function' ? hostContext.get('credentials') : null }
  catch { return null }
}

function normalizeKey(value) {
  if (typeof value !== 'string') return null
  const key = value.trim().replace(/^Bearer[ \t]+/i, '').trim()
  return key && /^[\x21-\x7e]+$/.test(key) ? key : null
}

async function resolveRef(hostContext, ref) {
  const credentials = credentialService(hostContext)
  try {
    const hit = await credentials?.resolve?.(ref)
    const value = normalizeKey(hit?.value)
    if (value) return value
  } catch { /* fall through to env */ }
  return normalizeKey(process.env[ref])
}

async function resolveFirstRef(hostContext, refs) {
  for (const ref of refs || []) {
    const value = await resolveRef(hostContext, ref)
    if (value) return { value, ref }
  }
  return null
}

async function resolveVolcengineKeys(hostContext) {
  const access = await resolveFirstRef(hostContext, PLAN_KEY_REFS.volcengine)
  if (!access) return null
  const secret = await resolveFirstRef(hostContext, VOLC_SECRET_REFS)
  if (!secret) return null
  return { accessKeyId: access.value, secretAccessKey: secret.value }
}

/** Reads the Claude Code OAuth token file when no credential/env token is set. */
function claudeOauthToken() {
  const files = [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json') : '',
  ].filter(Boolean)
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const token = normalizeKey(parsed?.claudeAiOauth?.accessToken || parsed?.accessToken)
      if (token) return token
    } catch { /* Missing or invalid credentials file. */ }
  }
  return null
}

async function resolvePlanKey(id, hostContext) {
  if (id === 'volcengine') return resolveVolcengineKeys(hostContext)
  if (id === 'workbuddy') return {}
  const refs = PLAN_KEY_REFS[id]
  if (!refs || refs.length === 0) return null
  const hit = await resolveFirstRef(hostContext, refs)
  if (hit) return hit.value
  if (id === 'anthropic') return claudeOauthToken()
  return null
}

async function planConfigured(id, hostContext) {
  if (id === 'scnet' || id === 'qwen' || id === 'workbuddy') return true
  const key = await resolvePlanKey(id, hostContext)
  if (key === null) return false
  if (typeof key === 'string') return key.length > 0
  return Object.keys(key || {}).length > 0
}

async function resolveGoKey(hostContext) {
  const refs = new Set([GO_KEY_REF])
  try {
    const providers = hostContext?.get?.('settings')?.get?.('llm-pi-ai')?.providers
    for (const profile of Object.values(providers || {})) {
      if (typeof profile?.baseURL !== 'string' || typeof profile?.apiKeyEnv !== 'string') continue
      const url = new URL(profile.baseURL)
      if (url.origin === 'https://opencode.ai' && /^\/zen\/go\/v1\/?$/.test(url.pathname)
        && !url.username && !url.password && !url.search && !url.hash && /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) {
        refs.add(profile.apiKeyEnv)
      }
    }
  } catch { /* Older hosts may not expose the model settings service. */ }
  refs.add('OPENCODE_API_KEY')
  for (const ref of refs) {
    const key = await resolveRef(hostContext, ref)
    if (key) return key
  }
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      const auth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      const key = normalizeKey(auth?.['opencode-go']?.key)
      if (key) return key
    } catch { /* Invalid OpenCode auth JSON falls back to local files. */ }
  }
  const authFiles = [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json') : '',
    path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'auth.json') : '',
    path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
  ].filter(Boolean)
  for (const file of authFiles) {
    try {
      const auth = JSON.parse(fs.readFileSync(file, 'utf8'))
      const entry = auth?.['opencode-go']
      const key = (entry?.type === undefined || entry.type === 'api') ? normalizeKey(entry?.key) : null
      if (key) return key
    } catch { /* Missing or invalid OpenCode login file. */ }
  }
  return null
}

async function resolveBalanceKey(hostContext) {
  const refs = new Set([BALANCE_KEY_REF, 'DEEPSEEK_API_KEY'])
  try {
    const providers = hostContext?.get?.('settings')?.get?.('llm-pi-ai')?.providers
    for (const profile of Object.values(providers || {})) {
      if (typeof profile?.baseURL !== 'string' || typeof profile?.apiKeyEnv !== 'string') continue
      const url = new URL(profile.baseURL)
      if (url.origin === 'https://api.deepseek.com' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) refs.add(profile.apiKeyEnv)
    }
  } catch { /* Older hosts may not expose the model settings service. */ }
  for (const ref of refs) {
    const key = await resolveRef(hostContext, ref)
    if (key) return key
  }
  return null
}

async function writeCredential(hostContext, ref, value) {
  const key = normalizeKey(value)
  if (!key || key.length > 4096) throw new Error('请输入有效的凭据')
  const credentials = credentialService(hostContext)
  if (!credentials || typeof credentials.set !== 'function') throw new Error('DSH 凭据库暂不可用，未保存凭据')
  await credentials.set(ref, key)
}

async function clearCredential(hostContext, ref) {
  const credentials = credentialService(hostContext)
  if (!credentials || typeof credentials.unset !== 'function') throw new Error('DSH 凭据库暂不可用，未清除凭据')
  try { await credentials.unset(ref) } catch { /* missing ref is fine */ }
}

async function keyConfigured(hostContext) {
  return Boolean(await resolveGoKey(hostContext))
}

async function balanceKeyConfigured(hostContext) {
  return Boolean(await resolveBalanceKey(hostContext))
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

function sourceKey(kind, id) {
  return kind + ':' + id
}

function cacheFingerprint(value) {
  try { return JSON.stringify(value) } catch { return '' }
}

function cachedSource(key, fingerprint, refreshMinutes, now) {
  const entry = sourceCache.get(key)
  if (!entry || entry.fingerprint !== fingerprint) return null
  const ttl = Math.max(60_000, refreshOf(refreshMinutes, 15) * 60_000)
  return now - entry.at < ttl ? entry.value : null
}

function storeSource(key, fingerprint, value) {
  sourceCache.set(key, { at: Date.now(), fingerprint, value })
  if (sourceCache.size > 96) {
    const oldest = [...sourceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) sourceCache.delete(oldest[0])
  }
  return value
}

function dropQuotaCaches() {
  sourceCache.clear()
  goCache = { at: 0, value: null }
  balanceCache = { at: 0, value: null }
}

// ---------------------------------------------------------------------------
// Official balance
// ---------------------------------------------------------------------------

function chooseWallet(wallets) {
  if (!Array.isArray(wallets)) return null
  const rows = wallets.map(row => ({ currency: String(row?.currency || '').toUpperCase(), amount: Number(row?.balance) }))
    .filter(row => ['CNY', 'USD', 'EUR'].includes(row.currency) && Number.isFinite(row.amount))
  const positive = rows.filter(row => row.amount > 0)
  return positive.find(row => row.currency === 'CNY') || positive[0] || rows.find(row => row.currency === 'CNY') || rows[0] || null
}

function balanceFromDetails(details) {
  if (!details || details.status !== 'ready') {
    return { status: details?.status === 'failed' ? 'error' : 'off', message: '未登录官方账号或余额暂不可用', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: Date.now() }
  }
  const totals = new Map()
  const granted = new Map()
  const toppedUp = new Map()
  for (const row of [...(details.value || []), ...(details.bonusWallets || [])]) {
    const currency = String(row?.currency || '').toUpperCase()
    const amount = Number(row?.balance)
    if (!['CNY', 'USD', 'EUR'].includes(currency) || !Number.isFinite(amount)) continue
    totals.set(currency, (totals.get(currency) || 0) + amount)
  }
  for (const row of details.bonusWallets || []) {
    const currency = String(row?.currency || '').toUpperCase()
    const amount = Number(row?.balance)
    if (Number.isFinite(amount) && ['CNY', 'USD', 'EUR'].includes(currency)) granted.set(currency, (granted.get(currency) || 0) + amount)
  }
  for (const row of details.value || []) {
    const currency = String(row?.currency || '').toUpperCase()
    const amount = Number(row?.balance)
    if (Number.isFinite(amount) && ['CNY', 'USD', 'EUR'].includes(currency)) toppedUp.set(currency, (toppedUp.get(currency) || 0) + amount)
  }
  const picked = chooseWallet([...totals].map(([currency, balance]) => ({ currency, balance })))
  if (!picked) return { status: 'error', message: '官方账号未返回余额信息', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: Date.now() }
  return {
    status: 'ok',
    message: '',
    currency: picked.currency,
    totalBalance: picked.amount,
    granted: granted.get(picked.currency) || 0,
    toppedUp: toppedUp.get(picked.currency) || 0,
    fetchedAt: Date.now(),
  }
}

function balanceFromApiPayload(data) {
  const rows = Array.isArray(data?.balance_infos) ? data.balance_infos.map(row => ({
    currency: String(row?.currency || '').toUpperCase(),
    balance: typeof row?.total_balance === 'number' && Number.isFinite(row.total_balance)
      ? row.total_balance
      : typeof row?.total_balance === 'string' && row.total_balance.trim() !== '' && Number.isFinite(Number(row.total_balance))
        ? Number(row.total_balance) : NaN,
  })) : []
  const picked = chooseWallet(rows)
  return picked ? { status: 'ok', message: '', currency: picked.currency, totalBalance: picked.amount, granted: 0, toppedUp: picked.amount, fetchedAt: Date.now() } : null
}

async function fetchOfficialApiBalance(hostContext, options, now) {
  const key = await resolveBalanceKey(hostContext)
  if (!key) return null
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') return { status: 'error', message: '当前网关运行环境不支持网络请求', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: now }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetchImpl(BALANCE_API_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    })
    if (!response.ok) return { status: 'error', message: `DeepSeek 余额接口返回 HTTP ${response.status}`, currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: now }
    const value = balanceFromApiPayload(await response.json())
    return value || { status: 'error', message: '官方余额响应格式无效', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: now }
  } catch (error) {
    return { status: 'error', message: error?.name === 'AbortError' ? '官方余额查询超时' : '官方余额查询失败，请检查网络或 API Key', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: now }
  } finally { clearTimeout(timeout) }
}

async function fetchBalance(api, hostContext, options = {}, force = false) {
  const now = (options.now || Date.now)()
  if (!force && balanceCache.value && now - balanceCache.at < BALANCE_CACHE_TTL_MS) return balanceCache.value
  const locale = options.locale === 'en' ? 'en' : 'zh'
  let accountValue = null
  try {
    if (api?.account && typeof api.account.getBalance === 'function') {
      const details = await api.account.getBalance({ version: 'dsh-weapp/1', locale, timezoneOffsetSeconds: -new Date(now).getTimezoneOffset() * 60 })
      accountValue = balanceFromDetails(details)
      if (accountValue.status === 'ok') {
        balanceCache = { at: now, value: accountValue }
        return accountValue
      }
    }
  } catch {
    accountValue = null
  }
  const apiValue = await fetchOfficialApiBalance(hostContext, options, now)
  const value = apiValue || accountValue || { status: 'off', message: '请登录官方账号或配置 DeepSeek API Key', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: 0 }
  balanceCache = { at: now, value }
  return value
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const percent = Number(raw.percent)
  if (!Number.isFinite(percent)) return null
  return { percent: Math.max(0, Math.min(100, percent)), resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : '' }
}

async function fetchGoQuota(hostContext, options = {}, force = false) {
  const now = (options.now || Date.now)()
  if (!force && goCache.value && now - goCache.at < GO_CACHE_TTL_MS) return goCache.value
  const key = await resolveGoKey(hostContext)
  if (!key) return { status: 'off', message: '请在额度设置中配置 OpenCode Go API Key', fetchedAt: 0, rolling: null, weekly: null, monthly: null }
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') return { status: 'error', message: '当前网关运行环境不支持网络请求', fetchedAt: now, rolling: null, weekly: null, monthly: null }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetchImpl(GO_USAGE_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
    })
    if (!response.ok) {
      const message = response.status === 401 ? 'OpenCode Go API Key 未通过认证 (HTTP 401)'
        : response.status === 403 ? '当前 API Key 没有 OpenCode Go 订阅权限 (HTTP 403)'
          : `OpenCode Go 额度接口返回 HTTP ${response.status}`
      const value = { status: 'error', message, fetchedAt: now, rolling: null, weekly: null, monthly: null }
      if (response.status === 401 || response.status === 403) goCache = { at: now, value }
      return value
    }
    const data = await response.json()
    const usage = data && typeof data.usage === 'object' ? data.usage : {}
    const windows = { rolling: normalizeWindow(usage.rolling), weekly: normalizeWindow(usage.weekly), monthly: normalizeWindow(usage.monthly) }
    if (!Object.values(windows).some(Boolean)) throw new Error('额度接口没有返回有效用量窗口')
    const value = { status: 'ok', message: '', fetchedAt: now, ...windows }
    goCache = { at: now, value }
    return value
  } catch (error) {
    return { status: 'error', message: error?.name === 'AbortError' ? 'OpenCode Go 额度查询超时' : 'OpenCode Go 额度查询失败，请检查网络或 Key', fetchedAt: now, rolling: null, weekly: null, monthly: null }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Coding Plans
// ---------------------------------------------------------------------------

function tmsg(locale, code, vars = {}) {
  const zh = {
    codingPlanKeyMissing: '未配置 {provider} 的凭据',
    codingPlanUnauthorized: '{provider} 凭据无效或没有订阅 (HTTP {code})',
    codingPlanHttp: '{provider} 额度接口返回 HTTP {code}',
    codingPlanInvalidJson: '{provider} 返回了无效数据',
    codingPlanNoUsage: '{provider} 没有返回有效用量窗口',
    codingPlanUnknown: '未知的 Coding Plan 厂商',
    codingPlanCandidatesFailed: '{provider} 的额度端点均不可用',
    mimoCookieMissing: '未配置 {provider} 控制台 Cookie',
    mimoCookieInvalid: '{provider} 控制台 Cookie 无效',
    mimoLoginExpired: '{provider} 登录态已过期，请重新复制 Cookie',
    workbuddyUnlimited: '{provider} 积分无限',
  }
  const template = zh[code] || code
  return template.replace(/\{(\w+)\}/g, (match, name) => String(vars[name] ?? match))
}

function planBase(id, settings) {
  return {
    id,
    label: PLAN_LABELS[id] || id,
    enabled: settings ? settings.enabled === true : false,
    display: settings ? settings.display : 'settings',
    refreshMinutes: settings ? settings.refreshMinutes : 15,
    status: 'pending',
    message: '',
    windows: null,
    fetchedAt: 0,
  }
}

async function queryPlanSource(id, settings, hostContext, options) {
  if (!settings || settings.enabled !== true || settings.display === 'off') return { ...planBase(id, settings), status: 'off' }
  if (id === 'scnet' || id === 'qwen') {
    const credits = Number(settings.planCredits)
    if (!Number.isFinite(credits) || credits <= 0) {
      return { ...planBase(id, settings), status: 'unconfigured', message: '请填写月度 Credits 额度' }
    }
    const days = options.usageDays || {}
    const entry = { planCredits: credits, planStart: settings.planStart }
    const belongsToPlan = (provider, model) => {
      const canon = scnetCanonModelId(String(model || ''))
      if (id === 'qwen') return QWEN_MODELS.has(canon) || String(provider || '').toLowerCase().includes('qwen')
      return SCNET_MODELS.has(canon) || String(provider || '').toLowerCase().includes('scnet')
    }
    const compute = id === 'scnet' ? scnetTokenPlanWindows : qwenTokenPlanWindows
    const result = compute(days, entry, Date.now(), null, belongsToPlan)
    if (!result) return { ...planBase(id, settings), status: 'error', message: '本地估算失败' }
    return {
      ...planBase(id, settings),
      status: 'ok',
      message: '按本地会话用量估算',
      windows: result.windows,
      estimate: { used: result.used, total: result.total, byModel: result.byModel },
      fetchedAt: Date.now(),
    }
  }
  const key = await resolvePlanKey(id, hostContext)
  if (key === null || (typeof key === 'string' && key.length === 0)) {
    return { ...planBase(id, settings), status: 'unconfigured', message: tmsg(options.locale, 'codingPlanKeyMissing', { provider: PLAN_LABELS[id] || id }) }
  }
  try {
    const result = await queryCodingPlan(id, key, options.locale === 'en' ? 'en' : 'zh', tmsg, {
      baseUrl: settings.baseUrl,
      orgId: settings.orgId,
      workspaceId: settings.workspaceId,
      factoryPool: settings.factoryPool,
      signal: options.signal,
    })
    return {
      ...planBase(id, settings),
      status: 'ok',
      message: result && result.message ? result.message : '',
      windows: result && result.windows ? result.windows : null,
      endpoint: result && result.endpoint ? result.endpoint : '',
      fetchedAt: Date.now(),
    }
  } catch (error) {
    const soft = error && error.soft === true
    return {
      ...planBase(id, settings),
      status: soft ? 'off' : 'error',
      message: (error && error.message) || '额度查询失败',
      fetchedAt: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// Custom provider balances
// ---------------------------------------------------------------------------

function customBase(index, entry) {
  return {
    index,
    label: entry.label || '自定义余额',
    unit: entry.unit || 'USD',
    enabled: entry.enabled === true,
    display: entry.display,
    refreshMinutes: entry.refreshMinutes,
    convertToDisplayCurrency: entry.convertToDisplayCurrency === true,
    secretHeader: entry.secretHeader || '',
    status: 'pending',
    message: '',
    remaining: null,
    maxBudget: null,
    spend: null,
    percent: null,
    fetchedAt: 0,
  }
}

async function queryCustomSource(index, entry, hostContext, options) {
  const base = customBase(index, entry)
  if (!entry.enabled || entry.display === 'off') return { ...base, status: 'off' }
  if (entry.adapter === 'custom' && !entry.request.url) {
    return { ...base, status: 'unconfigured', message: '请填写余额接口地址' }
  }
  const headers = { ...(entry.request.headers || {}) }
  if (entry.secretHeader && headers[entry.secretHeader] === undefined) headers[entry.secretHeader] = `{{${CUSTOM_KEY_PREFIX}${index}}}`
  const config = {
    customBalance: {
      ...entry,
      request: { ...entry.request, headers },
    },
  }
  try {
    const result = await queryCustomBalance(hostContext, config, { signal: options.signal })
    const maxBudget = Number.isFinite(result.maxBudget) ? result.maxBudget : null
    const percent = maxBudget > 0 ? Math.max(0, Math.min(100, (result.remaining / maxBudget) * 100)) : null
    return {
      ...base,
      status: 'ok',
      message: '',
      remaining: result.remaining,
      maxBudget,
      spend: Number.isFinite(result.spend) ? result.spend : null,
      percent,
      unit: result.unit || base.unit,
      label: result.label || base.label,
      fetchedAt: Date.now(),
    }
  } catch (error) {
    return {
      ...base,
      status: error && error.soft === true ? 'off' : 'error',
      message: (error && error.message) || '自定义余额查询失败',
      fetchedAt: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// CLIProxyAPI gateway quotas
// ---------------------------------------------------------------------------

function gatewayBase(source) {
  return {
    id: source.id,
    type: source.type,
    label: source.label,
    enabled: source.enabled !== false,
    display: source.display,
    refreshMinutes: source.refreshMinutes,
    baseURL: source.baseURL,
    allowInsecureHttp: source.allowInsecureHttp === true,
    allowedHosts: source.allowedHosts,
    includeProviders: source.includeProviders,
    keyVar: managementKeyVarOf(source),
    status: 'pending',
    message: '',
    accounts: [],
    fetchedAt: 0,
    keyConfigured: false,
  }
}

async function queryGatewaySource(source, hostContext, options) {
  if (!source.enabled || source.display === 'off') return { ...gatewayBase(source), status: 'off' }
  try {
    const result = await queryGatewayQuota(hostContext, source, { signal: options.signal, fetchImpl: options.fetch })
    return {
      ...gatewayBase(source),
      ...result,
      accounts: Array.isArray(result.accounts) ? result.accounts.slice(0, 24) : [],
    }
  } catch (error) {
    return { ...gatewayBase(source), status: 'error', message: error?.code || error?.message || '网关额度查询失败' }
  }
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// ---------------------------------------------------------------------------

async function runPool(tasks, limit) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      try { await tasks[index]() } catch { /* each task records its own failure */ }
    }
  })
  await Promise.all(workers)
}

function planAppliesToScope(settings, scope) {
  if (!settings || settings.enabled !== true) return false
  if (scope === 'all') return true
  return settings.display === 'sidebar' || settings.display === 'both'
}

function customAppliesToScope(entry, scope) {
  if (!entry || entry.enabled !== true) return false
  return scope === 'all' || entry.display === 'sidebar' || entry.display === 'both'
}

function gatewayAppliesToScope(source, scope) {
  if (!source || source.enabled === false) return false
  return scope === 'all' || source.display === 'sidebar' || source.display === 'both'
}

function needsUsageDays(id) {
  return id === 'scnet' || id === 'qwen'
}

async function dashboardOf(api, hostContext, settings, options = {}, { force = false, scope = 'all', autoRefresh = false, cacheOnly = false } = {}) {
  const now = Date.now()
  const locale = options.locale === 'en' ? 'en' : 'zh'
  const needsUsage = CODING_PLAN_PROVIDER_IDS.some(id => needsUsageDays(id) && planAppliesToScope(settings.codingPlans[id], scope))
  const usageDays = needsUsage ? await collectUsageDays(api, options.signal) : {}

  const plans = []
  const planResults = []
  const tasks = []

  for (const id of CODING_PLAN_PROVIDER_IDS) {
    const cfg = settings.codingPlans[id]
    const index = plans.length
    plans.push({ id, settings: cfg || null })
    if (!planAppliesToScope(cfg, scope)) {
      planResults[index] = { ...planBase(id, cfg), status: 'off' }
      continue
    }
    const fingerprint = cacheFingerprint({ id, cfg, configured: await planConfigured(id, hostContext) })
    const cached = !force ? cachedSource(sourceKey('plan', id), fingerprint, cfg.refreshMinutes, now) : null
    if (cached) { planResults[index] = cached; continue }
    if (!force && !autoRefresh) {
      planResults[index] = { ...planBase(id, cfg), status: 'pending' }
      continue
    }
    tasks.push(async () => {
      const value = await queryPlanSource(id, cfg, hostContext, { locale, signal: options.signal, usageDays })
      planResults[index] = storeSource(sourceKey('plan', id), fingerprint, value)
    })
  }

  const customEntries = []
  for (let index = 0; index < settings.customBalances.length; index += 1) {
    const entry = settings.customBalances[index]
    const resultIndex = customEntries.length
    customEntries.push({ index, entry, value: customBase(index, entry) })
    if (!customAppliesToScope(entry, scope)) {
      customEntries[resultIndex].value = { ...customBase(index, entry), status: 'off' }
      continue
    }
    const key = sourceKey('custom', index)
    const fingerprint = cacheFingerprint({ entry })
    const cached = !force ? cachedSource(key, fingerprint, entry.refreshMinutes, now) : null
    if (cached) { customEntries[resultIndex].value = cached; continue }
    if (!force && !autoRefresh) continue
    tasks.push(async () => {
      const value = await queryCustomSource(index, entry, hostContext, { signal: options.signal })
      customEntries[resultIndex].value = storeSource(key, fingerprint, value)
    })
  }

  const gatewayEntries = []
  for (const source of settings.gatewayQuotas.sources) {
    const resultIndex = gatewayEntries.length
    gatewayEntries.push({ source, value: gatewayBase(source) })
    if (!gatewayAppliesToScope(source, scope)) {
      gatewayEntries[resultIndex].value = { ...gatewayBase(source), status: 'off' }
      continue
    }
    const key = sourceKey('gateway', source.id)
    const fingerprint = cacheFingerprint({ source })
    const cached = !force ? cachedSource(key, fingerprint, source.refreshMinutes, now) : null
    if (cached) { gatewayEntries[resultIndex].value = cached; continue }
    if (!force && !autoRefresh) continue
    tasks.push(async () => {
      const value = await queryGatewaySource(source, hostContext, { signal: options.signal })
      gatewayEntries[resultIndex].value = storeSource(key, fingerprint, value)
    })
  }

  await runPool(tasks, 4)

  const balanceWanted = settings.balance.enabled && (scope === 'all' || settings.balance.display === 'sidebar' || settings.balance.display === 'both')
  const emptyBalance = () => ({ status: 'pending', message: '未刷新', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: 0 })
  let balanceValue
  if (!settings.balance.enabled) {
    balanceValue = { status: 'off', message: '', currency: '', totalBalance: 0, granted: 0, toppedUp: 0, fetchedAt: 0 }
  } else if (balanceWanted && !cacheOnly) {
    balanceValue = await withTimeout(fetchBalance(api, hostContext, { signal: options.signal, locale }, force), 8000, emptyBalance())
  } else {
    balanceValue = balanceCache.value || emptyBalance()
  }

  const goWanted = settings.goQuota.enabled && (scope === 'all' || settings.goQuota.display === 'sidebar' || settings.goQuota.display === 'both')
  const emptyGo = { status: 'pending', message: '未刷新', fetchedAt: 0, rolling: null, weekly: null, monthly: null }
  const goValue = !goWanted
    ? { status: 'off', message: '', fetchedAt: 0, rolling: null, weekly: null, monthly: null }
    : cacheOnly
      ? (goCache.value || emptyGo)
      : await withTimeout(fetchGoQuota(hostContext, { signal: options.signal, fetch: options.fetch }, force), 8000, emptyGo)

  return {
    currency: settings.currency,
    symbol: settings.symbol,
    exchangeRate: settings.exchangeRate,
    decimals: settings.decimals,
    display: settings.display,
    balance: {
      enabled: settings.balance.enabled,
      display: settings.balance.display,
      refreshMinutes: settings.balance.refreshMinutes,
      showProgressBar: settings.balance.showProgressBar,
      barDirection: settings.balance.barDirection,
      keyConfigured: await balanceKeyConfigured(hostContext),
      ...balanceValue,
    },
    customBalances: customEntries.map(item => item.value),
    goQuota: {
      ...settings.goQuota,
      configured: await keyConfigured(hostContext),
      ...goValue,
    },
    plans: plans.map((plan, index) => ({
      ...(planResults[index] || planBase(plan.id, plan.settings)),
      ...(plan.settings ? { enabled: plan.settings.enabled, display: plan.settings.display, refreshMinutes: plan.settings.refreshMinutes } : {}),
    })),
    gatewayQuotas: gatewayEntries.map(item => item.value),
    peak: { ...settings.peak },
    budget: { ...settings.budget },
    settings: {
      display: settings.display,
      balance: settings.balance,
      goQuota: settings.goQuota,
      peak: settings.peak,
      budget: settings.budget,
      codingPlans: settings.codingPlans,
      customBalances: settings.customBalances,
      gatewayQuotas: settings.gatewayQuotas,
      goKeyConfigured: await keyConfigured(hostContext),
      balanceKeyConfigured: await balanceKeyConfigured(hostContext),
    },
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCustomEntries(raw) {
  if (!Array.isArray(raw)) throw new Error('自定义余额配置无效')
  if (raw.length > MAX_CUSTOM_BALANCES) throw new Error('最多配置 8 条自定义余额')
  return raw.map((entry, index) => {
    const normalized = normalizeCustomEntry(entry)
    if (normalized.adapter === 'custom' && normalized.request.url) {
      if (!/^https?:\/\//i.test(normalized.request.url)) throw new Error(`第 ${index + 1} 条自定义余额接口地址必须是 http(s)`)
      if (normalized.request.url.length > 2048) throw new Error('接口地址过长')
    }
    if (normalized.enabled === true && normalized.adapter === 'custom' && !normalized.request.url) {
      throw new Error(`第 ${index + 1} 条自定义余额缺少接口地址`)
    }
    return normalized
  })
}

function validatePlanPatch(raw) {
  const input = record(raw)
  if (!input) throw new Error('Coding Plan 配置无效')
  const next = readSettings().codingPlans
  for (const [id, value] of Object.entries(input)) {
    if (!CODING_PLAN_PROVIDER_IDS.includes(id)) throw new Error('未知的 Coding Plan 厂商')
    if (!record(value)) throw new Error('Coding Plan 配置无效')
    next[id] = normalizePlanSettings(id, { ...(next[id] || {}), ...value })
  }
  return next
}

function validatePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('额度配置无效')
  const current = readSettings()
  const patch = {}
  if (raw.currency !== undefined) {
    if (!CURRENCIES.includes(raw.currency)) throw new Error('显示币种仅支持 CNY、USD 或 EUR')
    patch.currency = raw.currency
  }
  if (raw.symbol !== undefined) {
    if (typeof raw.symbol !== 'string' || !raw.symbol.trim() || raw.symbol.trim().length > 8) throw new Error('货币符号无效')
    patch.symbol = raw.symbol.trim()
  }
  if (raw.exchangeRate !== undefined) {
    const rate = Number(raw.exchangeRate)
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw new Error('汇率必须大于 0 且不超过 1000')
    patch.exchangeRate = rate
  }
  if (raw.decimals !== undefined) {
    const decimals = Number(raw.decimals)
    if (!Number.isInteger(decimals) || decimals < 2 || decimals > 6) throw new Error('小数位数应为 2–6')
    patch.decimals = decimals
  }
  if (raw.exchangeRateAuto !== undefined) patch.exchangeRateAuto = raw.exchangeRateAuto === true
  if (raw.display !== undefined) {
    const display = record(raw.display)
    if (!display) throw new Error('显示配置无效')
    const next = { ...current.display }
    if (display.sidebarStyle !== undefined) {
      if (!SIDEBAR_STYLES.includes(display.sidebarStyle)) throw new Error('侧栏样式无效')
      next.sidebarStyle = display.sidebarStyle
    }
    if (display.sidebarVisible !== undefined) next.sidebarVisible = display.sidebarVisible === true
    if (display.sidebarTodayMetric !== undefined) {
      if (!['amount', 'tokens', 'both'].includes(display.sidebarTodayMetric)) throw new Error('今日显示项无效')
      next.sidebarTodayMetric = display.sidebarTodayMetric
    }
    if (display.peakStyle !== undefined) next.peakStyle = display.peakStyle === 'classic' ? 'classic' : 'progress'
    if (display.peakTimeDisplay !== undefined) {
      if (!PEAK_TIME_DISPLAYS.includes(display.peakTimeDisplay)) throw new Error('峰谷时间显示无效')
      next.peakTimeDisplay = display.peakTimeDisplay
    }
    if (display.sidebarTodayBalanceInline !== undefined) next.sidebarTodayBalanceInline = display.sidebarTodayBalanceInline === true
    patch.display = next
  }
  if (raw.balance !== undefined) {
    const balance = record(raw.balance)
    if (!balance) throw new Error('余额配置无效')
    const next = { ...current.balance }
    if (balance.enabled !== undefined) next.enabled = balance.enabled === true
    if (balance.display !== undefined) next.display = displayOf(balance.display, next.display)
    if (balance.refreshMinutes !== undefined) next.refreshMinutes = refreshOf(balance.refreshMinutes, next.refreshMinutes)
    if (balance.showProgressBar !== undefined) next.showProgressBar = balance.showProgressBar === true
    if (balance.barDirection !== undefined) {
      if (!BAR_DIRECTIONS.includes(balance.barDirection)) throw new Error('进度条方向无效')
      next.barDirection = balance.barDirection
    }
    patch.balance = next
  }
  if (raw.goQuota !== undefined) {
    const go = record(raw.goQuota)
    if (!go) throw new Error('OpenCode Go 配置无效')
    const next = { ...current.goQuota }
    if (go.enabled !== undefined) next.enabled = go.enabled === true
    if (go.display !== undefined) next.display = displayOf(go.display, next.display)
    if (go.refreshMinutes !== undefined) next.refreshMinutes = refreshOf(go.refreshMinutes, next.refreshMinutes)
    if (go.detail !== undefined) next.detail = go.detail !== false
    if (go.main !== undefined) {
      if (!['rolling', 'weekly', 'monthly'].includes(go.main)) throw new Error('用量窗口无效')
      next.main = go.main
    }
    if (go.barDirection !== undefined) {
      if (!['used', 'remaining'].includes(go.barDirection)) throw new Error('进度条方向无效')
      next.barDirection = go.barDirection
    }
    patch.goQuota = next
  }
  if (raw.peak !== undefined) {
    const peak = record(raw.peak)
    if (!peak) throw new Error('峰谷配置无效')
    const next = { ...current.peak }
    if (peak.enabled !== undefined) next.enabled = peak.enabled !== false
    if (peak.display !== undefined) next.display = displayOf(peak.display, next.display)
    if (peak.effectiveAt !== undefined) next.effectiveAt = typeof peak.effectiveAt === 'string' ? peak.effectiveAt.slice(0, 32) : ''
    if (peak.windows !== undefined) {
      if (!Array.isArray(peak.windows)) throw new Error('峰时段配置无效')
      next.windows = normalizePeakWindows(peak.windows)
    }
    if (peak.holidays !== undefined) {
      if (!Array.isArray(peak.holidays) || peak.holidays.some(day => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new Error('节假日应使用 YYYY-MM-DD 格式')
      next.holidays = peak.holidays.slice(0, 100)
    }
    if (peak.peakAlertEnabled !== undefined) next.peakAlertEnabled = peak.peakAlertEnabled === true
    if (peak.peakAlertAhead !== undefined) {
      const ahead = Number(peak.peakAlertAhead)
      if (!Number.isInteger(ahead) || ahead < 1 || ahead > 30) throw new Error('提前提醒应为 1–30 分钟')
      next.peakAlertAhead = ahead
    }
    if (peak.peakAlertTarget !== undefined) {
      if (!PEAK_ALERT_TARGETS.includes(peak.peakAlertTarget)) throw new Error('提醒类型无效')
      next.peakAlertTarget = peak.peakAlertTarget
    }
    if (peak.peakAlertPosition !== undefined) {
      if (!PEAK_ALERT_POSITIONS.includes(peak.peakAlertPosition)) throw new Error('弹窗位置无效')
      next.peakAlertPosition = peak.peakAlertPosition
    }
    patch.peak = next
  }
  if (raw.budget !== undefined) {
    const budget = record(raw.budget)
    if (!budget) throw new Error('预算配置无效')
    const next = { ...current.budget }
    if (budget.display !== undefined) next.display = displayOf(budget.display, next.display)
    if (budget.enabled !== undefined) next.enabled = budget.enabled === true
    if (budget.amount !== undefined) {
      const amount = Number(budget.amount)
      if (!Number.isFinite(amount) || amount < 0) throw new Error('预算额度应为非负数字')
      next.amount = amount
    }
    if (budget.period !== undefined) {
      if (!['day', 'month', 'all', 'custom'].includes(budget.period)) throw new Error('预算周期无效')
      next.period = budget.period
    }
    if (budget.customStart !== undefined) {
      const value = typeof budget.customStart === 'string' ? budget.customStart.trim() : ''
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('开始日期应为 YYYY-MM-DD')
      next.customStart = value
    }
    if (budget.customEnd !== undefined) {
      const value = typeof budget.customEnd === 'string' ? budget.customEnd.trim() : ''
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('结束日期应为 YYYY-MM-DD')
      next.customEnd = value
    }
    if (budget.detail !== undefined) next.detail = budget.detail !== false
    if (budget.barDirection !== undefined) {
      if (!BAR_DIRECTIONS.includes(budget.barDirection)) throw new Error('进度条方向无效')
      next.barDirection = budget.barDirection
    }
    patch.budget = next
  }
  if (raw.codingPlans !== undefined) patch.codingPlans = validatePlanPatch(raw.codingPlans)
  if (raw.customBalances !== undefined) patch.customBalances = validateCustomEntries(raw.customBalances)
  if (raw.gatewayQuotas !== undefined) {
    const gateway = record(raw.gatewayQuotas)
    if (!gateway || !Array.isArray(gateway.sources)) throw new Error('网关额度来源配置无效')
    if (gateway.sources.length > MAX_GATEWAY_SOURCES) throw new Error('最多配置 4 个网关额度来源')
    patch.gatewayQuotas = {
      sources: gateway.sources.map(source => {
        const draft = record(source) || {}
        if (!text(draft.baseURL) && draft.enabled !== true) return normalizeGatewaySource(draft)
        return validateGatewaySource(source)
      }),
    }
  }
  if (raw.sidebarOrder !== undefined) {
    if (!Array.isArray(raw.sidebarOrder)) throw new Error('侧栏排序配置无效')
    if (raw.sidebarOrder.length > MAX_SIDEBAR_ORDER) throw new Error(`侧栏排序最多 ${MAX_SIDEBAR_ORDER} 项`)
    patch.sidebarOrder = normalizeSidebarOrder(raw.sidebarOrder)
  }
  if (raw.quotaStrip !== undefined) {
    const strip = record(raw.quotaStrip)
    if (!strip) throw new Error('输入区横条配置无效')
    const next = { ...current.quotaStrip }
    if (strip.enabled !== undefined) next.enabled = strip.enabled === true
    if (strip.budget !== undefined) next.budget = strip.budget !== false
    if (strip.go !== undefined) next.go = strip.go !== false
    if (strip.plans !== undefined) next.plans = strip.plans !== false
    patch.quotaStrip = next
  }
  if (raw.corner !== undefined) {
    const cornerRaw = record(raw.corner)
    if (!cornerRaw) throw new Error('角标配置无效')
    const next = { ...current.corner }
    if (cornerRaw.enabled !== undefined) next.enabled = cornerRaw.enabled === true
    for (const key of ['goRolling', 'goWeekly', 'goMonthly', 'budget']) {
      if (cornerRaw[key] !== undefined) next[key] = cornerRaw[key] !== false
    }
    patch.corner = next
  }
  if (raw.sessionCost !== undefined) {
    const sc = record(raw.sessionCost)
    if (!sc) throw new Error('会话费用配置无效')
    const next = { ...current.sessionCost }
    if (sc.position !== undefined) {
      if (!SESSION_COST_POSITIONS.includes(sc.position)) throw new Error('会话费用位置无效')
      next.position = sc.position
    }
    if (sc.compact !== undefined) next.compact = sc.compact === true
    if (sc.hideTurnCost !== undefined) next.hideTurnCost = sc.hideTurnCost === true
    if (sc.hideHeader !== undefined) next.hideHeader = sc.hideHeader === true
    if (sc.hideDock !== undefined) next.hideDock = sc.hideDock === true
    patch.sessionCost = next
  }
  return patch
}

function mergeSettings(current, patch) {
  return normalizeSettings({ ...current, ...patch,
    display: { ...current.display, ...(patch.display || {}) },
    balance: { ...current.balance, ...(patch.balance || {}) },
    goQuota: { ...current.goQuota, ...(patch.goQuota || {}) },
    peak: { ...current.peak, ...(patch.peak || {}) },
    budget: { ...current.budget, ...(patch.budget || {}) },
    codingPlans: patch.codingPlans || current.codingPlans,
    customBalances: patch.customBalances !== undefined ? patch.customBalances : current.customBalances,
    gatewayQuotas: patch.gatewayQuotas || current.gatewayQuotas,
  })
}

// ---------------------------------------------------------------------------
// Legacy credential helpers (Go / official balance)
// ---------------------------------------------------------------------------

async function saveGoKey(hostContext, value) {
  const key = normalizeKey(value)
  if (!key || key.length > 4096) throw new Error('请输入有效的 OpenCode Go API Key')
  await writeCredential(hostContext, GO_KEY_REF, key)
}

async function clearGoKey(hostContext) {
  await clearCredential(hostContext, GO_KEY_REF)
}

async function saveBalanceKey(hostContext, value) {
  const key = normalizeKey(value)
  if (!key || key.length > 4096) throw new Error('请输入有效的 DeepSeek API Key')
  await writeCredential(hostContext, BALANCE_KEY_REF, key)
}

async function clearBalanceKey(hostContext) {
  await clearCredential(hostContext, BALANCE_KEY_REF)
}

// ---------------------------------------------------------------------------
// Source credential actions
// ---------------------------------------------------------------------------

function parseSourceRef(raw) {
  const value = text(raw)
  const [kind, ...rest] = value.split(':')
  const id = rest.join(':')
  if (kind === 'plan' && CODING_PLAN_PROVIDER_IDS.includes(id)) return { kind, id }
  if (kind === 'gateway' && id) return { kind, id }
  if (kind === 'custom' && id) return { kind, id }
  return null
}

async function setSourceKey(hostContext, rawSource, value, secret, settings) {
  const ref = parseSourceRef(rawSource)
  if (!ref) throw new Error('未知的额度来源')
  if (ref.kind === 'plan') {
    if (ref.id === 'scnet' || ref.id === 'qwen' || ref.id === 'workbuddy') throw new Error('该厂商不需要填写凭据')
    if (ref.id === 'volcengine') {
      if (!secret) throw new Error('火山方舟需要 AccessKeyID 与 SecretAccessKey')
      await writeCredential(hostContext, PLAN_KEY_REFS.volcengine[0], value)
      await writeCredential(hostContext, VOLC_SECRET_REFS[0], secret)
      return
    }
    const target = (PLAN_KEY_REFS[ref.id] || [])[0]
    if (!target) throw new Error('该厂商不需要填写凭据')
    await writeCredential(hostContext, target, value)
    return
  }
  if (ref.kind === 'gateway') {
    const source = settings.gatewayQuotas.sources.find(item => item.id === ref.id)
    if (!source) throw new Error('网关额度来源不存在')
    await writeCredential(hostContext, managementKeyVarOf(source), value)
    return
  }
  const index = Number(ref.id)
  const entry = Number.isInteger(index) ? settings.customBalances[index] : null
  if (!entry) throw new Error('自定义余额条目不存在')
  if (!entry.secretHeader) throw new Error('请先填写密钥请求头名称')
  await writeCredential(hostContext, CUSTOM_KEY_PREFIX + index, value)
}

async function clearSourceKey(hostContext, rawSource, settings) {
  const ref = parseSourceRef(rawSource)
  if (!ref) throw new Error('未知的额度来源')
  if (ref.kind === 'plan') {
    for (const target of PLAN_KEY_REFS[ref.id] || []) await clearCredential(hostContext, target)
    if (ref.id === 'volcengine') for (const target of VOLC_SECRET_REFS) await clearCredential(hostContext, target)
    return
  }
  if (ref.kind === 'gateway') {
    const source = settings.gatewayQuotas.sources.find(item => item.id === ref.id)
    if (source) await clearCredential(hostContext, managementKeyVarOf(source))
    return
  }
  const index = Number(ref.id)
  if (Number.isInteger(index)) await clearCredential(hostContext, CUSTOM_KEY_PREFIX + index)
}

// ---------------------------------------------------------------------------
// UI source snapshot
// ---------------------------------------------------------------------------

async function sourcesSnapshot(settings, hostContext) {
  const plans = []
  for (const id of CODING_PLAN_PROVIDER_IDS) {
    plans.push({
      id,
      label: PLAN_LABELS[id] || id,
      fields: PLAN_EXTRA_FIELDS[id] || [],
      needsSecret: id === 'volcengine',
      noKey: (PLAN_KEY_REFS[id] || []).length === 0,
      configured: await planConfigured(id, hostContext),
      settings: settings.codingPlans[id] || normalizePlanSettings(id, {}),
    })
  }
  return {
    plans,
    customBalances: settings.customBalances.map((entry, index) => ({
      index,
      configured: Boolean(entry.secretHeader),
      keyRef: CUSTOM_KEY_PREFIX + index,
    })),
    gatewayQuotas: settings.gatewayQuotas.sources.map(source => ({
      id: source.id,
      keyRef: managementKeyVarOf(source),
    })),
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Maintain the session summary while providing balances and quotas natively. */
export async function handleCostMeterWithDashboard(api, msg, options = {}) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : ''
  const action = typeof msg?.action === 'string' ? msg.action : 'summary'
  const hostContext = options.hostContext
  try {
    let settings = readSettings()
    let baseForward = null
    if (action === 'update') {
      const rawPatch = record(msg.patch) || {}
      baseForward = {}
      for (const key of ['currency', 'budget', 'hideBudget', 'showTotalWithPlan', 'includeSubagentCost']) {
        if (rawPatch[key] !== undefined) baseForward[key] = rawPatch[key]
      }
      const patch = validatePatch(msg.patch || {})
      settings = mergeSettings(settings, patch)
      if (!writeSettings(settings)) throw new Error('额度设置无法写入 DSH 本机存储')
      dropQuotaCaches()
    } else if (action === 'set-go-key') {
      await saveGoKey(hostContext, msg.value)
      settings = mergeSettings(settings, { goQuota: { ...settings.goQuota, enabled: true } })
      if (!writeSettings(settings)) throw new Error('额度设置无法写入 DSH 本机存储')
      dropQuotaCaches()
    } else if (action === 'clear-go-key') {
      await clearGoKey(hostContext)
      dropQuotaCaches()
    } else if (action === 'set-balance-key') {
      await saveBalanceKey(hostContext, msg.value)
      dropQuotaCaches()
    } else if (action === 'clear-balance-key') {
      await clearBalanceKey(hostContext)
      dropQuotaCaches()
    } else if (action === 'set-source-key') {
      await setSourceKey(hostContext, msg.source, msg.value, msg.secret, settings)
      dropQuotaCaches()
    } else if (action === 'clear-source-key') {
      await clearSourceKey(hostContext, msg.source, settings)
      dropQuotaCaches()
    } else if (action === 'refresh-source') {
      const ref = parseSourceRef(msg.source)
      if (!ref) throw new Error('未知的额度来源')
      const dashboard = await dashboardOf(api, hostContext, settings, options, { force: false, scope: 'all', autoRefresh: false })
      if (ref.kind === 'plan') {
        const cfg = settings.codingPlans[ref.id]
        const value = await queryPlanSource(ref.id, cfg, hostContext, {
          locale: options.locale,
          signal: options.signal,
          usageDays: needsUsageDays(ref.id) ? await collectUsageDays(api, options.signal) : {},
        })
        const fingerprint = cacheFingerprint({ id: ref.id, cfg, configured: await planConfigured(ref.id, hostContext) })
        storeSource(sourceKey('plan', ref.id), fingerprint, value)
        dashboard.plans = dashboard.plans.map(item => item.id === ref.id ? { ...item, ...value } : item)
      } else if (ref.kind === 'custom') {
        const index = Number(ref.id)
        const entry = settings.customBalances[index]
        if (!entry) throw new Error('自定义余额条目不存在')
        const value = await queryCustomSource(index, entry, hostContext, { signal: options.signal })
        storeSource(sourceKey('custom', index), cacheFingerprint({ entry }), value)
        dashboard.customBalances = dashboard.customBalances.map(item => item.index === index ? value : item)
      } else {
        const source = settings.gatewayQuotas.sources.find(item => item.id === ref.id)
        if (!source) throw new Error('网关额度来源不存在')
        const value = await queryGatewaySource(source, hostContext, { signal: options.signal })
        storeSource(sourceKey('gateway', ref.id), cacheFingerprint({ source }), value)
        dashboard.gatewayQuotas = dashboard.gatewayQuotas.map(item => item.id === ref.id ? value : item)
      }
      return { kind: 'cost-meter', requestId, action, dashboard }
    } else if (action === 'source-config') {
      return { kind: 'cost-meter', requestId, action, sources: await sourcesSnapshot(settings, hostContext) }
    } else if (!['summary', 'config', 'refresh'].includes(action)) {
      return handleBaseCostMeter(api, msg)
    }

    let base
    if (action === 'update' && baseForward && Object.keys(baseForward).length > 0) {
      base = await handleBaseCostMeter(api, { ...msg, action: 'update', patch: baseForward })
    } else {
      const baseAction = ['summary', 'refresh'].includes(action) ? action : 'config'
      base = await handleBaseCostMeter(api, { ...msg, action: baseAction })
    }
    const force = action === 'refresh'
    const scope = action === 'summary'
      ? (settings.display.sidebarVisible === true ? 'sidebar' : 'none')
      : 'all'
    const autoRefresh = action === 'summary' || action === 'refresh'
    const dashboard = await dashboardOf(api, hostContext, settings, options, { force, scope, autoRefresh, cacheOnly: action === 'config' })
    return {
      ...(base && base.kind === 'cost-meter' ? base : { kind: 'cost-meter', requestId }),
      requestId,
      action,
      config: {
        currency: settings.currency,
        symbol: settings.symbol,
        exchangeRate: settings.exchangeRate,
        exchangeRateAuto: settings.exchangeRateAuto,
        decimals: settings.decimals,
        display: settings.display,
        balance: { ...settings.balance, keyConfigured: dashboard.balance.keyConfigured },
        goQuota: { ...settings.goQuota, keyConfigured: dashboard.goQuota.configured },
        peak: settings.peak,
        budget: settings.budget,
        sidebarOrder: settings.sidebarOrder,
        quotaStrip: settings.quotaStrip,
        corner: settings.corner,
        sessionCost: settings.sessionCost,
        codingPlans: settings.codingPlans,
        customBalances: settings.customBalances,
        gatewayQuotas: settings.gatewayQuotas,
      },
      dashboard,
      ...(action === 'config' ? { sources: await sourcesSnapshot(settings, hostContext) } : {}),
    }
  } catch (error) {
    if (['set-go-key', 'set-balance-key', 'set-source-key'].includes(action)) {
      return { kind: 'error', requestType: 'cost-meter', requestId, code: 'cost-meter-credential-write-failed', message: error?.message || '凭据保存失败，请检查 DSH 凭据库' }
    }
    if (['clear-go-key', 'clear-balance-key', 'clear-source-key'].includes(action)) {
      return { kind: 'error', requestType: 'cost-meter', requestId, code: 'cost-meter-credential-write-failed', message: error?.message || '凭据清除失败，请检查 DSH 凭据库' }
    }
    if (action === 'update') return { kind: 'error', requestType: 'cost-meter', requestId, code: 'bad-request', message: error?.message || '额度设置无效' }
    return { kind: 'error', requestType: 'cost-meter', requestId, code: 'cost-meter-dashboard-error', message: error?.message || '额度数据读取失败' }
  }
}

/** Exported for unit tests: reset module caches. */
export function resetCostDashboardForTests() {
  dropQuotaCaches()
  sourceCache.clear()
}

export const __test = {
  normalizeSettings,
  validatePatch,
  mergeSettings,
  normalizeCustomEntry,
  normalizePlanSettings,
  managementKeyVarOf,
  PLAN_KEY_REFS,
  writeSettings,
  readSettings,
  dropQuotaCaches,
}
