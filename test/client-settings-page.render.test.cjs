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
  // Repo-local install (npm install --no-save react react-dom) works anywhere.
  path.join(__dirname, '..', 'node_modules'),
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
// Upstream 0.10.1 mounts the panel stylesheet via ctx.effect; ignore it headless.
const noEffect = () => () => {}
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
// Upstream 0.10.1: the panel stylesheet mounts through ctx.effect; keep the
// harness headless by ignoring the factory (document is undefined here).
const ctxEffects = []
exported.apply({ slots, effect: (fn, label) => { ctxEffects.push(label); return () => {} } })
check(ctxEffects.includes('mobile-gateway: panel styles'), 'panel styles mount through ctx.effect')
check(registrations.length === 5, `five slot registrations: settings + panellist + main + sidebar + overlay (got ${registrations.length})`)
check(registrations.some((r) => r.options.name === 'sidebar.panellist' && r.options.id === 'mobile-gateway-panel'), 'plugins-area icon registered by default (pluginsEntry defaults on)')
check(registrations.some((r) => r.options.name === 'main' && r.options.key === 'mobile-gateway-panel'), 'central panel content registered under the same key')
const sectionReg = registrations.find((r) => r.options.name === 'settings.section')
const sidebarReg = registrations.find((r) => r.options.name === 'sidebar.footer.action')
const overlayReg = registrations.find((r) => r.options.name === 'shell.overlay')
check(!!sectionReg, 'settings.section registered')
check(sectionReg.options.id === 'mobile-gateway', `section id = mobile-gateway (got ${sectionReg.options.id})`)
check(sectionReg.options.order === 35, `section order = 35 (got ${sectionReg.options.order})`)
check(typeof sectionReg.options.label === 'function' && sectionReg.options.label() === '鲸尾网关助手', 'label = 鲸尾网关助手')
check(typeof sectionReg.component === 'function', 'section component is a function')
check(!!sidebarReg && sidebarReg.options.id === 'mobile-gateway-devices' && sidebarReg.options.order === 80,
  'sidebar footer action registered (order 80)')
check(typeof sidebarReg.component === 'function', 'sidebar component is a function')
check(!!overlayReg && overlayReg.options.id === 'mobile-gateway-devices-panel' && overlayReg.options.order === 100,
  'shell overlay registered (order 100)')
check(typeof overlayReg.component === 'function', 'overlay component is a function')

// ------------------------------------------------------- settings entry (fork)
console.log('\n=== settings entry ===')
// 上游基底：入口是侧边栏按钮 + shell.overlay；fork 改为 settings.section，
// 点击设置项即打开同一个弹窗（无中间卡片层）。
const entryRegistrations = []
const entryExported = loadBundle(React).factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
entryExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { entryRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
check(entryRegistrations.some((r) => r.options.name === 'settings.section' && r.options.id === 'mobile-gateway'),
  'the entry keeps the settings.section registration')
check(entryRegistrations.some((r) => r.options.name === 'sidebar.footer.action')
  && entryRegistrations.some((r) => r.options.name === 'shell.overlay'),
  'upstream sidebar footer action + shell overlay are registered alongside it')
check(src.includes('React.useEffect(() => { setOpen(true) }, [])'),
  'the settings section opens the dialog on mount (no intermediate card)')
check(src.includes('apiPath') && src.includes('document.baseURI'),
  'management RPC resolves against the document base (fnOS gateway prefix safe)')
check(src.includes('route: appRoute') && src.includes("route: 'mini'")
  && src.includes('lanUrl: lanPairingUrl(status)'),
  'pairing requests carry the selected route (app select / mini fixed) and the local-LAN fallback endpoint')

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
  ['网络检测', 'network diagnostics nav section'],
  ['左侧栏显示入口', 'entry master toggle card rendered'],
  ['aria-label="工具"', 'tools gear button rendered (menu opens on click)'],
]) check(htmlA.includes(needle), what)
// 子设置默认折叠：总开关卡片在，但两个子开关行不渲染。
check(!htmlA.includes('侧边栏底部入口') && !htmlA.includes('侧边栏入口位置'),
  'the sub toggles stay folded by default until the master row is clicked')
check(!htmlA.includes('安装应用'), 'install guide section is gone (not needed for now)')
check(!htmlA.includes('正在检查系统组件…'), 'public access stays hidden while status is loading')
check(htmlA.includes('配对入口地址（手机需能访问）'), 'the unified pairing address field is rendered')

