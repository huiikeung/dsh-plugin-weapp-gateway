// Render harness for the Trusted-devices list.
//
// A 0.12.1 merge carried the fork's DevicePanel over with `onRevoke: revoke`
// while the `revoke` helper had been moved inside `removeDevices` (after its
// return). With zero paired devices the empty branch renders and nothing
// throws; with real devices the list throws ReferenceError during render, so
// clicking the plugin entry opened nothing. This renders the populated branch
// against a realistic /mgw payload so that regression cannot come back.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function resolveReactModules() {
  const candidates = [
    process.env.DSH_REACT_MODULES,
    path.join(os.homedir(), 'Downloads/Terra/node_modules'),
    '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web/node_modules',
    '/vol1/1000/Deepseek-Harness/工作台/插件/dsh-session-compactor/node_modules',
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'react', 'package.json'))
        && fs.existsSync(path.join(dir, 'react-dom', 'server.js'))) return dir
    } catch { /* try the next candidate */ }
  }
  return null
}

const reactModules = resolveReactModules()

test('trusted-device list renders with paired devices', { skip: reactModules
  ? false
  : 'react/react-dom not installed in this environment' }, () => {
  const React = require(path.join(reactModules, 'react'))
  const { renderToStaticMarkup } = require(path.join(reactModules, 'react-dom', 'server'))
  const clientPath = path.resolve(__dirname, '../lib/client.js')
  const source = fs.readFileSync(clientPath, 'utf8')

  const devices = [
    { id: 'dev-online-1', name: 'HUAWEI CMM-AL10', displayName: 'HUAWEI CMM-AL10', online: true, connections: 1, routes: ['public'], createdAt: 1793291234473, lastSeenAt: 1794723203890, permissions: {} },
    { id: 'dev-online-2', name: 'iPhone 15', displayName: 'iPhone 15', online: true, connections: 1, routes: ['lan'], createdAt: 1793291234474, lastSeenAt: 1794723203891, permissions: {} },
    { id: 'dev-offline-1', name: 'Pixel 8', displayName: 'Pixel 8', online: false, connections: 0, routes: [], createdAt: 1793291234475, lastSeenAt: 1794720000000, permissions: {} },
  ]
  const status = {
    version: '0.8.57', gatewayEnabled: true, gatewayMode: 'persistent', requireAuth: true,
    platform: 'darwin', endpoints: ['wss://relay.example/ws/mobile'], connectedClients: 1,
    pairingMode: 'direct', relay: { relay: 'wss://relay.example/relay', nodeId: '0123456789abcdef', gatewayName: 'test.local', updatedAt: 1 }, gatewayId: 'gw-1',
    waitExpiresAt: null, webPort: 58995, pendingPairings: [], clients: 1,
    lan: { enabled: true, listening: true, urls: ['ws://192.168.1.5:3081/ws/mobile'], port: 3081 },
    cloudflare: { supported: true, enabled: false },
  }

  let loaded = null
  const fakeWindow = {
    location: { protocol: 'http:', host: '127.0.0.1:58995' },
    __ModuleLoader__: { load: (mod) => { loaded = mod } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  global.window = fakeWindow
  global.document = {
    baseURI: 'http://127.0.0.1:58995/',
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
  }
  global.navigator = { userAgent: 'node' }
  global.location = fakeWindow.location
  global.fetch = async () => ({ ok: true, json: async () => ({}) })

  new Function('window', 'require', source)(fakeWindow, (id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
  assert.ok(loaded && typeof loaded.factory === 'function', 'client bundle registers a factory')

  // Seed the two data states (devices, status) and let every other hook run for
  // real; the device list is the populated branch that used to throw.
  let stateIndex = -1
  const seeded = new Proxy(React, {
    get(target, prop) {
      if (prop === 'useState') {
        return (initial) => {
          stateIndex += 1
          if (stateIndex === 1) return [devices, () => {}]
          if (stateIndex === 7) return [status, () => {}]
          return target.useState(initial)
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const exported = loaded.factory((id) => {
    if (id === 'react') return seeded
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(typeof exported.DevicePanel, 'function', 'DevicePanel is exported')

  const html = renderToStaticMarkup(seeded.createElement(exported.DevicePanel))
  assert.ok(html.includes('mobile-gateway-panel'), 'management panel markup rendered')
  assert.ok(html.includes('HUAWEI CMM-AL10'), 'paired devices are listed')
  assert.ok(html.includes('展开其他已配对设备'), 'offline devices stay collapsed behind the toggle')
})
