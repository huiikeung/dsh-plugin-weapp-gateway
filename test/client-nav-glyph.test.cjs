// Unit test for the plugin's self-pinned settings-nav glyph.
//
// The `settings.section` slot contract has no icon field, so the core falls
// back to the gear. Instead of patching the core bundle (which any DSH runtime
// re-extract or another plugin's patch can wipe), lib/client.js rewrites its own
// nav-cell <svg> at runtime. This test drives that path with a minimal DOM stub:
// no jsdom, no browser.
const path = require('path')
const fs = require('fs')

const WORKSPACE = '/vol1/1000/Deepseek-Harness/工作台/插件'
const REACT_CANDIDATES = [
  '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web/node_modules',
  path.join(WORKSPACE, 'dsh-session-compactor/node_modules'),
  path.join(WORKSPACE, 'dsh-interactive-reader/node_modules'),
]
const reactModules = REACT_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'react', 'package.json')))
if (!reactModules) throw new Error('no react found in any candidate directory')
const React = require(path.join(reactModules, 'react'))
const clientPath = path.resolve(__dirname, '../lib/client.js')
const src = require('fs').readFileSync(clientPath, 'utf8')

let failed = 0
function check(ok, what) {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}`)
}

// ---------------------------------------------------------------- DOM stub
// Minimal <svg> stub. `innerHTML` is parsed just enough to expose the child
// tags and their attributes, which is all the assertions need.
function makeSvg(tag) {
  const attrs = {}
  let children = []
  const node = {
    tagName: tag,
    get children() { return children },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v) },
    replaceChildren: (...next) => { children = next },
    _attrs: attrs,
  }
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._markup || '' },
    set(markup) {
      node._markup = String(markup)
      children = []
      const tagRe = /<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*(?:\/>|><\/\w+>)/g
      let m
      while ((m = tagRe.exec(node._markup)) !== null) {
        const child = { tagName: m[1], _attrs: {}, children: [] }
        const attrRe = /([\w-]+)="([^"]*)"/g
        let a
        while ((a = attrRe.exec(m[2])) !== null) child._attrs[a[1]] = a[2]
        child.getAttribute = (n) => (n in child._attrs ? child._attrs[n] : null)
        children.push(child)
      }
    },
  })
  return node
}

function makeCell(label, svg) {
  return {
    textContent: label,            // an <svg> contributes no text
    querySelector: (sel) => (sel === 'svg' ? svg : null),
  }
}

let observed = null
global.MutationObserver = class {
  constructor(fn) { this.fn = fn }
  observe(target, options) { observed = { target, options } }
  disconnect() { this.disconnected = true }
}

function installDom(cells) {
  global.document = {
    getElementById: () => null,
    head: { appendChild: () => {} },
    createElement: () => makeSvg('style'),
    createElementNS: (_ns, tag) => makeSvg(tag),
    querySelector: (sel) => (sel === '[role="dialog"]' ? {} : null),
    querySelectorAll: (sel) => (sel === '[role="dialog"] nav button' ? cells : []),
  }
}

function loadModule() {
  let mod = null
  const fakeWindow = { location: { protocol: 'http:', host: '127.0.0.1:2298' }, __ModuleLoader__: { load: (m) => { mod = m } } }
  const req = (id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }
  new Function('window', 'require', src)(fakeWindow, req)
  return mod.factory(req)
}

// ------------------------------------------------- our cell + a neighbour
const ourSvg = makeSvg('svg')
const gearSvg = makeSvg('svg')
const cells = [makeCell('移动设备', ourSvg), makeCell('Web Search', gearSvg)]

console.log('=== apply() pins the glyph ===')
installDom(cells)
const exported = loadModule()
const registrations = []
exported.apply({ slots: { inject: (n, t) => t(), register: (o, c) => { registrations.push({ o, c }); return () => {} } } })

check(ourSvg.getAttribute('viewBox') === '0 0 24 24', 'our svg viewBox rewritten to 24')
check(ourSvg.getAttribute('stroke') === 'currentColor', 'stroke = currentColor (follows the nav label colour)')
check(ourSvg.getAttribute('stroke-width') === '1.8', 'stroke-width = 1.8 (the original phone outline weight)')
check(ourSvg.children.length === 2, 'gear children replaced (rect + path)')
check(ourSvg.children[0].tagName === 'rect' && ourSvg.children[0].getAttribute('rx') === '2.5', 'phone body rect kept')
check(ourSvg.children[1].tagName === 'path' && ourSvg.children[1].getAttribute('d') === 'M10 18h4', 'speaker line kept')
check(ourSvg.getAttribute('data-mgw-nav-icon') === '1', 'marked as pinned')
check(gearSvg.getAttribute('viewBox') === null, 'neighbour nav cell untouched')
check(observed !== null && observed.options.subtree === true, 'MutationObserver armed for shell re-renders')

console.log('\n=== idempotent (observer re-fire must not double-apply) ===')
const before = ourSvg.children.length
observed.target // no-op; simulate the observer firing again
// Re-run the same apply path the observer would run.
installDom(cells)
const exported2 = loadModule()
exported2.apply({ slots: { inject: (n, t) => t(), register: () => () => {} } })
check(ourSvg.children.length === before, 'still exactly rect + path after a second pass')
check(ourSvg.children[0].tagName === 'rect', 'still the phone body (no gear remnant)')

console.log('\n=== survives a shell re-render that restores the gear ===')
const freshSvg = makeSvg('svg')          // React replaced the node → no marker
freshSvg.setAttribute('viewBox', '0 0 16 16')
installDom([makeCell('移动设备', freshSvg), makeCell('Web Search', gearSvg)])
const exported3 = loadModule()
exported3.apply({ slots: { inject: (n, t) => t(), register: () => () => {} } })
check(freshSvg.getAttribute('viewBox') === '0 0 24 24' && freshSvg.children.length === 2, 'glyph re-pinned on a fresh node')

console.log('\n=== no dialog open → no work, no throw ===')
global.document = { getElementById: () => null, head: { appendChild: () => {} }, createElement: () => makeSvg('style'), createElementNS: (_ns, tag) => makeSvg(tag), querySelector: () => null, querySelectorAll: () => [] }
let threw = null
try { loadModule().apply({ slots: { inject: (n, t) => t(), register: () => () => {} } }) } catch (e) { threw = e }
check(threw === null, 'apply() is safe with no settings dialog')

console.log('\n=== a throwing glyph must not blank the cell ===')
const gearSvg2 = makeSvg('svg')
gearSvg2.setAttribute('viewBox', '0 0 16 16')
gearSvg2.innerHTML = '<g></g><path d="M0 0h1v1H0z"></path>'
installDom([makeCell('移动设备', gearSvg2)])
let warned = null
const realWarn = console.warn
console.warn = (...a) => { warned = a[0] }
try {
  loadModule().pinNavGlyph(['移动设备'], 'data-test-mark', () => { throw new Error('boom') })
} finally { console.warn = realWarn }
check(gearSvg2.children.length === 2, 'shell glyph untouched (still has its own children)')
check(gearSvg2.getAttribute('viewBox') === '0 0 16 16', 'shell viewBox untouched')
check(gearSvg2.getAttribute('data-test-mark') === null, 'not marked as pinned (will retry next pass)')
check(typeof warned === 'string' && warned.includes('nav glyph failed'), 'failure is logged, not silent')

console.log('\n=== a good glyph still pins after a failed attempt ===')
loadModule().pinNavGlyph(['移动设备'], 'data-test-mark', () => ({
  viewBox: '0 0 24 24',
  markup: '<rect rx="2.5"></rect>',
}))
check(gearSvg2.getAttribute('viewBox') === '0 0 24 24' && gearSvg2.children.length === 1, 'recovers on the next pass')

if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1) }
console.log('\nALL CHECKS PASSED')
