// 官方配置项图标：与 DSH 客户端注册表一致（图标资源取自 DSH 客户端，MIT）。
// 同步给移动端，避免客户端各自内置一份导致版本漂移。
const OFFICIAL_ITEM_ICONS = Object.freeze({
  'subagent': '<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="14.9893" y="15.1877" width="12.2365" height="12.2365" rx="2" fill="url(#dsh_plugin_art_R0a)" fill-opacity="0.8"></rect><rect x="8.87109" y="9.0697" width="12.2365" height="12.2365" rx="2" fill="url(#dsh_plugin_art_R0b)" fill-opacity="0.8"></rect><defs><linearGradient id="dsh_plugin_art_R0a" x1="21.1075" y1="15.1877" x2="21.1075" y2="27.4243" gradientUnits="userSpaceOnUse"><stop stop-color="#45E7A4"></stop><stop offset="1" stop-color="#05909D"></stop></linearGradient><linearGradient id="dsh_plugin_art_R0b" x1="14.9894" y1="9.0697" x2="14.9894" y2="21.3063" gradientUnits="userSpaceOnUse"><stop stop-color="#69B9FF"></stop><stop offset="1" stop-color="#324DE2"></stop></linearGradient></defs></svg>',
  'web-search': '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 36 36"><path stroke="#658EFF" stroke-width="3" d="m26.536 26.987-4.155-4.155"/><circle cx="15.766" cy="16.216" r="6.206" stroke="url(#a)" stroke-width="4"/><defs><linearGradient id="a" x1="7.561" x2="23.972" y1="8.01" y2="24.422" gradientUnits="userSpaceOnUse"><stop stop-color="#41E1AC"/><stop offset=".65" stop-color="#658EFF"/><stop offset="1" stop-color="#41E1AC"/></linearGradient></defs></svg>',
  'shell': '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 36 36"><path stroke="#679EFE" stroke-width="3.5" d="m10 11 6.606 6.606a.2.2 0 0 1 0 .283L10 24.495m10.121 0h6.748"/></svg>',
  'agent-loop': '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 36 36"><path fill="#A797FC" d="M18.049 28.49c-5.963 0-10.797-4.834-10.797-10.797 5.963 0 10.797 4.834 10.797 10.797"/><path fill="url(#a)" d="M18.049 6.897c-5.963 0-10.797 4.833-10.797 10.796 5.963 0 10.797-4.834 10.797-10.796"/><path fill="#4561EE" d="M18.049 28.49c5.962 0 10.796-4.834 10.796-10.797-5.963 0-10.796 4.834-10.796 10.797"/><path fill="#658EFF" d="M18.049 6.897c5.962 0 10.796 4.833 10.796 10.796-5.963 0-10.796-4.834-10.796-10.796"/><defs><linearGradient id="a" x1="16.791" x2="8.982" y1="16.166" y2="8.743" gradientUnits="userSpaceOnUse"><stop stop-color="#A23AE7"/><stop offset="1" stop-color="#E2E2E2"/></linearGradient></defs></svg>',
})

// 插件自身未提供图标时，DSH 客户端使用的默认图标（同样随目录下发）。
const DEFAULT_PLUGIN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="66" viewBox="0 0 70 66" fill="none">\n  <defs>\n    <linearGradient id="dshPlugArt" x1="62" y1="4" x2="12" y2="62" gradientUnits="userSpaceOnUse">\n      <stop stop-color="#8FE0EA"/><stop offset=".45" stop-color="#6FA8FF"/><stop offset="1" stop-color="#5C8CFF"/>\n    </linearGradient>\n  </defs>\n  <path d="M51.00 2.00 Q61.50 2.00 64.50 5.00 Q67.50 8.00 68.00 12.25 Q68.50 16.50 67.50 19.50 Q66.50 22.50 64.50 24.00 Q62.50 25.50 57.25 26.00 Q52.00 26.50 49.75 28.25 Q47.50 30.00 48.25 33.00 Q49.00 36.00 55.75 37.00 Q62.50 38.00 64.50 39.50 Q66.50 41.00 67.50 44.00 Q68.50 47.00 68.00 52.75 Q67.50 58.50 64.50 61.00 Q61.50 63.50 54.25 63.50 Q47.00 63.50 44.50 60.50 Q42.00 57.50 42.00 52.75 Q42.00 48.00 40.75 46.25 Q39.50 44.50 34.25 45.00 Q29.00 45.50 27.75 47.25 Q26.50 49.00 26.50 52.25 Q26.50 55.50 25.50 58.00 Q24.50 60.50 22.00 62.00 Q19.50 63.50 12.75 63.50 Q6.00 63.50 6.50 62.75 Q7.00 62.00 6.00 61.75 Q5.00 61.50 3.50 58.50 Q2.00 55.50 2.00 50.75 Q2.00 46.00 3.00 44.50 Q4.00 43.00 7.50 41.00 Q11.00 39.00 14.75 39.00 Q18.50 39.00 20.75 37.25 Q23.00 35.50 23.50 28.75 Q24.00 22.00 26.00 21.00 Q28.00 20.00 35.25 19.50 Q42.50 19.00 44.25 12.00 Q46.00 5.00 48.50 3.75 L51.00 2.50 Z" fill="url(#dshPlugArt)"/>\n  <circle cx="11" cy="10.5" r="9" fill="#5CD0F1"/>\n</svg>'

