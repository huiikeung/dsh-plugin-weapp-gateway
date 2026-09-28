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

// The profile's node_modules/react is a dangling symlink into
// .dsh-module-fallback (which ships no react), so resolve the pair from the
// first place that actually has it. The browser gets React from the host module
// graph; this is only for server-rendering the tree under Node.
const WORKSPACE = '/vol1/1000/Deepseek-Harness/工作台/插件'
const REACT_CANDIDATES = [
  '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web/node_modules',
  path.join(WORKSPACE, 'dsh-session-compactor/node_modules'),
  path.join(WORKSPACE, 'dsh-interactive-reader/node_modules'),
]
const reactModules = REACT_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'react', 'package.json'))
  && fs.existsSync(path.join(dir, 'react-dom', 'server.js')))
if (!reactModules) throw new Error('no react + react-dom/server found in any candidate directory')
const React = require(path.join(reactModules, 'react'))
const { renderToStaticMarkup } = require(path.join(reactModules, 'react-dom/server'))
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
  ['请先开启移动网关', 'pair button disabled branch'],
  ['加载中…', 'device list loading branch'],
  ['关闭时不会接受移动设备连接，重启后保持关闭', 'mode description (disabled)'],
  ['完成', 'close button rendered'],
  ['网关运行模式', 'gateway mode row'],
  ['设备鉴权', 'auth row'],
  ['WebSocket 地址', 'ws url field'],
  ['可信设备', 'trusted devices group'],
  ['WebSocket 地址（二维码指向这里）', 'direct mode labels the ws field as the QR target'],
  ['配对连接方式', 'pairing route selector rendered'],
  ['维护工具', 'maintenance tools card rendered'],
]) check(htmlA.includes(needle), what)
check(!htmlA.includes('正在检查系统组件…'), 'public access stays hidden while status is loading')

// ---------------------------------------------------------- render B: populated
console.log('\n=== render B: populated state ===')
const seeds = [
  [{ id: 'd1', name: 'My Phone', online: true, connections: 2, lastSeenAt: 1758000000000 }], // devices
  {                                                                                          // status
    gatewayEnabled: true, gatewayMode: 'persistent', gatewayId: '9f1c-uuid', gatewayName: '家里电脑',
    requireAuth: true, version: '0.7.10', webPort: 2298, wsPath: '/ws/mobile', publicUrl: '',
    platform: 'linux', webPid: 4321,
    tools: { restartWeb: true, stopWeb: true },
    cloudflare: { supported: false, enabled: false, state: 'disabled', port: 3082, configured: false },
    pairingMode: 'relay',
    relay: {
      relay: 'wss://relay.ahwe.top', nodeId: 'ecb2de50-7542-490b-af4f-aebfcb29c3c2',
      agentPubKey: 'nU2yVdMWY2fePU9MHkkD6PQJ3V+FkyItgDfWjVy95Go=', gatewayName: 'MEmini-NAS',
      updatedAt: 1758000000000,
    },
    endpoints: ['ws://192.168.3.110:3081/ws/mobile'],
    lan: { enabled: true, listening: true, urls: ['ws://192.168.3.110:3081/ws/mobile'], port: 3081 },
  },
  'ws://192.168.3.110:3081/ws/mobile',                                                       // publicUrl
  'auto',                                                                                    // pairingRoute
  false,                                                                                     // connectionHelpOpen
  false,                                                                                     // toolBusy
  '',                                                                                        // toolNotice
  '203.0.113.10',                                                                            // publicIp
  { installed: true, configured: true, backendPort: 2298, publicUrl: 'wss://mdsh.zo1.top:16662/ws/mobile' }, // publicSetup
  false,                                                                                     // publicSetupBusy
  '',                                                                                        // cloudflareHost
  '',                                                                                        // cloudflareToken
  'quick',                                                                                   // cloudflareMode
  false,                                                                                     // cloudflareBusy
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
  ['v0.7.10', 'version footer'],
  ['完成', 'close button'],
  ['连接模式', 'connection-mode group'],
  ['直连', 'direct option offered'],
  ['中继', 'relay option offered'],
  ['mgw-seg-btn selected', 'a mode is selected'],
  ['wss://relay.ahwe.top', 'registered relay shown'],
  ['ecb2de50-7542-490b-af4f-aebfcb29c3c2', 'relay nodeId shown'],
  ['agentPubKey nU2yVdMWY2…fWjVy95Go=', 'public key shown as a fingerprint'],
  ['已注册的中继', 'relay registration hint'],
  ['小程序只能连接已配置的域名、且基本限于 443 端口', 'relay mode explains why a public direct URL is unreachable'],
  ['中继链路已验证可用', 'relay warning states the backend is proven'],
  ['mgw-callout', 'the hint gets a rounded callout background'],
  ['留空自动识别手机型号', 'relay placeholder no longer suggests iPhone'],
  ['留空时由本机连接器按所连接手机的型号自动命名', 'relay device-name hint explains auto-naming'],
  ['连接地址（二维码指向这里）', 'relay mode leads the address group with the relay'],
  ['wss://relay.ahwe.top', 'relay address shown as the connection address'],
  ['网关地址（仅透传给小程序）', 'relay mode demotes the ws field to informational'],
  ['中继模式下小程序不直连它', 'explains the demotion'],
  ['公网接入（中继模式下只影响上面透传的网关地址）', 'public-access label explains its reduced scope'],
  ['维护工具', 'maintenance tools card rendered'],
  ['重启 DSH Web', 'restart tool offered'],
  ['停止 DSH Web', 'stop tool offered'],
  ['配对连接方式', 'pairing route selector rendered'],
  ['自动选择 · 优先外网', 'auto route option offered'],
  ['手动输入地址', 'custom route option offered'],
]) check(htmlB.includes(needle), what)
check(!htmlB.includes('mgw-note mgw-danger'), 'no bare red note is left in the relay group')
check(!htmlB.includes('nU2yVdMWY2fePU9MHkkD6PQJ3V+FkyItgDfWjVy95Go='), 'full public key is not dumped into the page')
check(!htmlB.includes('Cloudflare Tunnel · 外网接入'), 'cloudflare section hidden when tunnel is unsupported')

