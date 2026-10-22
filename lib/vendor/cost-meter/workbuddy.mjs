// Ported from corrinehu/dsh-workbuddy-connect (MIT) src/auth.ts + src/upstream.ts.
// WorkBuddy 积分余额来源(第 14 家 coding plan provider):凭据解析 + billing 查询。
// 优先使用同一宿主的 connect 状态接口，由连接插件处理加密登录文件。
// 接口不存在时兼容旧版明文文件；本模块不刷新令牌，也不写入登录文件。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from './home-paths-shim.mjs'

import { fetchWithRetry, readJsonBounded } from './net.mjs'
import { fetchWorkBuddyLocal, workBuddyOrigin } from './workbuddy-transport.mjs'
import { validWorkBuddyAccountId } from './workbuddy-accounts.mjs'

export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'
// 桌面端登录文件相对路径(connect 插件 DESKTOP_AUTH_RELATIVE_PATH 同款)。
export const WORKBUDDY_DESKTOP_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info']

// 本模块抛出的错误携带的专属错误码(lib/index.js SERVER_MESSAGES 同名文案键)。
export const WORKBUDDY_ERROR_CODES = ['workbuddyNotInstalled', 'workbuddyAuthEncrypted', 'workbuddyTokenExpired']

const CODEBUDZY_BILLING_BASE = 'https://www.codebuddy.cn'
const WORKBUDDY_BILLING_BASE = 'https://www.workbuddy.ai'

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

/** Billing base for a credential's domain. */
export function workbuddyBillingBase(credential) {
  return regionOf(credential.domain) === 'global' ? WORKBUDDY_BILLING_BASE : CODEBUDZY_BILLING_BASE
}

