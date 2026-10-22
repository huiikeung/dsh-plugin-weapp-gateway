/** Factory billing limits (#263); fixed read-only endpoint, no model requests.
 * Protocol reference: Dalizi2026/dsh-factory-provider@801c3a2, lib/quota.js.
 */
import { fetchWithRetry, readJsonBounded } from './net.mjs'

export const FACTORY_QUOTA_URL = 'https://api.factory.ai/api/billing/limits'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const normalizeFactoryOrgId = value => {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' || /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : null
}

export function parseFactoryQuota(payload, pool = 'standard', nowMs = Date.now()) {
  if (!record(payload?.limits)) return null
  const windows = {}
  for (const bucket of pool === 'both' ? ['standard', 'core'] : [pool === 'core' ? 'core' : 'standard']) {
    const limits = payload.limits[bucket]
    if (!record(limits)) continue
    for (const name of ['fiveHour', 'weekly', 'monthly']) {
      const raw = limits[name]
      if (!record(raw) || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent) || raw.usedPercent < 0 || raw.usedPercent > 100) continue
      let resetsAt = ''
      const end = typeof raw.windowEnd === 'string' ? Date.parse(raw.windowEnd) : NaN
      if (Number.isFinite(end)) resetsAt = new Date(end).toISOString()
      else if (typeof raw.secondsRemaining === 'number' && Number.isFinite(raw.secondsRemaining) && raw.secondsRemaining >= 0) {
        const reset = nowMs + raw.secondsRemaining * 1000
        if (Number.isFinite(reset) && Math.abs(reset) <= 8640000000000000) resetsAt = new Date(reset).toISOString()
      }
      windows[bucket === 'core' ? 'core_' + name : name] = { percent: raw.usedPercent, resetsAt }
    }
  }
  return Object.keys(windows).length ? windows : null
}

export async function queryFactoryQuota(key, locale, t, { orgId, factoryPool, signal } = {}) {
  const provider = 'Factory (Droid)'
  const failure = (code, vars = {}, soft = false) => Object.assign(new Error(t(locale, code, { provider, ...vars })), { soft })
  if (typeof key !== 'string' || !key.trim()) throw failure('codingPlanKeyMissing', {}, true)
  const org = normalizeFactoryOrgId(orgId)
  if (org === null) throw failure('factoryOrgInvalid')
  const headers = {
    authorization: `Bearer ${key.trim()}`, 'x-client-version': '0.231.0',
    'x-factory-client': 'cli', accept: 'application/json', 'accept-encoding': 'identity',
  }
  if (org) headers['x-factory-org-id'] = org
  let response
  try {
    response = await fetchWithRetry(FACTORY_QUOTA_URL, { method: 'GET', headers, redirect: 'manual', signal }, { timeoutMs: 15000, attempts: 2 })
  } catch {
    signal?.throwIfAborted()
    throw failure('factoryQueryFailed')
  }
  if (!response.ok) {
    try { await response.body?.cancel?.() } catch {}
    if (response.status === 401 || response.status === 403) throw failure('factoryUnauthorized', {}, true)
    throw failure('codingPlanHttp', { code: String(response.status), url: FACTORY_QUOTA_URL })
  }
  let payload
  try { payload = await readJsonBounded(response) } catch {
    signal?.throwIfAborted()
    throw failure('codingPlanNoUsage')
  }
  signal?.throwIfAborted()
  const windows = parseFactoryQuota(payload, factoryPool)
  if (windows === null) throw failure('codingPlanNoUsage')
  return { windows, endpoint: FACTORY_QUOTA_URL }
}
