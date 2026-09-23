// Render harness for the mobile-gateway settings section.
//
// Two renders against the real React:
//   A) initial state  — asserts the loading branches the shell shows first
//   B) populated state— a seeded React.useState drives the full UI tree, so
//                        every conditional branch is exercised without a DOM
//
// Plus registration assertions (exactly one settings.section entry) and a
// source-level guard that the sidebar/overlay contributions are gone.
const path = require('path')
const fs = require('fs')

const profileModules = '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web/node_modules'
const React = require(path.join(profileModules, 'react'))
const { renderToStaticMarkup } = require(path.join(profileModules, 'react-dom/server'))
const clientPath = path.resolve(__dirname, '../lib/client.js')
const src = fs.readFileSync(clientPath, 'utf8')

// Evaluate the bundle fresh with a chosen React implementation.
function loadBundle(reactImpl) {
  let mod = null
  const fakeWindow = {
    location: { protocol: 'http:', host: '127.0.0.1:2298' },
    __ModuleLoader__: { load: (m) => { mod = m } },
  }
  const req = (id) => {
    if (id === 'react') return reactImpl
    throw new Error(`unexpected require: ${id}`)
  }
  new Function('window', 'require', src)(fakeWindow, req)
  if (!mod) throw new Error('module did not register with __ModuleLoader__')
  return mod
}

// A React whose useState returns seeded values in call order.
function seededReact(seeds) {
  let i = 0
  return new Proxy(React, {
    get(target, prop) {
      if (prop === 'useState') {
        return (initial) => {
          const seed = seeds[i++]
          if (seed === undefined) throw new Error(`no seed for useState #${i}`)
          const value = typeof seed === 'function' ? seed() : seed
          return [value, () => {}]
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

let failed = 0
function check(ok, what) {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}`)
}

// ---------------------------------------------------------------- registration
const registrations = []
const slots = {
  inject: (name, thunk) => { thunk() },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const exported = loadBundle(React).factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

console.log('=== registration ===')
check(JSON.stringify(exported.inject) === '["slots"]', `inject = ["slots"] (got ${JSON.stringify(exported.inject)})`)
exported.apply({ slots })
check(registrations.length === 1, `exactly one slot registration (got ${registrations.length})`)
const reg = registrations[0]
check(reg.options.name === 'settings.section', `slot name = settings.section (got ${reg.options.name})`)
check(reg.options.id === 'mobile-gateway', `section id = mobile-gateway (got ${reg.options.id})`)
check(reg.options.order === 35, `section order = 35 (got ${reg.options.order})`)
check(typeof reg.options.label === 'function' && reg.options.label() === '移动设备', 'label = 移动设备')
check(typeof reg.component === 'function', 'component is a function')

// ------------------------------------------------------------- render A: initial
console.log('\n=== render A: initial (loading) state ===')
const htmlA = renderToStaticMarkup(React.createElement(reg.component, { close: () => {} }))
for (const [needle, what] of [
  ['正在检查系统组件…', 'public-setup loading branch'],
  ['请先开启移动网关', 'pair button disabled branch'],
  ['加载中…', 'device list loading branch'],
  ['关闭时不会接受移动设备连接，重启后保持关闭', 'mode description (disabled)'],
  ['完成', 'close button rendered'],
  ['网关运行模式', 'gateway mode row'],
  ['设备鉴权', 'auth row'],
  ['WebSocket 地址', 'ws url field'],
  ['可信设备', 'trusted devices group'],
]) check(htmlA.includes(needle), what)

// ---------------------------------------------------------- render B: populated
console.log('\n=== render B: populated state ===')
const seeds = [
  [{ id: 'd1', name: 'My Phone', online: true, connections: 2, lastSeenAt: 1758000000000 }], // devices
  {                                                                                          // status
    gatewayEnabled: true, gatewayMode: 'persistent', gatewayId: '9f1c-uuid', gatewayName: '家里电脑',
    requireAuth: true, version: '0.7.6', webPort: 2298, wsPath: '/ws/mobile', publicUrl: '',
    lan: { enabled: true, listening: true, urls: ['ws://192.168.3.110:3081/ws/mobile'], port: 3081 },
  },
  'ws://192.168.3.110:3081/ws/mobile',                                                       // publicUrl
  '203.0.113.10',                                                                            // publicIp
  { installed: true, configured: true, backendPort: 2298, publicUrl: 'wss://mdsh.zo1.top:16662/ws/mobile' }, // publicSetup
  false,                                                                                     // publicSetupBusy
  'Pixel',                                                                                   // deviceName
  { svg: '<svg/>', qrPayload: 'PAYLOAD-TOKEN', pairing: { expiresAt: 1758003600000 } },      // qr
  null,                                                                                      // error
  false,                                                                                     // busy
  false,                                                                                     // refreshing
  '已刷新 · 10:00:00',                                                                       // refreshNotice
  true,                                                                                      // pairingTokenCopied
  null,                                                                                      // deviceNotice
  false,                                                                                     // deviceNoticeError
  () => new Set(),                                                                           // revokingIds
]
const exportedB = loadBundle(seededReact(seeds)).factory((id) => {
  if (id === 'react') return seededReact(seeds)
  throw new Error(`unexpected require: ${id}`)
})
registrations.length = 0
exportedB.apply({ slots })
const htmlB = renderToStaticMarkup(React.createElement(registrations[0].component, { close: () => {} }))

for (const [needle, what] of [
  ['家里电脑 · 9f1c-uuid', 'gateway identity'],
  ['mgw-seg-btn selected', 'segmented control has a selection'],
  ['常驻开启', 'persistent option rendered'],
  ['已开启，仅允许可信设备连接', 'auth on description'],
  ['ws://192.168.3.110:3081/ws/mobile', 'ws url value'],
  ['局域网入口已开启：ws://192.168.3.110:3081/ws/mobile', 'lan listening status'],
  ['已配置，Nginx 转发至 DSH 端口 2298', 'public setup configured'],
  ['wss://mdsh.zo1.top:16662/ws/mobile', 'public url'],
  ['value="Pixel"', 'device name value'],
  ['生成配对二维码', 'pair button enabled label'],
  ['PAYLOAD-TOKEN', 'pairing payload textarea'],
  ['✓ 已复制', 'copied state'],
  ['My Phone', 'device row name'],
  ['在线 · 2 个连接', 'device online badge'],
  ['>吊销<', 'revoke button present'],
  ['已刷新 · 10:00:00', 'refresh notice'],
  ['v0.7.6', 'version footer'],
  ['完成', 'close button'],
]) check(htmlB.includes(needle), what)

// ------------------------------------------------------- source-level guarantees
console.log('\n=== source guarantees ===')
check(!src.includes('sidebar.footer.action'), 'no sidebar.footer.action contribution')
check(!src.includes('shell.overlay'), 'no shell.overlay contribution')
check(!src.includes('position:fixed'), 'no fixed-position (floating) styling')
check(!src.includes('setOpen'), 'no open/close store left behind')
check(src.includes("id: 'mobile-gateway'"), 'registers the mobile-gateway settings section')

console.log(`\nhtml A: ${htmlA.length} bytes · html B: ${htmlB.length} bytes`)
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1) }
console.log('ALL CHECKS PASSED')