const OFFICIAL_CONFIGURATION_ITEMS = Object.freeze([
  { id: 'shell', namespaces: ['bash-sandbox', 'pwsh-sandbox'] },
  { id: 'agent-loop', namespaces: ['agent-loop'] },
  { id: 'subagent', namespaces: ['subagent', 'subagent-model-selection-settings'] },
  { id: 'web-search', namespaces: ['web-search-deepseek'] },
])

export const PLUGIN_REQUEST_TYPES = new Set([
  'plugin-catalog',
  'plugin-market-indexes',
  'plugin-market-set-indexes',
  'plugin-market-search',
  'plugin-registries',
  'plugin-inspect',
  'plugin-install',
  'plugin-install-status',
  'plugin-install-cancel',
  'plugin-bundle-set-enabled',
  'plugin-entry-set-enabled',
  'plugin-remove',
  'plugin-credential-describe',
  'plugin-credential-set',
  'plugin-translation-limits',
  'plugin-settings',
  'plugin-settings-mutate',
  'plugin-version-exemptions',
  'plugin-version-exemption-set',
])

const FLAT_RESPONSE_TYPES = new Set([
  'plugin-catalog', 'plugin-registries', 'plugin-settings',
  'plugin-settings-mutate', 'plugin-version-exemptions',
])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value, maxLength = 2048) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function badRequest(type, requestId, message) {
  return { kind: 'error', code: 'bad-request', message, requestType: type,
    ...(requestId === undefined ? {} : { requestId }) }
}

