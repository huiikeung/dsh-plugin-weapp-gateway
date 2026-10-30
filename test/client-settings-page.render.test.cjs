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
          if (i < seeds.length) {
            const seed = seeds[i++]
            if (seed === undefined) throw new Error(`no seed for useState #${i}`)
            const value = typeof seed === 'function' ? seed() : seed
            return [value, () => {}]
          }
          // Past the section's own hook list: child components with internal
          // state (the Select's open flag) run the real hooks — they render
          // their initial state, which is all a static render needs.
          return target.useState(initial)
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
check(typeof reg.options.label === 'function' && reg.options.label() === '鲸尾网关助手', 'label = 鲸尾网关助手')
check(typeof reg.component === 'function', 'component is a function')

// ------------------------------------------------------- settings entry (fork)
console.log('\n=== settings entry ===')
// 上游基底：入口是侧边栏按钮 + shell.overlay；fork 改为 settings.section，
// 点击设置项即打开同一个弹窗（无中间卡片层）。
const entryRegistrations = []
const entryExported = loadBundle(React).factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
entryExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { entryRegistrations.push({ options: o, component: c }); return () => {} } } })
check(entryRegistrations.length === 1 && entryRegistrations[0].options.name === 'settings.section',
  'the entry registers a settings.section (not a sidebar footer action)')
check(entryRegistrations[0].options.id === 'mobile-gateway', 'section id stays mobile-gateway')
check(!src.includes('sidebar.footer.action') && !src.includes('shell.overlay'),
  'no sidebar footer button and no shell overlay registration')
check(src.includes('React.useEffect(() => { setOpen(true) }, [])'),
  'the settings section opens the dialog on mount (no intermediate card)')
check(src.includes('apiPath') && src.includes('document.baseURI'),
  'management RPC resolves against the document base (fnOS gateway prefix safe)')
check(src.includes("route: pairingRoute") && src.includes('lanUrl: lanPairingUrl(status)'),
  'pairing request carries the selected route and local-LAN fallback endpoint')

// ------------------------------------------------------------- render A: initial
console.log('\n=== render A: initial (loading) state ===')
const htmlA = renderToStaticMarkup(React.createElement(exported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['鲸尾网关助手', 'branded panel title rendered'],
  ['请先开启移动网关', 'pair button disabled branch'],
  ['加载中…', 'device list loading branch'],
  ['不接受移动设备连接', 'mode description (disabled)'],
  ['aria-label="关闭"', 'close button rendered (upstream glyph)'],
  ['网关运行模式', 'gateway mode row'],
  ['设备鉴权', 'auth row'],
  ['可信设备', 'trusted devices group'],
  ['aria-label="工具"', 'tools gear button rendered (menu opens on click)'],
]) check(htmlA.includes(needle), what)
check(!htmlA.includes('正在检查系统组件…'), 'public access stays hidden while status is loading')
check(!htmlA.includes('DSH App / 小程序连接地址'), 'custom address field is hidden until the custom route is selected')

