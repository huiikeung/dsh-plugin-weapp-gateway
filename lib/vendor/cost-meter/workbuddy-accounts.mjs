import { fetchWorkBuddyLocal, workBuddyOrigin } from './workbuddy-transport.mjs'
import { fetchWithRetry, readJsonBounded } from './net.mjs'

export const validWorkBuddyAccountId = id => typeof id === 'string' && /^(cn|global):[^\s\u0000-\u001f\u007f]{1,256}$/.test(id)
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Read the connector's published per-account endpoint; never switch its active account. */
export async function fetchWorkBuddyAccounts(hostOrigin, config = {}, { signal, fetchImpl = fetchWorkBuddyLocal } = {}) {
  if (!hostOrigin) return null
  const origin = workBuddyOrigin(hostOrigin)
  const results = await Promise.all(['cn', 'global'].map(async region => {
    try {
      const response = await fetchWithRetry(new URL('/plugins/dsh-connect-workbuddy/account-credits?region=' + region, origin),
        { method: 'GET', redirect: 'error', signal }, { attempts: 1, timeoutMs: 35000, fetchImpl })
      if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel?.(); return { missing: true } }
      if (!response.ok) { await response.body?.cancel?.(); return { failed: true } }
      const body = await readJsonBounded(response)
      if (!Array.isArray(body?.accounts) || body.accounts.length > 200) return { failed: true }
      const seen = new Set(), accounts = []
      for (const row of body.accounts) {
        const id = region + ':' + row?.id
        if (!validWorkBuddyAccountId(id) || typeof row?.id !== 'string' || seen.has(id)) return { failed: true }
        seen.add(id)
        accounts.push({ id, region, name: typeof row.accountName === 'string' ? row.accountName.slice(0, 160) : '',
          current: row.selected === true, remaining: amount(row.credits) ? row.credits : null })
      }
      return { accounts }
    } catch { signal?.throwIfAborted(); return { failed: true } }
  }))
  // An older connector has no account list; its selected-account route remains usable.
  if (!results.some(result => result.accounts)) return null
  const accounts = results.flatMap(result => result.accounts ?? [])
  const scope = ['all', 'selected'].includes(config.accountScope) ? config.accountScope : 'current'
  const ids = new Set(Array.isArray(config.accountIds) ? config.accountIds : [])
  if (scope === 'selected') for (const id of ids) if (validWorkBuddyAccountId(id) && !accounts.some(row => row.id === id)) {
    accounts.push({ id, region: id.split(':')[0], name: '', current: false, remaining: null })
  }
  const selected = accounts.filter(row => scope === 'all' || (scope === 'current' ? row.current : ids.has(row.id)))
  const known = selected.filter(row => row.remaining !== null)
  return { scope, accounts, selectedIds: selected.map(row => row.id),
    knownRemaining: known.reduce((sum, row) => sum + row.remaining, 0),
    unknownCount: selected.length - known.length,
    incomplete: results.some(result => result.failed), fetchedAt: Date.now() }
}