/** Billing request headers(port 自 upstream.ts billingHeaders)。 */
export function billingHeadersOf(credential) {
  const headers = {
    authorization: `Bearer ${credential.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (credential.uid !== '') headers['x-user-id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['x-enterprise-id'] = credential.enterpriseId
    headers['x-tenant-id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['x-domain'] = credential.domain
  return headers
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** token 已过期判定(expiresAtMs 缺失视为未知,不算过期)。 */
export function isWorkBuddyTokenExpired(credential, nowMs = Date.now()) {
  return credential?.expiresAtMs > 0 && nowMs >= credential.expiresAtMs
}

/**
 * 解析 WorkBuddy 登录文档,兼容三种在盘形态(connect src/auth.ts):
 *  - 插件自有副本 {version:1, credential:{accessToken, expiresAtMs(毫秒), refreshToken, domain, uid, enterpriseId, nickname}};
 *  - 桌面端嵌套 {auth:{accessToken, expiresAt(秒或毫秒), refreshToken, domain}, account:{uid, enterpriseId, nickname}};
 *  - 扁平(顶层同名字段)。
 * 无法解析或无 accessToken → undefined;加密/无法识别由调用方分类。
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const document = parsed
  let auth, identity
  if (document.auth !== null && typeof document.auth === 'object') {
    auth = document.auth
    identity = document.account !== null && typeof document.account === 'object' ? document.account : {}
  } else if (document.credential !== null && typeof document.credential === 'object' && document.version === 1) {
    // 插件自有副本:credential 顶层即归一化形态(camelCase expiresAtMs)。
    auth = document.credential
    identity = document.credential
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth.expiresAtMs === 'number'
    ? (auth.expiresAtMs > 0 ? auth.expiresAtMs : 0)
    : (typeof auth.expiresAt === 'number' ? expiryToMs(auth.expiresAt) : 0)
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs,
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
  }
}

/** 检测登录文档是否加密/无法识别(WorkBuddy 5.6 的 $wbEncrypted 封装痕迹)。 */
export function isWorkBuddyAuthEncrypted(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return true } // 无法解析即无法识别
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const auth = parsed.auth !== null && typeof parsed.auth === 'object' ? parsed.auth : parsed.version === 1 && parsed.credential ? parsed.credential : parsed
  for (const field of ['accessToken', 'refreshToken']) {
    const value = auth[field]
    if (value === undefined) continue
    if (typeof value === 'string') continue
    if (value !== null && typeof value === 'object' && value.$wbEncrypted !== undefined) return true
    return true // 非字符串的非空字段:本插件不支持的结构,按加密/无法识别处理
  }
  return false
}

/** 按平台列出桌面端登录文件候选(顺序对齐 connect defaultDesktopAuthCandidates)。 */
export function workbuddyDesktopAuthCandidates(home = homedir(), env = process.env, platform = process.platform) {
  const rel = WORKBUDDY_DESKTOP_RELATIVE_PATH
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', ...rel)]
  if (platform === 'win32') {
    return [join(home, 'AppData', 'Local', ...rel), join(home, 'AppData', 'Roaming', ...rel)]
  }
  if (platform === 'linux') {
    const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config')
    const dataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share')
    return [join(configHome, ...rel), join(dataHome, ...rel)]
  }
  return []
}

/** 解析 DSH home:宿主 peer 依赖优先,失败时按 env → ~/.dsh → 旧约定回退。 */
/** 汇总全部候选路径:env 覆盖 → connect 刷新副本 → 桌面端候选。 */
export function workbuddyAuthCandidates(env = process.env) {
  const candidates = []
  const override = String(env[WORKBUDDY_AUTH_FILE_ENV] ?? '').trim()
  if (override.length > 0) candidates.push(override)
  candidates.push(join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME))
  candidates.push(...workbuddyDesktopAuthCandidates(homedir(), env))
  return candidates
}

function workbuddyError(code, detail = '') {
  const error = new Error(detail.length > 0 ? `${code}: ${detail}` : code)
  error.code = code
  return error
}

/** Only contact the running DSH server; never send credentials or follow redirects. */
export async function fetchWorkBuddyConnectCredits(hostOrigin, { signal, fetchImpl = fetchWorkBuddyLocal } = {}) {
  if (!hostOrigin) return null
  const origin = workBuddyOrigin(hostOrigin)
  let signedOut = false, failure
  for (const path of ['/plugins/dsh-workbuddy-connect/status', '/plugins/dsh-workbuddy-connect/ai/status',
    '/plugins/dsh-connect-workbuddy/usage?region=cn', '/plugins/dsh-connect-workbuddy/usage?region=global']) {
    let response, status
    try {
      response = await fetchWithRetry(new URL(path, origin), {
        method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal,
      }, { timeoutMs: 35000, attempts: 1, fetchImpl })
      if (response.status === 404) { await response.body?.cancel?.(); continue }
      if (!response.ok) { await response.body?.cancel?.(); failure ??= workbuddyError('workbuddyConnectUnavailable'); continue }
      // Some host versions serve the SPA shell for an unregistered plugin route.
      if (response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel?.(); continue }
      status = await readJsonBounded(response)
    } catch (error) {
      signal?.throwIfAborted()
      failure ??= error
      continue
    }
    signal?.throwIfAborted()
    if (status?.enabled === false) { signedOut = true; continue }
    if (status?.status === 'signed-out') {
      signedOut = true
      if (status.reasonCode && status.reasonCode !== 'no-credential' || status.selectionLost) failure ??= workbuddyError('workbuddyConnectLoginFailed')
      continue
    }
    if (status?.status !== 'signed-in' || status.credentialRejected === true) { failure ??= workbuddyError('workbuddyConnectLoginFailed'); continue }
    const credits = status.credits
    if (!credits || typeof credits.total !== 'number' || !Number.isFinite(credits.total) || credits.total < 0
      || credits.unlimited !== undefined && typeof credits.unlimited !== 'boolean') { failure ??= workbuddyError('workbuddyConnectCreditsFailed'); continue }
    const expiry = typeof credits.nearestExpiryMs === 'number' && credits.nearestExpiryMs > 0 && credits.nearestExpiryMs <= 8640000000000000
      ? new Date(credits.nearestExpiryMs).toISOString() : undefined
    // Copy only billing fields. Status also contains identity and control keys.
    return { total: credits.total, unlimited: credits.unlimited === true,
      ...(typeof credits.cycleResetTime === 'string' ? { cycleResetTime: credits.cycleResetTime } : expiry ? { cycleResetTime: expiry } : {}),
      ...(Array.isArray(status.accounts) ? { workbuddy: {
        accounts: status.accounts.filter(row => typeof row?.id === 'string' && validWorkBuddyAccountId('cn:' + row.id)).slice(0, 200).map(row => ({
          id: (path.includes('region=global') ? 'global:' : 'cn:') + row.id,
          name: typeof row.accountName === 'string' ? row.accountName.slice(0, 160) : '',
          region: path.includes('region=global') ? 'global' : 'cn',
          current: row.selected === true,
          remaining: row.id === status.accountId ? credits.total : null,
        })), scope: 'current', incomplete: false,
      } } : {}),
      endpoint: new URL(path, origin).href }
  }
  if (failure) throw failure
  // A signed-out connector is authoritative; an old plaintext copy may belong to another account.
  if (signedOut) throw workbuddyError('workbuddyNotInstalled')
  return null
}

/**
 * 定位并解析 WorkBuddy 凭据;全部候选缺失 → 抛 workbuddyNotInstalled;
 * 命中的文件加密/无法识别 → 抛 workbuddyAuthEncrypted;
 * 文件存在但无 accessToken(已登出)→ 视为缺失继续下一候选。
 * 返回 parseWorkBuddyAuth 的结果。
 */
export function resolveWorkBuddyCredential({ readFile = readFileSync, env = process.env } = {}) {
  const candidates = workbuddyAuthCandidates(env)
  let encrypted = false, expired
  for (const path of candidates) {
    let text
    try { text = readFile(path, 'utf8') } catch { continue }
    if (typeof text !== 'string' || text.trim() === '') continue
    if (isWorkBuddyAuthEncrypted(text)) { encrypted = true; continue }
    const credential = parseWorkBuddyAuth(text)
    if (credential === undefined) continue
    if (isWorkBuddyTokenExpired(credential)) { expired ??= credential; continue }
    return credential
  }
  if (expired) return expired
  if (encrypted) throw workbuddyError('workbuddyAuthEncrypted')
  throw workbuddyError('workbuddyNotInstalled')
}

/** 个人积分响应解析(纯函数):data.Response.Data.Accounts[] → {total, accounts}。 */
export function parseWorkBuddyPersonalCredits(body) {
  const accounts = body?.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return null
  let total = 0
  const parsed = []
  for (const raw of accounts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw workbuddyError('workbuddyInvalidCredits')
    const numberField = key => {
      if (raw[key] === undefined) return undefined
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw workbuddyError('workbuddyInvalidCredits')
      return raw[key]
    }
    const size = numberField('CycleCapacitySize')
    const cycleRemain = numberField('CycleCapacityRemain')
    const cycleUsed = numberField('CycleCapacityUsed')
    const capacityRemain = numberField('CapacityRemain')
    let remain
    if (size > 0) remain = cycleRemain
    else if (cycleRemain > 0 || cycleUsed > 0 || capacityRemain === undefined) remain = cycleRemain
    else remain = capacityRemain
    if (!Number.isFinite(remain)) throw workbuddyError('workbuddyInvalidCredits')
    if (remain < 0) remain = 0
    total += remain
    if (!Number.isFinite(total)) throw workbuddyError('workbuddyInvalidCredits')
    parsed.push({
      packageName: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
      remain,
      size: size > 0 ? size : numberField('CapacitySize'),
    })
  }
  return { total, accounts: parsed }
}

/**
 * CN 企业积分响应解析(纯函数,对齐 upstream fetchEnterpriseCredits):
 * 官方两个调用点字段拼写不一致(limitNum/credit vs limit_num/used_num),两者都收;
 * limit===-1 为「不限量」标记;limit 有值但 used 缺失属硬错误(宁报错不猜 0)。
 */
export function parseWorkBuddyEnterpriseCredits(body) {
  const sources = []
  for (const candidate of [body?.data, body]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if (candidate.data !== null && typeof candidate.data === 'object' && !Array.isArray(candidate.data)) {
      sources.push(candidate.data)
    }
    sources.push(candidate)
  }
  const numberAt = (source, key) => (typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : undefined)
  let limit, used, resetTime
  for (const source of sources) {
    const candidate = numberAt(source, 'limitNum') ?? numberAt(source, 'limit_num')
    if (candidate === undefined) continue
    limit = candidate
    used = numberAt(source, 'credit') ?? numberAt(source, 'used_num')
    if (typeof source.cycleResetTime === 'string' && source.cycleResetTime !== '') resetTime = source.cycleResetTime
    break
  }
  if (limit === undefined) throw workbuddyError('workbuddyEnterpriseNoQuota')
  if (limit === -1) return { total: 0, unlimited: true, ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }) }
  if (limit < 0) throw workbuddyError('workbuddyInvalidCredits')
  if (used === undefined || used < 0) throw workbuddyError('workbuddyEnterpriseNoUsage')
  let remain = limit - used
  if (remain < 0) remain = 0
  return { total: remain, unlimited: false, ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }) }
}

/** 本地时间 'YYYY-MM-DD HH:mm:ss'(对齐 upstream fetchCredits 的 format)。 */
function formatLocalTimestamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 查询 WorkBuddy 积分余额(port 自 upstream.ts fetchCredits/fetchEnterpriseCredits)。
 * 返回 { total, unlimited, accounts, cycleResetTime? }。
 * 登录态失效(HTTP 401/403 或信封 code 401/403)→ 抛 workbuddyTokenExpired(软错误)。
 */
export async function fetchWorkBuddyCredits(credential, { signal, fetchImpl = fetch } = {}) {
  const cnEnterprise = regionOf(credential.domain) === 'cn'
    && credential.enterpriseId !== undefined && credential.enterpriseId !== ''
  const url = cnEnterprise
    ? `${CODEBUDZY_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`
    : `${workbuddyBillingBase(credential)}/v2/billing/meter/get-user-resource`
  const now = new Date()
  const body = cnEnterprise ? {} : {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatLocalTimestamp(now),
    PackageEndTimeRangeEnd: formatLocalTimestamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
  }
  const response = await fetchWithRetry(url, {
    method: 'POST', redirect: 'error',
    headers: billingHeadersOf(credential),
    body: JSON.stringify(body),
    signal,
  }, { timeoutMs: 15000, attempts: 2, fetchImpl })
  if (response.status === 401 || response.status === 403) {
    try { await response.body?.cancel?.() } catch {}
    throw workbuddyError('workbuddyTokenExpired', url)
  }
  if (!response.ok) { await response.body?.cancel?.(); throw new Error(`workbuddy billing HTTP ${response.status}`) }
  const envelope = await readJsonBounded(response)
  signal?.throwIfAborted()
  if (envelope === null || typeof envelope !== 'object') throw new Error(`workbuddy billing returned non-JSON (${url})`)
  if (envelope.code !== undefined && String(envelope.code) !== '0') {
    if (['401', '403'].includes(String(envelope.code))) throw workbuddyError('workbuddyTokenExpired', url)
    throw workbuddyError('workbuddyBillingFailed')
  }
  if (cnEnterprise) {
    const parsed = parseWorkBuddyEnterpriseCredits(envelope)
    return { total: parsed.total, unlimited: parsed.unlimited === true, accounts: [], ...parsed }
  }
  const parsed = parseWorkBuddyPersonalCredits(envelope)
  if (parsed === null) throw new Error(`workbuddy billing response carried no Accounts list (${url})`)
  return { total: parsed.total, unlimited: false, ...parsed }
}
