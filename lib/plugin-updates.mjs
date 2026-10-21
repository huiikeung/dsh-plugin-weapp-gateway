export const PLUGIN_PACKAGE_NAME = 'dsh-plugin-weapp-gateway'
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PLUGIN_PACKAGE_NAME}/latest`

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null
  return { core: match.slice(1, 4), prerelease }
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error('Expected valid semantic versions')
  for (let index = 0; index < 3; index += 1) {
    const result = compareNumericStrings(a.core[index], b.core[index])
    if (result !== 0) return result
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const count = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const leftId = a.prerelease[index]
    const rightId = b.prerelease[index]
    const leftNumeric = /^\d+$/.test(leftId)
    const rightNumeric = /^\d+$/.test(rightId)
    if (leftNumeric && rightNumeric) {
      const result = compareNumericStrings(leftId, rightId)
      if (result !== 0) return result
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1
    }
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1
}

export async function checkPluginUpdate({ currentVersion, fetchImpl = globalThis.fetch }) {
  if (!parseVersion(currentVersion)) throw new Error('Current plugin version is invalid')
  if (typeof fetchImpl !== 'function') throw new Error('This runtime does not support online update checks')
  const response = await fetchImpl(REGISTRY_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
  const metadata = await response.json()
  if (metadata?.name !== PLUGIN_PACKAGE_NAME || !parseVersion(metadata?.version)) {
    throw new Error('npm registry returned invalid plugin metadata')
  }
  const latestVersion = metadata.version
  return {
    packageName: PLUGIN_PACKAGE_NAME,
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
  }
}

export async function installLatestPlugin({ api, currentVersion, fetchImpl = globalThis.fetch, requestId }) {
  const update = await checkPluginUpdate({ currentVersion, fetchImpl })
  if (!update.updateAvailable) return { ...update, installed: false, reason: 'already-current' }

  const command = `dsh plugin --profile web add ${PLUGIN_PACKAGE_NAME}@${update.latestVersion}`
  let inventory
  try {
    inventory = await api.plugins.inventory()
  } catch (error) {
    return { ...update, installed: false, reason: 'plugin-manager-unavailable', command, detail: error?.message }
  }
  if (inventory?.managementAvailable !== true) {
    return { ...update, installed: false, reason: 'plugin-manager-unavailable', command }
  }

  const installation = await api.plugins.installBundle(
    `${PLUGIN_PACKAGE_NAME}@${update.latestVersion}`,
    { requestId },
  )
  return { ...update, installed: true, installation }
}