// ---------------------------------------------------------- render B: populated
console.log('\n=== render B: populated state ===')
const seeds = [
  'general',                                                                  // #0 activeSection
  false,                                                                      // #1 pairingSubOpen (fold state, default folded)
  true,                                                                       // #2 entrySubOpen (fold state)
  [
    { id: 'd1', name: 'My Phone', displayName: 'My Phone (2)', online: true, connections: 2, routes: ['lan', 'public'], lastSeenAt: 1758000000000 },
    { id: 'd2', name: 'My Phone', displayName: 'My Phone (1)', online: false, connections: 0, routes: [], lastSeenAt: 1757900000000 },
  ],                                                        // #3 devices
  null,                                                                       // #4 deviceLoadError
  null,                                                                       // #5 statusLoadError
  false,                                                                      // #6 showAllDevices
  null,                                                                       // #7 permissionSaving
  () => new Set(),                                                            // #8 selectedDeviceIds
  {
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
  },                                 // #9 status
  null,                                                                       // #10 dismissedNotice
  'ws://192.168.3.110:3081/ws/mobile',                                        // #11 appUrl
  'auto',                                                                     // #12 appRoute
  false,                                                                      // #13 connectionHelpOpen
  false,                                                                      // #14 toolsOpen
  false,                                                                      // #15 toolBusy
  false,                                                                      // #16 backgroundBusy
  '',                                                                         // #17 toolNotice
  '203.0.113.10',                                                             // #18 publicIp
  { installed: true, configured: true, backendPort: 2298, publicUrl: 'wss://mdsh.zo1.top:16662/ws/mobile' }, // #19 publicSetup
  false,                                                                      // #20 publicSetupBusy
  '',                                                                         // #21 cloudflareHost
  '',                                                                         // #22 cloudflareToken
  'quick',                                                                    // #23 cloudflareMode
  false,                                                                      // #24 cloudflareBusy
  { svg: '<svg/>', qrPayload: 'PAYLOAD-TOKEN', pairing: { expiresAt: 1758003600000 } }, // #25 qr
  false,                                                                      // #26 pairingClosing
  null,                                                                       // #27 error
  false,                                                                      // #28 busy
  null,                                                                       // #29 updateInfo
  false,                                                                      // #30 updateChecking
  false,                                                                      // #31 updateBusy
  '',                                                                         // #32 updateNotice
  '',                                                                         // #33 updateError
  false,                                                                      // #34 refreshing
  '已刷新 · 10:00:00',                                                        // #35 refreshNotice
  true,                                                                       // #36 pairingTokenCopied
  null,                                                                       // #37 copyNotice
  null,                                                                       // #38 deviceNotice
  false,                                                                      // #39 deviceNoticeError
  () => new Set(),                                                            // #40 revokingIds
  false,                                                                      // #41 sidebarBusy
  false,                                                                      // #42 offlineClearing
  true,                                                                       // #43 appLayerOpen
]
const exportedB = loadBundle(seededReact(seeds)).factory((id) => {
  if (id === 'react') return seededReact(seeds)
  throw new Error(`unexpected require: ${id}`)
})
registrations.length = 0
exportedB.apply({ slots, effect: noEffect })
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
  ['生成 App 二维码', 'app pair button enabled label'],
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
  ['小程序连接（备用）', 'mini-program module offered as the backup route'],
  ['小程序默认通过鲸尾公网中继连接', 'mini-program module states its relay connection'],
  ['生成小程序二维码', 'the mini-program module offers its own QR button'],
  ['aria-checked="true"', 'auth switch is on'],
  ['设备 ID ecb2de50…', 'registered relay identity shown (abbreviated)'],
  ['鲸尾公网服务 · 已注册', 'relay registration hint'],
  ['手机会按实际连通情况在公网与局域网之间自动切换。', 'the automatic app plan explains its connectivity fallback'],
  ['手机与网关在同一局域网时自动兜底直连', 'the mini-program description states the LAN fallback'],
  ['公网接入', 'public access label is independent of pairing mode'],
  ['若安装或更新后连接异常，请重启应用', 'restart notice shown for the current gateway instance'],
  ['展开其他已配对设备（1）', 'offline devices collapse behind a toggle'],
  ['一键清除离线设备（1）', 'one-click clear-offline button carries the offline count'],
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
directSeeds[9].pairingMode = 'direct'
directSeeds[9].relay = null
directSeeds[8] = () => new Set()
directSeeds[40] = () => new Set()
const directRegistrations = []
const directExported = loadBundle(seededReact(directSeeds)).factory((id) => {
  if (id === 'react') return seededReact(directSeeds)
  throw new Error(`unexpected require: ${id}`)
})
directRegistrations.length = 0
directExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { directRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
const htmlC = renderToStaticMarkup(React.createElement(directExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['小程序连接（备用）', 'mini-program module present'],
  ['DSH App（推荐）', 'app module present (expanded)'],
  ['收起 DSH App 方式', 'app layer renders expanded with a collapse hint'],
  ['aria-checked="true"', 'a mode is selected'],
  ['公网接入', 'direct-mode public-access label is plain (no relay caveat)'],
  ['ws://192.168.3.110:3081/ws/mobile', 'gateway address shown'],
  ['请先注册鲸尾公网中继', 'mini-program pairing stays gated until the relay is registered'],


]) check(htmlC.includes(needle), what)
check(src.includes("'鲸尾公网 · 小程序'"), 'the standalone relay option stays available in the plan list')
check(htmlC.includes('配对入口地址（手机需能访问）'), 'the unified address field is rendered in automatic mode')
check(!htmlC.includes('中继模式：二维码指向上面的中继地址'), 'direct mode does not show the relay route note')
// negative checks: the relay details must not leak into direct mode
for (const needle of ['wss://relay.ahwe.top', 'nodeId ecb2de50', 'agentPubKey nU2yVdMWY2']) {
  check(!htmlC.includes(needle), `direct mode hides ${needle}`)
}

// Registered relay service stays visible even while generating a direct App QR.
const directRelaySeeds = JSON.parse(JSON.stringify(directSeeds))
directRelaySeeds[9].relay = seeds[9].relay
directRelaySeeds[9].relayConnector = { running: true, delegatedTo: null, lastError: null }
directRelaySeeds[8] = () => new Set()
directRelaySeeds[40] = () => new Set()
const directRelayExported = loadBundle(seededReact(directRelaySeeds)).factory((id) => {
  if (id === 'react') return seededReact(directRelaySeeds)
  throw new Error(`unexpected require: ${id}`)
})
const htmlCRelay = renderToStaticMarkup(React.createElement(directRelayExported.DevicePanel, { close: () => {} }))
check(htmlCRelay.includes('鲸尾公网服务 · 已注册') && htmlCRelay.includes('中继连接保持运行'),
  'registered relay remains visible and running while direct pairing is selected')

// ------------------------------------------------ render D: Cloudflare tunnel (PC)
// The Windows/macOS shape: no Nginx helper, but a live managed Cloudflare
// Tunnel. Covers the Cloudflare card, the tunnel pairing route, and the
// platform gate that hides the Linux public-access block.
console.log('\n=== render D: Cloudflare tunnel (PC) ===')
const cfSeeds = JSON.parse(JSON.stringify(seeds))
cfSeeds[8] = () => new Set()
cfSeeds[40] = () => new Set()
cfSeeds[12] = 'cloudflare'
cfSeeds[9].pairingMode = 'direct'
cfSeeds[9].relay = null
cfSeeds[9].platform = 'win32'
cfSeeds[9].tools = { restartWeb: false, stopWeb: false }
cfSeeds[9].cloudflare = {
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
cfExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
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
check(htmlD.includes('mgw-cloudflare-block') && htmlD.includes('接入方式'), 'the cloudflare block renders inline below the pairing controls')
check(!htmlD.includes('自动模式会优先为小程序使用已就绪的公网入口'), 'Cloudflare-specific route does not show the automatic-mode hint')
check(!htmlD.includes('Nginx'), 'linux public-access block hidden on PC')
check(!htmlD.includes('Linux 服务器不自动下载'), 'PC shows the managed-download note, not the Linux one')

// ------------------------------------------------ render E: Cloudflare tunnel (Linux)
// The fork's Linux shape: the same tunnel, but the card leads with the manual
// install instructions and the Linux public-access block comes back.
console.log('\n=== render E: Cloudflare tunnel (Linux) ===')
const cfLinuxSeeds = JSON.parse(JSON.stringify(seeds))
cfLinuxSeeds[8] = () => new Set()
cfLinuxSeeds[40] = () => new Set()
cfLinuxSeeds[12] = 'cloudflare'
cfLinuxSeeds[9].pairingMode = 'direct'
cfLinuxSeeds[9].relay = null
cfLinuxSeeds[9].platform = 'linux'
cfLinuxSeeds[9].cloudflare = {
  supported: true, enabled: false, mode: 'quick', state: 'disabled', port: 3082,
  configured: false, hostname: '', publicUrl: null, error: '',
}
const cfLinuxExported = loadBundle(seededReact(cfLinuxSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfLinuxSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfLinuxRegistrations = []
cfLinuxExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfLinuxRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
const htmlE = renderToStaticMarkup(React.createElement(cfLinuxExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['Cloudflare Tunnel · 外网接入', 'cloudflare group rendered on Linux'],
  ['Linux 服务器不自动下载', 'cloudflare card explains the manual install on Linux'],
  ['pkg.cloudflare.com', 'names the official package source'],
  ['一键开启 Quick Tunnel', 'quick tunnel can be started from Linux'],
  ['未开启', 'tunnel idle state shown'],
  ['尚未开启 Cloudflare Tunnel，可在下方设置中一键开启。', 'unready cloudflare route points at the setup below'],
  ['先开启 Cloudflare Tunnel', 'pairing stays disabled until the selected tunnel is enabled'],
]) check(htmlE.includes(needle), what)
check(htmlE.includes('Nginx'), 'linux public-access block stays visible on Linux')

// Automatic selection should not duplicate Cloudflare setup controls; it can
// still select a ready public route at pairing time without exposing settings.
const cfAutoSeeds = JSON.parse(JSON.stringify(cfLinuxSeeds))
cfAutoSeeds[12] = 'auto'
cfAutoSeeds[8] = () => new Set()
cfAutoSeeds[40] = () => new Set()
const cfAutoExported = loadBundle(seededReact(cfAutoSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfAutoSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const htmlAuto = renderToStaticMarkup(React.createElement(cfAutoExported.DevicePanel, { close: () => {} }))
check(htmlAuto.includes('手机会按实际连通情况在公网与局域网之间自动切换。'), 'automatic route explains its connectivity fallback')
check(!htmlAuto.includes('mgw-cloudflare-block'), 'Cloudflare configuration is hidden in automatic mode')
check(htmlAuto.includes('mgw-cloudflare-block') === false, 'the cloudflare block stays hidden in automatic mode')

// ------------------------------------------- render F: named tunnel mode (Linux)
// The named-tunnel form state: how to obtain the domain and Token, with the
// two jumps to the Cloudflare dashboard and the official guide.
console.log('\n=== render F: named tunnel mode ===')
const cfNamedSeeds = JSON.parse(JSON.stringify(seeds))
cfNamedSeeds[8] = () => new Set()
cfNamedSeeds[40] = () => new Set()
cfNamedSeeds[12] = 'cloudflare'
cfNamedSeeds[9].pairingMode = 'direct'
cfNamedSeeds[9].relay = null
cfNamedSeeds[9].platform = 'linux'
cfNamedSeeds[23] = 'named'
cfNamedSeeds[9].cloudflare = {
  supported: true, enabled: false, mode: 'quick', state: 'disabled', port: 3082,
  configured: false, hostname: '', publicUrl: null, error: '',
}
const cfNamedExported = loadBundle(seededReact(cfNamedSeeds)).factory((id) => {
  if (id === 'react') return seededReact(cfNamedSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const cfNamedRegistrations = []
cfNamedExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { cfNamedRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
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
routeSeeds[8] = () => new Set()
routeSeeds[40] = () => new Set()
routeSeeds[6] = true // showAllDevices so the offline row renders too
routeSeeds[3] = [
  { id: 'd1', name: 'LAN Phone', displayName: 'LAN Phone', online: true, connections: 1, routes: ['lan'], lastSeenAt: 1758000000000 },
  { id: 'd2', name: 'CF Phone', displayName: 'CF Phone', online: true, connections: 2, routes: ['cloudflare'], lastSeenAt: 1758000000000 },
  { id: 'd3', name: 'Old Phone', displayName: 'Old Phone', online: false, connections: 0, routes: [], lastSeenAt: 1757900000000 },
]
const routeExported = loadBundle(seededReact(routeSeeds)).factory((id) => {
  if (id === 'react') return seededReact(routeSeeds)
  throw new Error(`unexpected require: ${id}`)
})
const routeRegistrations = []
routeExported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { routeRegistrations.push({ options: o, component: c }); return () => {} } }, effect: noEffect })
const htmlG = renderToStaticMarkup(React.createElement(routeExported.DevicePanel, { close: () => {} }))
for (const [needle, what] of [
  ['局域网', 'LAN route badge rendered'],
  ['Cloudflare 外网', 'Cloudflare route badge rendered'],
  ['手机当前通过局域网直连（同一 Wi-Fi 或 VPN）', 'LAN badge tooltip explains the route'],
  ['手机当前通过 Cloudflare Tunnel 外网连接', 'Cloudflare badge tooltip explains the route'],
]) check(htmlG.includes(needle), what)

// ------------------------------------------------------- source-level guarantees
console.log('\n=== source guarantees ===')
check(src.includes("ctx.slots.inject('sidebar.footer.action'") && src.includes("'mobile-gateway-devices'"),
  'upstream sidebar footer action registered')
check(src.includes("ctx.slots.inject('shell.overlay'") && src.includes("'mobile-gateway-devices-panel'"),
  'upstream shell overlay registered')
check((src.match(/position: 'fixed'/g) || []).length === 2,
  'fixed positioning is limited to the two dialogs (backdrop + pairing)')
check(src.includes('mgw-pairing-dialog') && src.includes('prefers-reduced-motion'),
  'the pairing dialog is animated and reduced-motion aware')
check(src.includes("['network', '网络检测']") && !src.includes("['install', '安装应用']"),
  'panel offers the network section and no install section')
check(src.includes("value: 'tailscale'") && src.includes('主机 Tailscale 地址'),
  'pairing offers the Tailscale route with a manual host-address input')
check(src.includes("'/mgw/ui'") && src.includes('左侧栏显示入口') && src.includes('toggleEntryMaster')
  && src.includes('entryMaster'),
  'the sidebar entries share a persisted master toggle')
check(src.includes('侧边栏底部入口') && src.includes('左侧栏上方插件区')
  && src.includes("'sidebar.panellist'") && src.includes('syncPluginsAreaSlot')
  && src.includes("id: 'mobile-gateway-panel'")
  && src.includes('getEntryMaster() && getPluginsAreaEntry()'),
  'both sub entries are gated by the master and the panellist slot is registered/unregistered')
check(src.includes('(relayInfo || relayConnector?.running || relayConnector?.delegatedTo || relayConnector?.lastError)'),
  'relay status content is scoped to the mini-program module')
check(src.includes("id: 'mobile-gateway'"), 'registers the mobile-gateway settings section')
check(src.includes('function apiPath') && src.includes('document.baseURI')
  && src.includes('fetch(apiPath(path)'), 'management RPC resolves against the document base (gateway prefix safe)')
check(src.includes("'/mgw/cloudflare'") && src.includes('/mgw/tools/') && src.includes('pairingUrlFor'),
  'cloudflare tunnel, web tools and pairing routes wired')
check(src.includes("'Cloudflare 外网'") && src.includes("'公网或其他手动地址'") && src.includes("'小程序连接（备用）'") && src.includes("'DSH App（推荐）'") && src.includes("route: 'mini'") && !src.includes('建设中'),
  'the app select offers cloudflare and custom routes; the mini module keeps its fixed scheme')
check(src.includes('function GatewaySelect') && src.includes("addEventListener('pointerdown', outside)")
  && src.includes("if (event.key === 'Escape')"),
  'GatewaySelect closes on Escape and on outside pointerdown')
check(src.includes('function GatewaySelect'), 'the panel uses the themed GatewaySelect')
check(src.includes('route: appRoute') && src.includes("route: 'mini'") && src.includes('lanUrl: lanPairingUrl(status)') && !src.includes('deviceName'),
  'pairing requests carry the selected app route and a fixed mini-program route without exposing the device name')
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
check(src.includes("const [appRoute, setAppRoute] = React.useState('auto')") && src.includes('chooseAppRoute('),
  'the app route is a controlled selection updated only by explicit operator choice')
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
