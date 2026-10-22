/** Token Rhythm 账户可用余额（#290）；复用余额缓存及 DSH 只写凭据库。 */
import { credentialRef } from './credentials-shim.mjs'
import { fetchWithRetry, readJsonBounded } from './net.mjs'

// 与官方网站账户页相同的 wallet summary / availableBalanceCny，见 docs/tokenrhythm-balance.md。
export const TOKENRHYTHM_BALANCE_URL = 'https://tokenrhythm.studio/api/wallet/summary'
export const TOKENRHYTHM_BALANCE_CREDENTIAL_VARS = ['TOKENRHYTHM_COOKIE']
const messages = {
  zh: {
    missing: '请填写 Token Rhythm 网站登录 Cookie（tr_session，不是模型 API Key）',
    cookie: 'Token Rhythm Cookie 格式无效，请填写 tr_session 或包含它的 Cookie',
    network: 'Token Rhythm 余额网络请求失败，请稍后重试',
    redirect: 'Token Rhythm 余额接口发生重定向，已拒绝转发 Cookie',
    permission: 'Token Rhythm 登录已失效或无权查询，请登录官网后更新 Cookie',
    http: 'Token Rhythm 余额接口返回 HTTP {status}',
    payload: 'Token Rhythm 余额响应无效或过大，请稍后重试',
    amount: 'Token Rhythm 未返回有效的可用余额，未将其视为零余额',
    currency: 'Token Rhythm 余额币种不是 CNY，请检查平台接口',
  },
  en: {
    missing: 'Enter the Token Rhythm website session cookie (tr_session, not a model API key)',
    cookie: 'Invalid Token Rhythm cookie; enter tr_session or a Cookie header containing it',
    network: 'Token Rhythm balance network request failed; please retry later',
    redirect: 'Token Rhythm balance redirect refused to protect the cookie',
    permission: 'Token Rhythm session expired or access denied; sign in on the website and update the cookie',
    http: 'Token Rhythm balance returned HTTP {status}',
    payload: 'Token Rhythm balance response is invalid or too large; please retry later',
    amount: 'Token Rhythm returned no valid available balance; it was not treated as zero',
    currency: 'Token Rhythm balance currency is not CNY; check the platform API',
  },
}
const failure = (locale, key, status = '') => new Error(messages[locale === 'en' ? 'en' : 'zh'][key].replace('{status}', String(status)))

export function parseTokenRhythmCookie(value, locale = 'zh') {
  const text = String(value ?? '').trim()
  if (!text || text.length > 16384 || /[\r\n]/.test(text)) throw failure(locale, 'cookie')
  if (/^[A-Za-z0-9._-]+$/.test(text)) return text
  const parts = text.replace(/^Cookie:\s*/i, '').split(';').map(part => part.trim())
  const sessions = parts.filter(part => /^tr_session\s*=/.test(part))
  const match = sessions.length === 1 && /^tr_session\s*=\s*([A-Za-z0-9._-]+)$/.exec(sessions[0])
  if (!match) throw failure(locale, 'cookie')
  return match[1]
}

export function parseTokenRhythmBalance(payload, locale = 'zh') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure(locale, 'payload')
  // 官网成功码为 0 / 200（兼容字符串）；拒绝夹带余额的业务错误，不回显原始响应。
  if ((payload.code !== undefined && ![0, '0', 200, '200'].includes(payload.code)) || payload.success === false) throw failure(locale, 'permission')
  const data = Object.hasOwn(payload, 'data') ? payload.data : payload
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure(locale, 'payload')
  if (data.currency !== undefined && data.currency !== 'CNY') throw failure(locale, 'currency')
  const raw = Object.hasOwn(data, 'availableBalanceCny') ? data.availableBalanceCny : data.available_balance_cny
  const text = typeof raw === 'string' ? raw.trim() : ''
  const remaining = typeof raw === 'number' ? raw : /^[+-]?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN
  if (!Number.isFinite(remaining)) throw failure(locale, 'amount')
  // 可用余额与累计消费/赠额/冻结金额分开；接口没有预算上限时不伪造百分比。
  return { remaining, unit: 'CNY', maxBudget: null, spend: null }
}

export async function queryTokenRhythmBalance(ctx, config, { fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted()
  const locale = config?.locale
  let value
  try { value = (await ctx?.get?.('credentials')?.resolve(credentialRef('TOKENRHYTHM_COOKIE')))?.value } catch { /* 回落环境变量。 */ }
  if (typeof value !== 'string' || !value.trim()) value = process.env.TOKENRHYTHM_COOKIE
  if (!value?.trim()) throw Object.assign(failure(locale, 'missing'), { soft: true })
  const session = parseTokenRhythmCookie(value, locale)
  let response
  try {
    response = await fetchWithRetry(TOKENRHYTHM_BALANCE_URL, {
      method: 'GET', redirect: 'manual', signal,
      headers: {
        Accept: 'application/json', Cookie: 'tr_session=' + session,
        Referer: 'https://tokenrhythm.studio/account', Origin: 'https://tokenrhythm.studio',
        'User-Agent': 'Mozilla/5.0 (compatible; dsh-cost-meter)',
      },
    }, { attempts: 2, timeoutMs: 15000, fetchImpl })
  } catch {
    signal?.throwIfAborted()
    throw failure(locale, 'network')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status >= 300 && response.status < 400) throw failure(locale, 'redirect')
    if (response.status === 401 || response.status === 403) throw failure(locale, 'permission')
    throw failure(locale, 'http', response.status)
  }
  let payload
  try { payload = await readJsonBounded(response) } catch {
    signal?.throwIfAborted()
    throw failure(locale, 'payload')
  }
  signal?.throwIfAborted()
  return { label: config?.customBalance?.label || 'Token Rhythm', ...parseTokenRhythmBalance(payload, locale) }
}