// ---------------------------------------------------------- render B: populated
console.log('\n=== render B: populated state ===')
const seeds = [
  'general',                                                                                 // activeSection
  [                                                                                          // devices
    { id: 'd1', name: 'My Phone', displayName: 'My Phone (2)', online: true, connections: 2, routes: ['lan', 'public'], lastSeenAt: 1758000000000 },
    { id: 'd2', name: 'My Phone', displayName: 'My Phone (1)', online: false, connections: 0, routes: [], lastSeenAt: 1757900000000 },
  ],
  false,                                                                                     // showAllDevices
  {                                                                                          // status
    gatewayEnabled: true, gatewayMode: 'persistent', gatewayId: '9f1c-uuid', gatewayName: '家里电脑',
    requireAuth: true, version: '0.8.5', webPort: 2298, wsPath: '/ws/mobile', publicUrl: '', gatewayInstanceId: 'gi-abc',
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
  null,                                                                                      // dismissedNotice
  'ws://192.168.3.110:3081/ws/mobile',                                                       // publicUrl
  'auto',                                                                                    // pairingRoute
  false,                                                                                     // connectionHelpOpen
  false,                                                                                     // toolsOpen
  false,                                                                                     // toolBusy
  '',                                                                                        // toolNotice
  '203.0.113.10',                                                                            // publicIp
  { installed: true, configured: true, backendPort: 2298, publicUrl: 'wss://mdsh.zo1.top:16662/ws/mobile' }, // publicSetup
  false,                                                                                     // publicSetupBusy
  '',                                                                                        // cloudflareHost
  '',                                                                                        // cloudflareToken
  'quick',                                                                                   // cloudflareMode
  false,                                                                                     // cloudflareBusy
  { svg: '<svg/>', qrPayload: 'PAYLOAD-TOKEN', pairing: { expiresAt: 1758003600000 } },      // qr
  false,                                                                                     // pairingClosing
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
const htmlB = renderToStaticMarkup(React.createElement(exportedB.DevicePanel, { close: () => {} }))

for (const [needle, what] of [
  ['家里电脑', 'gateway name shown'],
  ['重启后保持开启', 'gateway mode description reflects the persistent mode'],
  ['常驻开启', 'persistent option rendered'],
  ['已开启，仅允许可信设备连接', 'auth on description'],
  ['ws://192.168.3.110:3081/ws/mobile', 'ws url value'],
  ['局域网入口已开启：ws://192.168.3.110:3081/ws/mobile', 'lan listening status'],
  ['已配置，Nginx 转发至 DSH 端口 2298', 'public setup configured'],
  ['wss://mdsh.zo1.top:16662/ws/mobile', 'public url'],
  ['生成配对二维码', 'pair button enabled label'],
  ['PAYLOAD-TOKEN', 'pairing payload textarea'],
  ['✓ 已复制', 'copied state'],
  ['My Phone', 'device row name'],
  ['在线', 'device online badge (upstream simplified it)'],
  ['局域网', 'LAN route badge on the live device row'],
  ['公网', 'public route badge on the live device row'],
  ['手机当前通过局域网直连（同一 Wi-Fi 或 VPN）', 'LAN badge explains the route in its tooltip'],
  ['手机当前通过公网入口连接（公网服务器或鲸尾中继）', 'public badge explains the route in its tooltip'],
  ['My Phone (2)', 'duplicate device names are numbered via displayName'],
  ['>吊销<', 'revoke button present'],
  ['已刷新 · 10:00:00', 'refresh notice'],
  ['v0.8.5', 'version footer'],
  ['aria-label="关闭"', 'close button'],
  ['自动选择', 'automatic client-aware route offered'],
  ['鲸尾公网 · 小程序', 'the standalone mini-program relay route remains available'],
  ['aria-checked="true"', 'auth switch is on'],
  ['设备 ID ecb2de50…', 'registered relay identity shown (abbreviated)'],
  ['鲸尾公网服务 · 已注册', 'relay registration hint'],
  ['自动选择会优先使用已就绪的 Cloudflare 或公网服务器入口', 'auto route prefers a ready public endpoint before the registered relay'],
  ['也可单独选择“鲸尾公网 · 小程序”', 'the separate mini-program relay pairing option remains available'],
  ['公网接入', 'public access label is independent of pairing mode'],
  ['若安装或更新后连接异常，请重启应用', 'restart notice shown for the current gateway instance'],
  ['展开其他已配对设备（1）', 'offline devices collapse behind a toggle'],
  ['aria-label="工具"', 'tools gear button rendered'],
  ['aria-haspopup="menu" aria-expanded="false"', 'tools gear button present (menu opens on click)'],
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
directSeeds[3].pairingMode = 'direct'
directSeeds[3].relay = null
directSeeds[27] = () => new Set()
const directRegistrations = []
const directExported = loadBundle(seededReact(directSeeds)).factory((id) => {
  if (id === 'react') return seededReact(directSeeds)
  throw new Error(`unexpected require: ${id}`)
})
directRegistrations.length = 0
directExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { directRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlC = renderToStaticMarkup(React.createElement(directExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['配对连接方式', 'route selector present in direct mode'],
  ['aria-checked="true"', 'a mode is selected'],
  ['公网接入', 'direct-mode public-access label is plain (no relay caveat)'],
  ['ws://192.168.3.110:3081/ws/mobile', 'gateway address shown'],
  ['配对连接方式', 'route selector rendered in direct mode'],
  ['DSH App 和小程序都可通过公网或局域网连接', 'both clients can use public and LAN routes'],
  ['自动选择', 'auto route option offered'],
]) check(htmlC.includes(needle), what)
check(htmlC.includes('鲸尾公网 · 尚未注册'), 'the standalone relay route stays visible but unavailable until registration')
check(!htmlC.includes('DSH App / 小程序连接地址'), 'custom address field stays hidden in automatic mode')
check(!htmlC.includes('中继模式：二维码指向上面的中继地址'), 'direct mode does not show the relay route note')
// negative checks: the relay details must not leak into direct mode
for (const needle of ['wss://relay.ahwe.top', 'nodeId ecb2de50', 'agentPubKey nU2yVdMWY2']) {
  check(!htmlC.includes(needle), `direct mode hides ${needle}`)
}

// Registered relay service stays visible even while generating a direct App QR.
const directRelaySeeds = JSON.parse(JSON.stringify(directSeeds))
directRelaySeeds[3].relay = seeds[3].relay
directRelaySeeds[3].relayConnector = { running: true, delegatedTo: null, lastError: null }
directRelaySeeds[27] = () => new Set()
const directRelayExported = loadBundle(seededReact(directRelaySeeds)).factory((id) => {
  if (id === 'react') return seededReact(directRelaySeeds)
  throw new Error(`unexpected require: ${id}`)
})
const htmlCRelay = renderToStaticMarkup(React.createElement(directRelayExported.DevicePanel, { close: () => {} }))
check(htmlCRelay.includes('鲸尾公网服务 · 已注册') && htmlCRelay.includes('中继连接保持运行；切换配对方式不会断开已配对设备。'),
  'registered relay remains visible and running while direct pairing is selected')

// ------------------------------------------------ render D: Cloudflare tunnel (PC)
// The Windows/macOS shape: no Nginx helper, but a live managed Cloudflare
// Tunnel. Covers the Cloudflare card, the tunnel pairing route, and the
// platform gate that hides the Linux public-access block.
console.log('\n=== render D: Cloudflare tunnel (PC) ===')
const cfSeeds = JSON.parse(JSON.stringify(seeds))
cfSeeds[27] = () => new Set()
cfSeeds[6] = 'cloudflare'
cfSeeds[3].pairingMode = 'direct'
cfSeeds[3].relay = null
cfSeeds[3].platform = 'win32'
cfSeeds[3].tools = { restartWeb: false, stopWeb: false }
cfSeeds[3].cloudflare = {
  supported: true, enabled: true, mode: 'quick', state: 'online', port: 3082,
  configured: false, hostname: '', publicUrl: 'wss://quiet-storm-42.trycloudflare.com', error: '',
  publicReady: true,
  endpointHealth: { state: 'reachable', message: 'TLS 校验通过，移动网关路由已确认且要求鉴权。', checkedAt: '2026-10-13T01:00:00.000Z' },
}
const cfExported = loadBundle(seededReact(cfSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfRegistrations = []
cfExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlD = renderToStaticMarkup(React.createElement(cfExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['Cloudflare Tunnel', 'cloudflare group rendered on PC'],
  ['Quick Tunnel · 无需域名', 'quick mode option offered'],
  ['关闭 Cloudflare Tunnel', 'enabled tunnel offers the disable action'],
  ['关闭 Cloudflare Tunnel', 'tunnel can be turned off'],
  ['隧道传输已连接（不等于公网入口可达） · wss://quiet-storm-42.trycloudflare.com', 'tunnel state and public url shown'],
  ['Cloudflare 外网', 'cloudflare pairing route label in the trigger while enabled'],
  ['TLS 校验通过', 'endpoint health message shown when reachable'],
]) check(htmlD.includes(needle), what)
check(htmlD.includes('<details') && htmlD.includes('<summary'), 'Cloudflare configuration is collapsed below pairing controls')
check(!htmlD.includes('自动模式会优先为小程序使用已就绪的公网入口'), 'Cloudflare-specific route does not show the automatic-mode hint')
check(!htmlD.includes('Nginx'), 'linux public-access block hidden on PC')
check(!htmlD.includes('Linux 服务器不自动下载'), 'PC shows the managed-download note, not the Linux one')

// ------------------------------------------------ render E: Cloudflare tunnel (Linux)
// The fork's Linux shape: the same tunnel, but the card leads with the manual
// install instructions and the Linux public-access block comes back.
console.log('\n=== render E: Cloudflare tunnel (Linux) ===')
const cfLinuxSeeds = JSON.parse(JSON.stringify(seeds))
cfLinuxSeeds[27] = () => new Set()
cfLinuxSeeds[6] = 'cloudflare'
cfLinuxSeeds[3].pairingMode = 'direct'
cfLinuxSeeds[3].relay = null
cfLinuxSeeds[3].platform = 'linux'
cfLinuxSeeds[3].cloudflare = {
  supported: true, enabled: false, mode: 'quick', state: 'disabled', port: 3082,
  configured: false, hostname: '', publicUrl: null, error: '',
}
const cfLinuxExported = loadBundle(seededReact(cfLinuxSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfLinuxSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfLinuxRegistrations = []
cfLinuxExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfLinuxRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlE = renderToStaticMarkup(React.createElement(cfLinuxExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['Cloudflare Tunnel · 外网接入', 'cloudflare group rendered on Linux'],
  ['Linux 服务器不自动下载', 'cloudflare card explains the manual install on Linux'],
  ['pkg.cloudflare.com', 'names the official package source'],
  ['一键开启 Quick Tunnel', 'quick tunnel can be started from Linux'],
  ['未开启', 'tunnel idle state shown'],
  ['Cloudflare 外网 · 尚未就绪', 'unready Cloudflare route remains selectable'],
  ['先开启 Cloudflare Tunnel', 'pairing stays disabled until the selected tunnel is enabled'],
]) check(htmlE.includes(needle), what)
check(htmlE.includes('Nginx'), 'linux public-access block stays visible on Linux')

// Automatic selection should not duplicate Cloudflare setup controls; it can
// still select a ready public route at pairing time without exposing settings.
const cfAutoSeeds = JSON.parse(JSON.stringify(cfLinuxSeeds))
cfAutoSeeds[6] = 'auto'
cfAutoSeeds[27] = () => new Set()
const cfAutoExported = loadBundle(seededReact(cfAutoSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfAutoSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const htmlAuto = renderToStaticMarkup(React.createElement(cfAutoExported.DevicePanel, { close: () => {} }))
check(htmlAuto.includes('自动模式会优先为小程序使用已就绪的公网入口'), 'automatic route explains its public-endpoint priority')
check(!htmlAuto.includes('mgw-cloudflare-block'), 'Cloudflare configuration is hidden in automatic mode')
check(htmlAuto.includes('Cloudflare 外网 · 尚未就绪'), 'automatic mode keeps the Cloudflare option available for selection')

// ------------------------------------------- render F: named tunnel mode (Linux)
// The named-tunnel form state: how to obtain the domain and Token, with the
// two jumps to the Cloudflare dashboard and the official guide.
console.log('\n=== render F: named tunnel mode ===')
const cfNamedSeeds = JSON.parse(JSON.stringify(seeds))
cfNamedSeeds[27] = () => new Set()
cfNamedSeeds[6] = 'cloudflare'
cfNamedSeeds[3].pairingMode = 'direct'
cfNamedSeeds[3].relay = null
cfNamedSeeds[3].platform = 'linux'
cfNamedSeeds[16] = 'named'
cfNamedSeeds[3].cloudflare = {
  supported: true, enabled: false, mode: 'quick', state: 'disabled', port: 3082,
  configured: false, hostname: '', publicUrl: null, error: '',
}
const cfNamedExported = loadBundle(seededReact(cfNamedSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfNamedSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfNamedRegistrations = []
cfNamedExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfNamedRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlF = renderToStaticMarkup(React.createElement(cfNamedExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['命名 Tunnel · 固定域名', 'named mode is the selected value'],
  ['https://dash.cloudflare.com/?to=/:account/tunnels', 'dashboard jump link'],
  ['create-remote-tunnel', 'official guide jump link'],
  ['eyJ… 开头的一段', 'explains where the token comes from'],
  ['http://127.0.0.1:3082', 'names the origin Service URL'],
  ['开启命名 Tunnel', 'named enable action offered'],
]) check(htmlF.includes(needle), what)
check(htmlF.includes('dash.cloudflare.com') && htmlF.includes('target="_blank"'), 'links carry the themed link styling and open in a new tab')

// ------------------------------------------- render G: connection route badges
// 可信设备徽标：每台在线设备按当前连接入口标注 局域网 / 公网 / Cloudflare 外网，
// 直接取轮询返回的 device.routes；离线设备没有连接，不显示线路徽标。
const routeSeeds = JSON.parse(JSON.stringify(seeds))
routeSeeds[27] = () => new Set()
routeSeeds[2] = true // showAllDevices so the offline row renders too
routeSeeds[1] = [
  { id: 'd1', name: 'LAN Phone', displayName: 'LAN Phone', online: true, connections: 1, routes: ['lan'], lastSeenAt: 1758000000000 },
  { id: 'd2', name: 'CF Phone', displayName: 'CF Phone', online: true, connections: 2, routes: ['cloudflare'], lastSeenAt: 1758000000000 },
  { id: 'd3', name: 'Old Phone', displayName: 'Old Phone', online: false, connections: 0, routes: [], lastSeenAt: 1757900000000 },
]
const routeExported = loadBundle(seededReact(routeSeeds)).factory((id) => {
  if (id === 'react') return seededReact(routeSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const routeRegistrations = []
routeExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { routeRegistrations.push({ options: o, component: c }); return () => {} } } })
const htmlG = renderToStaticMarkup(React.createElement(routeExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['局域网', 'LAN route badge rendered'],
  ['Cloudflare 外网', 'Cloudflare route badge rendered'],
  ['手机当前通过局域网直连（同一 Wi-Fi 或 VPN）', 'LAN badge tooltip explains the route'],
  ['手机当前通过 Cloudflare Tunnel 外网连接', 'Cloudflare badge tooltip explains the route'],
]) check(htmlG.includes(needle), what)

// ------------------------------------------------------- source-level guarantees
console.log('\n=== source guarantees ===')
check(!src.includes('sidebar.footer.action'), 'no sidebar.footer.action contribution')
check(!src.includes('shell.overlay'), 'no shell.overlay contribution')
check((src.match(/position: 'fixed'/g) || []).length === 2,
  'fixed positioning is limited to the two dialogs (backdrop + pairing)')
check(src.includes('mgw-pairing-dialog') && src.includes('prefers-reduced-motion'),
  'the pairing dialog is animated and reduced-motion aware')
check(!src.includes('sidebar.footer.action'), 'no sidebar footer button re-added')
check(src.includes("id: 'mobile-gateway'"), 'registers the mobile-gateway settings section')
check(src.includes('function apiPath') && src.includes('document.baseURI')
  && src.includes('fetch(apiPath(path)'), 'management RPC resolves against the document base (gateway prefix safe)')
check(src.includes("'/mgw/cloudflare'") && src.includes('/mgw/tools/') && src.includes('pairingUrlFor'),
  'cloudflare tunnel, web tools and pairing routes wired')
check(src.includes("'Quick Tunnel · 无需域名'") && src.includes("'命名 Tunnel · 固定域名'") && src.includes("'手动输入地址'"),
  'custom Select offers cloudflare modes and the custom route')
check(src.includes('function GatewaySelect') && src.includes("addEventListener('pointerdown', outside)")
  && src.includes("if (event.key === 'Escape')"),
  'GatewaySelect closes on Escape and on outside pointerdown')
check(src.includes('function GatewaySelect'), 'the panel uses the themed GatewaySelect')
check(src.includes('route: pairingRoute') && src.includes('lanUrl: lanPairingUrl(status)') && src.includes("value: 'relay'") && !src.includes('deviceName'),
  'pairing supports both the automatic dual-client route and a standalone relay route without exposing the device name')
// 扫码成功后二维码弹窗要自动关闭：轮询发现自己的配对码离开待用列表即 setQr(null)。
check(src.includes('pairingIdRef.current = data.pairing?.id || null')
  && src.includes('!statusData.pendingPairings.includes(pairingIdRef.current)'),
  'the QR dialog auto-closes once the pairing code is consumed')
// 「复制配对 Token」在非安全上下文（fnOS 网关是纯 http）里没有 navigator.clipboard，
// 必须回退到 execCommand('copy')；失败提示还要画在二维码弹窗内郣——
// 面板顶部的错误条被模态盖住，用户看不到，就像按钮点不动。
check(src.includes("document.execCommand('copy')")
  && src.includes('const writeClipboard = (text)')
  && src.includes('const [copyNotice, setCopyNotice] = React.useState(null)')
  && src.includes("copyNotice ? React.createElement('div', { role: 'alert'"),
  'copy pairing token falls back to execCommand and reports inside the QR dialog')
// Restore the saved standalone relay route until the operator explicitly
// chooses another option; subsequent polling must not override that choice.
check(src.includes("const savedRoute = statusData.pairingMode === 'relay' ? 'relay' : 'auto'")
  && src.includes('if (!pairingRouteSelectedRef.current)')
  && src.includes("const preferredUrl = pairingUrlFor(pairingRouteRef.current, statusData)"),
  'refresh restores the saved pairing route without overriding a new selection')
// 上游基底的 module id 是 dsh-plugin-mobile-gateway；加载器按包名
// dsh-plugin-weapp-gateway 查找，id 不一致会 "loaded without registering"。
check(/id: 'dsh-plugin-weapp-gateway'/.test(src) && !src.includes("id: 'dsh-plugin-mobile-gateway'"),
  'module id matches the package name so the loader registers it')
check(src.includes('/mgw/cloudflare/check') && src.includes('/mgw/cloudflare/restart'), 'cloudflare check/restart routes wired')
check(src.includes('tunnel.publicReady === true'), 'connection advice trusts publicReady, not raw tunnel state')
// 可信设备徽标：局域网 / 公网 / Cloudflare 外网，取自轮询的 device.routes。
check(src.includes("lan: { label: '局域网'") && src.includes("public: { label: '公网'")
  && src.includes("cloudflare: { label: 'Cloudflare 外网'") && src.includes('routeBadges(device).map'),
  'trusted-device rows badge the live connection route')
check(src.includes('if (!device || !device.online || !Array.isArray(device.routes)) return []'),
  'offline devices and rows without route data show no route badge')

console.log(`\nhtml A: ${htmlA.length} bytes · html B: ${htmlB.length} bytes · html C: ${htmlC.length} bytes · html D: ${htmlD.length} bytes · html E: ${htmlE.length} bytes · html G: ${htmlG.length} bytes`)
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1) }
console.log('ALL CHECKS PASSED')