// ---------------------------------------------------- render C: populated, direct
// The operator's everyday state: a live gateway in direct mode. Covers the other
// side of every mode-conditional in the 连接地址 group.
console.log('\n=== render C: populated, direct mode ===')
// JSON round-trip drops the `() => new Set()` seed for the revoking-ids state,
// so restore it explicitly.
const directSeeds = JSON.parse(JSON.stringify(seeds))
directSeeds[1].pairingMode = 'direct'
directSeeds[1].relay = null
directSeeds[23] = () => new Set()
const directRegistrations = []
const directExported = loadBundle(seededReact(directSeeds)).factory((id) => {
  if (id === 'react') return seededReact(directSeeds)
  throw new Error(`unexpected require: ${id}`)
})
directRegistrations.length = 0
directExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { directRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlC = renderToStaticMarkup(React.createElement(directRegistrations[0].component, { close: () => {} }))
for (const [needle, what] of [
  ['连接模式', 'connection-mode group present in direct mode'],
  ['mgw-seg-btn selected', 'a mode is selected'],
  ['WebSocket 地址（二维码指向这里）', 'direct mode labels the ws field as the QR target'],
  ['公网接入', 'direct-mode public-access label is plain (no relay caveat)'],
  ['ws://192.168.3.110:3081/ws/mobile', 'gateway address shown'],
]) check(htmlC.includes(needle), what)
// negative checks: the relay details must not leak into direct mode
for (const needle of ['wss://relay.ahwe.top', 'nodeId ecb2de50', 'agentPubKey nU2yVdMWY2']) {
  check(!htmlC.includes(needle), `direct mode hides ${needle}`)
}

// ------------------------------------------------ render D: Cloudflare tunnel (PC)
// The Windows/macOS shape: no Nginx helper, but a live managed Cloudflare
// Tunnel. Covers the Cloudflare card, the tunnel pairing route, and the
// platform gate that hides the Linux public-access block.
console.log('\n=== render D: Cloudflare tunnel (PC) ===')
const cfSeeds = JSON.parse(JSON.stringify(seeds))
cfSeeds[23] = () => new Set()
cfSeeds[1].pairingMode = 'direct'
cfSeeds[1].relay = null
cfSeeds[1].platform = 'win32'
cfSeeds[1].tools = { restartWeb: false, stopWeb: false }
cfSeeds[1].cloudflare = {
  supported: true, enabled: true, mode: 'quick', state: 'online', port: 3082,
  configured: false, hostname: '', publicUrl: 'wss://quiet-storm-42.trycloudflare.com', error: '',
}
const cfExported = loadBundle(seededReact(cfSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfRegistrations = []
cfExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlD = renderToStaticMarkup(React.createElement(cfRegistrations[0].component, { close: () => {} }))
for (const [needle, what] of [
  ['Cloudflare Tunnel · 外网接入', 'cloudflare group rendered on PC'],
  ['Quick Tunnel · 无需域名', 'quick mode option offered'],
  ['命名 Tunnel · 固定域名', 'named mode option offered'],
  ['更新 Tunnel 配置', 'tunnel action reflects enabled state'],
  ['关闭 Cloudflare Tunnel', 'tunnel can be turned off'],
  ['已连接 Cloudflare · wss://quiet-storm-42.trycloudflare.com', 'tunnel state and public url shown'],
  ['Cloudflare 外网', 'cloudflare pairing route offered while enabled'],
  ['当前不是通过 dsh web 启动的 Web profile', 'tools availability explained'],
]) check(htmlD.includes(needle), what)
check(!htmlD.includes('Nginx'), 'linux public-access block hidden on PC')
check(!htmlD.includes('Linux 服务器不自动下载'), 'PC shows the managed-download note, not the Linux one')

// ------------------------------------------------ render E: Cloudflare tunnel (Linux)
// The fork's Linux shape: the same tunnel, but the card leads with the manual
// install instructions and the Linux public-access block comes back.
console.log('\n=== render E: Cloudflare tunnel (Linux) ===')
const cfLinuxSeeds = JSON.parse(JSON.stringify(seeds))
cfLinuxSeeds[23] = () => new Set()
cfLinuxSeeds[1].pairingMode = 'direct'
cfLinuxSeeds[1].relay = null
cfLinuxSeeds[1].platform = 'linux'
cfLinuxSeeds[1].cloudflare = {
  supported: true, enabled: false, mode: 'quick', state: 'disabled', port: 3082,
  configured: false, hostname: '', publicUrl: null, error: '',
}
const cfLinuxExported = loadBundle(seededReact(cfLinuxSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfLinuxSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfLinuxRegistrations = []
cfLinuxExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfLinuxRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlE = renderToStaticMarkup(React.createElement(cfLinuxRegistrations[0].component, { close: () => {} }))
for (const [needle, what] of [
  ['Cloudflare Tunnel · 外网接入', 'cloudflare group rendered on Linux'],
  ['Linux 服务器不自动下载', 'linux card explains the manual install'],
  ['pkg.cloudflare.com', 'linux card names the official package source'],
  ['一键开启 Quick Tunnel', 'quick tunnel can be started from Linux'],
  ['未开启', 'tunnel idle state shown'],
  ['Cloudflare 外网（未开启）', 'cloudflare pairing route stays listed while the tunnel is off'],
  ['mgw-select-wrap', 'selects get the themed chevron wrapper'],
]) check(htmlE.includes(needle), what)
check(htmlE.includes('Nginx'), 'linux public-access block stays visible on Linux')

// ------------------------------------------------------- source-level guarantees
console.log('\n=== source guarantees ===')
check(!src.includes('sidebar.footer.action'), 'no sidebar.footer.action contribution')
check(!src.includes('shell.overlay'), 'no shell.overlay contribution')
check(!src.includes('position:fixed'), 'no fixed-position (floating) styling')
check(!src.includes('setOpen'), 'no open/close store left behind')
check(src.includes("id: 'mobile-gateway'"), 'registers the mobile-gateway settings section')
check(src.includes('function apiPath') && src.includes('document.baseURI')
  && src.includes('fetch(apiPath(path)'), 'management RPC resolves against the document base (gateway prefix safe)')
check(src.includes("'/mgw/cloudflare'") && src.includes('/mgw/tools/') && src.includes('pairingUrlFor'),
  'cloudflare tunnel, web tools and pairing routes wired')

console.log(`\nhtml A: ${htmlA.length} bytes · html B: ${htmlB.length} bytes`)
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1) }
console.log('ALL CHECKS PASSED')
