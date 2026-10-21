import assert from 'node:assert/strict'
import {
  checkPluginUpdate,
  compareVersions,
  installLatestPlugin,
  PLUGIN_PACKAGE_NAME,
} from '../lib/plugin-updates.mjs'

assert.equal(compareVersions('0.8.9', '0.8.8'), 1)
assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0)
assert.throws(() => compareVersions('01.0.0', '1.0.0'), /valid semantic versions/)

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
const api = { plugins: {
  async inventory() { return { managementAvailable: true } },
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
assert.deepEqual(installCalls, [[`${PLUGIN_PACKAGE_NAME}@0.8.9`, { requestId: 'update-request-1' }]])

const unsupported = await installLatestPlugin({
  api: { plugins: { async inventory() { return { managementAvailable: false } } } },
  currentVersion: '0.8.8',
  fetchImpl,
  requestId: 'update-request-2',
})
assert.equal(unsupported.reason, 'plugin-manager-unavailable')
assert.match(unsupported.command, /dsh-plugin-weapp-gateway@0\.8\.9$/)

const current = await installLatestPlugin({
  api: { plugins: { async inventory() { throw new Error('should not be called') } } },
  currentVersion: '0.8.9',
  fetchImpl,
  requestId: 'update-request-3',
})
assert.equal(current.reason, 'already-current')

console.log('plugin update tests passed')
