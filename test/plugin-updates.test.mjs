import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  checkPluginUpdate,
  compareVersions,
  formatPluginInstallError,
  installLatestPlugin,
  PLUGIN_PACKAGE_NAME,
} from '../lib/plugin-updates.mjs'

assert.equal(compareVersions('0.8.9', '0.8.8'), 1)
assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0)
assert.throws(() => compareVersions('01.0.0', '1.0.0'), /valid semantic versions/)
assert.equal(formatPluginInstallError({ code: 'ERR_INSTALL', message: 'Package manager refused the update' }),
  'ERR_INSTALL: Package manager refused the update')
assert.equal(formatPluginInstallError({ error: { message: 'Registry request failed' } }), 'Registry request failed')
assert.equal(formatPluginInstallError({ message: 'token=hidden', accessToken: 'secret-value' }), 'token=hidden')
assert.doesNotMatch(formatPluginInstallError({ reason: 'blocked', accessToken: 'secret-value' }), /secret-value/)
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /result\.installation\?\.errorMessage/)
assert.doesNotMatch(clientSource, /\$\{result\.installation\.error\}/)

let registryCalls = 0
const fetchImpl = async (url, options) => {
  registryCalls += 1
  assert.equal(url, `https://registry.npmjs.org/${PLUGIN_PACKAGE_NAME}/latest`)
  assert.equal(options.headers.accept, 'application/json')
  assert.ok(options.signal)
  return { ok: true, json: async () => ({ name: PLUGIN_PACKAGE_NAME, version: '0.8.9' }) }
}

assert.deepEqual(await checkPluginUpdate({ currentVersion: '0.8.8', fetchImpl }), {
  packageName: PLUGIN_PACKAGE_NAME,
  currentVersion: '0.8.8',
  latestVersion: '0.8.9',
  updateAvailable: true,
})
assert.equal(registryCalls, 1)
await assert.rejects(checkPluginUpdate({ currentVersion: '0.8.8', fetchImpl: async () => ({
  ok: true,
  json: async () => ({ name: 'unexpected-package', version: '9.9.9' }),
}) }), /invalid plugin metadata/)
await assert.rejects(checkPluginUpdate({ currentVersion: '0.8.8', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/)

const installCalls = []
const updateCalls = []
const api = { plugins: {
  async inventory() { return { managementAvailable: true } },
  async listBundles() {
    return [{ name: PLUGIN_PACKAGE_NAME, installed: true, enabled: true, source: `${PLUGIN_PACKAGE_NAME}@0.8.8` }]
  },
  async removeBundle(name) { updateCalls.push(['remove', name]); return { application: 'applied' } },
  async installBundle(...args) { installCalls.push(args); return { application: 'restart-required', pendingBuilds: [] } },
} }
const installed = await installLatestPlugin({
  api,
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-1',
})
assert.equal(installed.installed, true)
assert.equal(installed.installation.application, 'restart-required')
assert.deepEqual(updateCalls, [['remove', PLUGIN_PACKAGE_NAME]])
assert.deepEqual(installCalls, [[`${PLUGIN_PACKAGE_NAME}@0.8.9`, {
  requestId: 'update-request-1', saveExact: true, enabled: true,
}]])

const noHmrCalls = []
const noHmrUpdate = await installLatestPlugin({
  api: { plugins: {
    async inventory() { return { managementAvailable: true } },
    async listBundles() {
      return [{ name: PLUGIN_PACKAGE_NAME, installed: true, enabled: false, source: `${PLUGIN_PACKAGE_NAME}@0.8.8` }]
    },
    async removeBundle() { return { application: 'failed', error: { code: 'stop-profile' } } },
    async installBundle(...args) { noHmrCalls.push(args); return { application: 'restart-required' } },
  } },
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-no-hmr',
})
assert.equal(noHmrUpdate.installation.application, 'restart-required')
assert.deepEqual(noHmrCalls, [[`${PLUGIN_PACKAGE_NAME}@0.8.9`, {
  requestId: 'update-request-no-hmr', saveExact: true, enabled: false,
}]])

const rollbackCalls = []
const rolledBack = await installLatestPlugin({
  api: { plugins: {
    async inventory() { return { managementAvailable: true } },
    async listBundles() {
      return [{ name: PLUGIN_PACKAGE_NAME, installed: true, enabled: true, source: 'link:D:/plugins/gateway' }]
    },
    async removeBundle() { return { application: 'applied' } },
    async installBundle(...args) {
      rollbackCalls.push(args)
      return rollbackCalls.length === 1
        ? { application: 'failed', error: { code: 'ERR_REGISTRY', message: 'download failed' } }
        : { application: 'restart-required' }
    },
  } },
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-rollback',
})
assert.match(rolledBack.installation.errorMessage, /previous version was restored/)
assert.equal(rollbackCalls[0][0], `${PLUGIN_PACKAGE_NAME}@0.8.9`)
assert.equal(rollbackCalls[1][0], 'link:D:/plugins/gateway')
assert.deepEqual(rollbackCalls[1][1], { enabled: true })

const refusedRemoval = await installLatestPlugin({
  api: { plugins: {
    async inventory() { return { managementAvailable: true } },
    async listBundles() {
      return [{ name: PLUGIN_PACKAGE_NAME, installed: true, enabled: true }]
    },
    async removeBundle() { return { application: 'failed', error: { code: 'not-removable' } } },
    async installBundle() { assert.fail('must not install if the old bundle was not removed') },
  } },
  currentVersion: '0.8.8',
  fetchImpl,
})
assert.equal(refusedRemoval.installation.errorMessage, 'not-removable')

const failedUpdate = await installLatestPlugin({
  api: { plugins: {
    async inventory() { return { managementAvailable: true } },
    async listBundles() { return [] },
    async installBundle() { return { application: 'failed', error: { code: 'ERR_POLICY', message: 'Release blocked by policy' } } },
  } },
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-failed',
})
assert.equal(failedUpdate.installation.errorMessage, 'ERR_POLICY: Release blocked by policy')

const unsupported = await installLatestPlugin({
  api: { plugins: { async inventory() { return { managementAvailable: false } } } },
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-2',
  profileName: 'desktop',
})
assert.equal(unsupported.reason, 'plugin-manager-unavailable')
assert.match(unsupported.command, /dsh plugin --profile desktop add dsh-plugin-weapp-gateway@0\.8\.9$/)

const current = await installLatestPlugin({
  api: { plugins: { async inventory() { throw new Error('should not be called') } } },
  currentVersion: '0.8.9',
  fetchImpl,
  requestId: 'update-request-3',
})
assert.equal(current.reason, 'already-current')

console.log('plugin update tests passed')