function registryOption(msg, type, requestId) {
  if (msg.registry === undefined) return { value: undefined }
  if (msg.registry === null || (nonempty(msg.registry) && /^https?:\/\//i.test(msg.registry))) {
    return { value: msg.registry }
  }
  return { error: badRequest(type, requestId, 'registry must be null or an HTTP(S) URL') }
}

function requireName(msg, field, type, requestId) {
  if (!nonempty(msg[field], 512)) return { error: badRequest(type, requestId, `${field} must be a non-empty string`) }
  return { value: msg[field].trim() }
}

async function pluginCatalog(api) {
  const inventory = await api.plugins.inventory()
  if (!record(inventory) || !Array.isArray(inventory.entries)) throw new Error('pluginInventory/list returned an invalid inventory')
  if (inventory.managementAvailable !== true) {
    return { managementAvailable: false, bundles: [], plugins: [], officialItems: [], settingsWritable: false }
  }
  const [bundles, plugins, settings] = await Promise.all([
    api.plugins.listBundles(),
    api.plugins.listPlugins(),
    api.settings.describe(),
  ])
  if (!Array.isArray(bundles) || !Array.isArray(plugins) || !Array.isArray(settings?.namespaces)) {
    throw new Error('plugin manager returned an invalid catalog')
  }
  const available = new Set(settings.namespaces.map(item => item.ns))
  const officialItems = OFFICIAL_CONFIGURATION_ITEMS
    .filter(item => item.namespaces.some(ns => available.has(ns)))
    .map(item => ({
      id: item.id,
      namespaces: item.namespaces.filter(ns => available.has(ns)),
      icon: OFFICIAL_ITEM_ICONS[item.id] || null,
    }))
  return {
    managementAvailable: true,
    bundles: bundles.map(bundle => ({
      ...bundle,
      experimental: bundle.name.startsWith('@deepseek-ai/dsh-experimental-'),
    })),
    plugins,
    officialItems,
    // 插件自身无图标时客户端用它（与 DSH 客户端默认图标一致）
    defaultPluginIcon: DEFAULT_PLUGIN_ICON,
    settingsWritable: settings.writable === true,
  }
}

/**
 * The mobile wire owns its request names and correlation ids. The Host adapter
 * owns Typert endpoint names and argument descriptors.
 */
export async function handlePluginQuery(api, msg, { onInstallStart, onInstallEnd } = {}) {
  const type = msg?.type
  if (!PLUGIN_REQUEST_TYPES.has(type)) return null
  const requestId = nonempty(msg.requestId, 128) ? msg.requestId.trim() : undefined
  if (!requestId) return badRequest(type, undefined, `${type} requires a requestId`)

  try {
    let value
    let kind = type
    if (type === 'plugin-market-indexes') {
      value = await api.pluginMarket.listIndexes()
    } else if (type === 'plugin-market-set-indexes') {
      if (!Array.isArray(msg.urls) || msg.urls.length > 100 || msg.urls.some(url => !nonempty(url, 2048))) return badRequest(type, requestId, 'urls must be an array of index URLs')
      // Host validates and normalizes new URLs and preserves existing invalid sources for removal.
      await api.pluginMarket.setIndexes(msg.urls)
      value = { saved: true }
    } else if (type === 'plugin-market-search') {
      if (!nonempty(msg.url, 2048) || !record(msg.query)) return badRequest(type, requestId, 'url and query are required')
      const query = msg.query
      if (!Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 2048))) return badRequest(type, requestId, 'invalid market query')
      if (!record(query.sort) || query.sort.kind !== 'index') return badRequest(type, requestId, 'unsupported sort')
      if (query.fetchedAt !== undefined && (typeof query.fetchedAt !== 'number' || !Number.isFinite(query.fetchedAt))) return badRequest(type, requestId, 'invalid fetchedAt')
      if (query.category !== undefined && !nonempty(query.category, 2048)) return badRequest(type, requestId, 'invalid category')
      value = await api.pluginMarket.search(msg.url, { offset: query.offset, limit: query.limit, sort: { kind: 'index' }, ...(query.category === undefined ? {} : { category: query.category }), ...(query.text ? { text: query.text } : {}), ...(query.fetchedAt === undefined ? {} : { fetchedAt: query.fetchedAt }) })
    } else if (type === 'plugin-catalog') {
      value = await pluginCatalog(api)
    } else if (type === 'plugin-registries') {
      value = await api.plugins.registries()
    } else if (type === 'plugin-inspect' || type === 'plugin-install') {
      const spec = requireName(msg, 'spec', type, requestId)
      if (spec.error) return spec.error
      const registry = registryOption(msg, type, requestId)
      if (registry.error) return registry.error
      if (type === 'plugin-inspect') {
        value = await api.plugins.inspect(spec.value, registry.value === undefined ? undefined : { registry: registry.value })
        kind = 'plugin-inspection'
      } else {
        if (msg.enabled !== undefined && typeof msg.enabled !== 'boolean') {
          return badRequest(type, requestId, 'enabled must be a boolean')
        }
        if (msg.approvedBuilds !== undefined && (!Array.isArray(msg.approvedBuilds)
          || msg.approvedBuilds.length > 100 || msg.approvedBuilds.some(name => !nonempty(name, 512)))) {
          return badRequest(type, requestId, 'approvedBuilds must be an array of package names')
        }
        const options = {
          requestId,
          ...(msg.enabled === undefined ? {} : { enabled: msg.enabled }),
          ...(registry.value === undefined ? {} : { registry: registry.value }),
          ...(msg.approvedBuilds === undefined ? {} : { approvedBuilds: msg.approvedBuilds }),
        }
        onInstallStart?.(requestId)
        try {
          value = await api.plugins.installBundle(spec.value, options)
        } finally {
          onInstallEnd?.(requestId)
        }
        kind = 'plugin-install-result'
      }
    } else if (type === 'plugin-install-status' || type === 'plugin-install-cancel') {
      const installId = requireName(msg, 'installId', type, requestId)
      if (installId.error) return installId.error
      value = type === 'plugin-install-status'
        ? await api.plugins.waitForInstall(installId.value)
        : await api.plugins.cancelInstall(installId.value)
    } else if (type === 'plugin-bundle-set-enabled' || type === 'plugin-entry-set-enabled') {
      const field = type === 'plugin-bundle-set-enabled' ? 'name' : 'entryId'
      const target = requireName(msg, field, type, requestId)
      if (target.error) return target.error
      if (typeof msg.enabled !== 'boolean') return badRequest(type, requestId, 'enabled must be a boolean')
      value = type === 'plugin-bundle-set-enabled'
        ? await api.plugins.setBundleEnabled(target.value, msg.enabled)
        : await api.plugins.setPluginEnabled(target.value, msg.enabled)
    } else if (type === 'plugin-remove') {
      const name = requireName(msg, 'name', type, requestId)
      if (name.error) return name.error
      value = await api.plugins.removeBundle(name.value)
    } else if (type === 'plugin-translation-limits') {
      value = await api.pluginConfiguration.translationLimits()
    } else if (type === 'plugin-credential-describe' || type === 'plugin-credential-set') {
      if (typeof msg.ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(msg.ref)) return badRequest(type, requestId, 'invalid credential reference')
      const settings = await api.settings.describe()
      const scopes = (settings.namespaces || []).filter(item => ['web-search-deepseek', 'web-deepseek-api'].includes(item.ns))
      if (!scopes.some(item => (item.value?.apiKeyEnv || 'DEEPSEEK_API_KEY') === msg.ref)) return badRequest(type, requestId, 'reference is not used by web search')
      if (type === 'plugin-credential-set') {
        if (settings.writable !== true) return badRequest(type, requestId, 'settings are read-only')
        if (typeof msg.value !== 'string' || !msg.value.trim() || msg.value.length > 8192) return badRequest(type, requestId, 'invalid credential value')
        try { await api.pluginConfiguration.credentialSet(msg.ref, msg.value) }
        catch { return { kind: 'error', code: 'plugin-credentials/write-failed', message: 'Credential write failed', requestId, requestType: type } }
        value = { saved: true }
      } else {
        const descriptions = await api.pluginConfiguration.credentialDescribe(msg.ref)
        const view = descriptions[msg.ref]
        value = { configured: view?.configured === true, writable: settings.writable === true && view?.writable === true }
      }
    } else if (type === 'plugin-settings') {
      const described = await api.settings.describe()
      if (!record(described) || !Array.isArray(described.namespaces)) throw new Error('settings/describe returned an invalid response')
      if (msg.ns !== undefined) {
        const ns = requireName(msg, 'ns', type, requestId)
        if (ns.error) return ns.error
        const namespace = described.namespaces.find(item => item.ns === ns.value)
        if (!namespace) return { kind: 'error', code: 'plugin-settings/not-found',
          message: `settings namespace is unavailable: ${ns.value}`, requestType: type, requestId }
        value = { writable: described.writable === true, namespace }
      } else {
        value = described
      }
    } else if (type === 'plugin-settings-mutate') {
      const ns = requireName(msg, 'ns', type, requestId)
      if (ns.error) return ns.error
      if (!Number.isSafeInteger(msg.expectedRevision) || msg.expectedRevision < 0) {
        return badRequest(type, requestId, 'expectedRevision must be a non-negative integer')
      }
      if (!Array.isArray(msg.ops) || msg.ops.length < 1 || msg.ops.length > 100
        || msg.ops.some(op => !record(op) || !['set', 'unset'].includes(op.op)
          || !Array.isArray(op.path) || op.path.some(part => !nonempty(part, 256))
          || (op.op === 'set' && !Object.hasOwn(op, 'value')))) {
        return badRequest(type, requestId, 'ops must contain valid set or unset path edits')
      }
      value = await api.settings.mutate({ ns: ns.value, ops: msg.ops, expectedRevision: msg.expectedRevision })
    } else if (type === 'plugin-version-exemptions') {
      value = await api.plugins.listVersionExemptions()
    } else if (type === 'plugin-version-exemption-set') {
      const packageVersion = requireName(msg, 'packageVersion', type, requestId)
      const runtimeVersion = requireName(msg, 'runtimeVersion', type, requestId)
      if (packageVersion.error || runtimeVersion.error) return packageVersion.error || runtimeVersion.error
      if (typeof msg.enabled !== 'boolean' || (msg.acceptRisk !== undefined && typeof msg.acceptRisk !== 'boolean')) {
        return badRequest(type, requestId, 'enabled and acceptRisk must be booleans')
      }
      value = await api.plugins.setVersionExemption(packageVersion.value, runtimeVersion.value,
        msg.enabled, msg.acceptRisk)
    }
    return { kind, requestId, ...(FLAT_RESPONSE_TYPES.has(type) && record(value)
      ? value : { result: value }) }
  } catch (error) {
    return { kind: 'error', code: error?.code || 'internal',
      message: error?.message || String(error), requestType: type, requestId }
  }
}
