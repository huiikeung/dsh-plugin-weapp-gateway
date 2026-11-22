// 网关内嵌 Tailscale 节点管理（轻量模式）。
//
// 两种节点来源，按 tailscaleMode 自动选择：
//  1) system  —— 用户电脑本身已安装并登录 Tailscale：直接读取本机 100.64/10 私网地址，
//                不做任何 spawn（零安装、零权限，账号归用户）。
//  2) embedded —— 电脑没有 Tailscale：spawn 自研 helper（helper/tsnet-node，tsnet 1.104.5），
//                由用户在插件里填自己的 Auth Key，或通过登录链接授权自己的账号。
//                不依赖系统 tailscaled、不占系统 VPN / TUN。
//
// 与旧版 tailscale-serve.mjs 保持相同的方法面（start/stop/refresh/snapshot/loginUrl/enableServe），
// 便于 index.mjs 无痛替换；snapshot 额外带 nodeSource / dnsName / ipv4 / urls 等字段。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { tailscaleInterfaceStatus } from './tailscale-addresses.mjs'

const DEFAULT_CONTROL_URL = 'https://controlplane.tailscale.com'
const EMBEDDED_STATUS = 'embedded-node.json'
const MODES = new Set(['auto', 'system', 'embedded', 'off'])

function normalizeMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase()
  return MODES.has(mode) ? mode : 'auto'
}

function platformDir(platform = process.platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

function archDir(arch = process.arch) {
  if (arch === 'x64') return 'amd64'
  if (arch === 'ia32') return '386'
  return arch
}

/** helper 二进制位置：显式配置 > 环境变量 > 插件仓库内构建产物 */
export function resolveHelperBinary(explicit) {
  const name = process.platform === 'win32' ? 'dsh-tailscale-node.exe' : 'dsh-tailscale-node'
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_TSNET_HELPER) candidates.push(process.env.DSH_TSNET_HELPER)
  candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..', 'helper', 'tsnet-node', 'bin', platformDir() + '-' + archDir(), name))
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..', 'helper', 'tsnet-node', 'bin', platformDir() + '-' + archDir(), name))
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch (error) { /* ignore */ }
  }
  return ''
}

/** 系统 Tailscale 检测：只看本机网卡，不执行任何命令、不推断登录状态 */
export function detectSystemTailscale({ port = 3081, wsPath = '/ws/mobile', host = '0.0.0.0' } = {}) {
  try {
    const status = tailscaleInterfaceStatus({ listening: true, host, port, wsPath })
    return { addresses: status.addresses || [], urls: status.urls || [] }
  } catch (error) {
    return { addresses: [], urls: [] }
  }
}

export function createTailscaleNode(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const mode = normalizeMode(options.mode)
  // 内嵌节点必须用自己的状态目录：与系统/手动 tailscaled 共用同一个目录会复用同一份节点密钥，
  // 控制面会把两个进程当成同一个节点互相踢，表现就是永远 Starting。
  const stateDir = options.stateDir || path.join(os.homedir(), '.dsh', 'tailscale', 'embedded')
  const statusFile = options.statusFile || path.join(stateDir, EMBEDDED_STATUS)
  const snapshotFile = options.snapshotFile || path.join(stateDir, 'tailscale-node.json')
  const wsPath = options.wsPath || '/ws/mobile'
  const listenPort = Number(options.listenPort) || 3081
  const httpsPort = Number(options.httpsPort) || 0
  // 本机若有 HTTP 代理（Clash/Surge 等），tsnet 的控制面/DERP 必须显式走代理，
  // 否则在 fake-ip 代理环境下 controlplane 注册会超时（表现：一直 Starting）。
  const configuredProxy = String(options.proxy || '').trim()
  // 显式填 off/none/disabled 可彻底关闭代理（不探测、不注入环境变量）
  const proxyDisabled = /^(off|none|disabled|0|false)$/i.test(configuredProxy)
  const proxy = proxyDisabled ? '' : (configuredProxy || String(process.env.HTTPS_PROXY || process.env.https_proxy || '').trim())
  function defaultHostname() {
    const platform = process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'mac' : (process.platform === 'linux' ? 'linux' : 'os'))
    return 'dsh-gateway-' + platform
  }
  const configuredHostname = String(options.hostname || '').trim()
  // 旧版本默认值是 'dsh-gateway'：视为未配置，改用平台默认名（dsh-gateway-win/mac/linux）
  let hostname = (configuredHostname && configuredHostname !== 'dsh-gateway') ? configuredHostname : defaultHostname()
  const controlURL = String(options.controlUrl || DEFAULT_CONTROL_URL).trim() || DEFAULT_CONTROL_URL
  let authKey = String(options.authKey || '').trim()
  if (authKey && !hostname.endsWith('-ak')) hostname += '-ak'
  const helperPath = resolveHelperBinary(options.helperPath)
  const forceEmbedded = options.forceEmbedded === true

  let child = null
  let timer = null
  let stopping = false
  let lastRespawnAt = 0
  let startedAt = Date.now()
  let last = {
    enabled: false,
    mode,
    state: 'disabled',
    backendState: 'disabled',
    nodeSource: 'none',
    loginUrl: '',
    publicUrl: '',
    error: '',
    dnsName: '',
    ipv4: '',
    authMode: authKey ? 'authkey' : 'login',
    listenPort,
    hostname,
    urls: [],
    helper: helperPath,
  }

  const snapshot = () => ({ ...last })

  function persist() {
    try {
      fs.mkdirSync(path.dirname(snapshotFile), { recursive: true, mode: 0o700 })
      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot(), null, 2), { mode: 0o600 })
    } catch (error) {
      log('tailscale-node: persist failed ' + (error && error.message ? error.message : String(error)))
    }
  }

  function embeddedUrls(state) {
    const urls = []
    if (state.ipv4) urls.push('ws://' + state.ipv4 + ':' + listenPort + wsPath)
    if (state.httpsUrl) urls.push(state.httpsUrl)
    return urls
  }

  function readEmbedded() {
    try {
      const raw = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
      return raw && typeof raw === 'object' ? raw : null
    } catch (error) {
      return null
    }
  }

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return false
    }
  }

  // 进程被杀（例如 DSH 重启）后状态文件会被保留成 "running"：
  // 必须按 pid 复核存活，否则面板显示已连接但实际不可用，也不会重新拉起。
  function statusPidAlive(state) {
    const pid = Number(state && state.pid)
    if (Number.isInteger(pid) && pid > 0) return pidAlive(pid)
    return false
  }

  function applyEmbedded() {
    const state = readEmbedded()
    const childAlive = child !== null && child.exitCode === null
    if (!state) {
      // 启动过但一直没有状态文件，且子进程也不在：重试拉起（DSH 重启后锁文件残留等场景）
      if (!childAlive && !stopping && Date.now() - startedAt > 8000 && Date.now() - lastRespawnAt > 8000) {
        lastRespawnAt = Date.now()
        log('tailscale-node: no status file and no child, retrying start')
        start().catch(() => {})
      }
      return
    }
    const stateName = String(state.state || 'starting')
    const aliveByPid = statusPidAlive(state)
    // 状态文件里的 pid 已死但文件仍写着 running/starting：进程被外部杀掉（典型是 DSH 重启）。
    // 旧实现直接信任状态文件，于是面板显示已连接、实际上没有任何进程在跑。
    if (!aliveByPid && !childAlive && (stateName === 'running' || stateName === 'starting') &&
        Date.now() - lastRespawnAt > 5000) {
      lastRespawnAt = Date.now()
      log('tailscale-node: helper pid is gone, respawning')
      last = { ...last, state: 'starting', backendState: 'Starting', publicUrl: '', urls: [], error: '' }
      try { fs.rmSync(statusFile, { force: true }) } catch (error) { /* ignore */ }
      persist()
      start().catch(() => {})
      return
    }
    const urls = embeddedUrls(state)
    last = {
      ...last,
      enabled: true,
      nodeSource: 'embedded',
      state: String(state.state || 'starting'),
      authMode: state.authMode || last.authMode,
      loginUrl: state.loginUrl || '',
      dnsName: state.dnsName || '',
      ipv4: state.ipv4 || '',
      error: state.error || '',
      urls,
      publicUrl: state.httpsUrl || (state.ipv4 ? 'ws://' + state.ipv4 + ':' + listenPort + wsPath : ''),
      backendState: state.state === 'running' ? 'Running'
        : state.state === 'needs-login' ? 'NeedsLogin'
          : state.state === 'failed' ? 'Failed'
            : state.state === 'stopped' ? 'disabled' : 'Starting',
    }
    if (last.state === 'running') last.error = ''
    persist()
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      try {
        applyEmbedded()
      } catch (error) {
        log('tailscale-node: poll failed ' + (error && error.message ? error.message : String(error)))
      }
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function applySystem() {
    const detected = detectSystemTailscale({ port: listenPort, wsPath })
    if (detected.urls.length > 0) {
      last = {
        ...last,
        enabled: true,
        nodeSource: 'system',
        state: 'running',
        backendState: 'Running',
        authMode: 'system',
        loginUrl: '',
        error: '',
        urls: detected.urls,
        publicUrl: detected.urls[0],
        ipv4: detected.addresses[0] || '',
        dnsName: '',
      }
      persist()
      return true
    }
    return false
  }

  async function start(overrides = {}) {
    stopping = false
    const force = forceEmbedded || overrides.forceEmbedded === true
    last = { ...last, enabled: true, error: '' }
    if (mode === 'off') {
      last = { ...last, enabled: false, state: 'disabled', backendState: 'disabled', nodeSource: 'none' }
      persist()
      return snapshot()
    }
    // 1) 系统安装优先（system / auto）
    if (mode !== 'embedded' && applySystem()) {
      log('tailscale-node: using system Tailscale ' + (last.urls[0] || ''))
      return snapshot()
    }
    if (mode === 'system') {
      last = { ...last, nodeSource: 'none', state: 'failed', backendState: 'Failed',
        error: 'system Tailscale not detected; install Tailscale or switch mode to embedded' }
      persist()
      return snapshot()
    }
    // 2) 内嵌节点：用户配置了 authKey、显式开启、mode=embedded，或已有登录态（重启后自愈）时才 spawn，
    //    避免在用户完全没配置 Tailscale 时凭空起一个等待登录的节点。
    const hasEmbeddedState = fs.existsSync(path.join(stateDir, 'tailscaled.state'))
    if (!force && !authKey && mode !== 'embedded' && !hasEmbeddedState) {
      last = { ...last, enabled: false, nodeSource: 'none', state: 'disabled', backendState: 'disabled',
        error: 'no system Tailscale detected; set an Auth Key (or use the login link) to start the embedded node' }
      persist()
      return snapshot()
    }
    if (!helperPath) {
      last = { ...last, nodeSource: 'none', state: 'failed', backendState: 'Failed',
        error: 'tailscale helper not found; build helper/tsnet-node or set tailscaleHelperPath' }
      persist()
      return snapshot()
    }
    try {
      fs.rmSync(statusFile, { force: true })
    } catch (error) { /* ignore */ }
    const args = [
      '--state-dir', stateDir,
      '--hostname', hostname,
      '--control-url', controlURL,
      '--listen-port', String(listenPort),
      '--status-file', statusFile,
    ]
    if (httpsPort > 0) args.push('--https-port', String(httpsPort))
    if (authKey) args.push('--auth-key', authKey)
    if (proxy) args.push('--proxy', proxy)
    if (proxyDisabled) args.push('--proxy-auto=false')
    // 防止重复 spawn：残留的 helper 会和新进程抢同一份状态，导致永远 Starting
    if (child !== null) {
      try { child.kill('SIGTERM') } catch (error) { /* ignore */ }
      child = null
    }
    log('tailscale-node: spawning embedded helper ' + helperPath)
    const childEnv = { ...process.env }
    if (proxy) {
      childEnv.HTTP_PROXY = proxy
      childEnv.HTTPS_PROXY = proxy
      childEnv.http_proxy = proxy
      childEnv.https_proxy = proxy
      childEnv.ALL_PROXY = proxy
      childEnv.all_proxy = proxy
    }
    child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
    child.stdout.on('data', (chunk) => log('tsnet-node: ' + String(chunk).trim()))
    child.stderr.on('data', (chunk) => log('tsnet-node: ' + String(chunk).trim()))
    child.on('error', (error) => {
      last = { ...last, state: 'failed', backendState: 'Failed', error: 'helper spawn failed: ' + error.message }
      child = null
      persist()
    })
    child.on('exit', (code) => {
      child = null
      if (stopping) return
      last = { ...last, state: 'failed', backendState: 'Failed', error: 'helper exited (code=' + code + ')' }
      persist()
      log('tailscale-node: helper exited code=' + code)
    })
    last = { ...last, nodeSource: 'embedded', state: 'starting', backendState: 'Starting' }
    persist()
    startTimer()
    applyEmbedded()
    return snapshot()
  }

  async function stop() {
    stopping = true
    stopTimer()
    if (child) {
      try { child.kill('SIGTERM') } catch (error) { /* ignore */ }
      child = null
    }
    last = { ...last, enabled: false, nodeSource: 'none', state: 'disabled', backendState: 'disabled',
      loginUrl: '', publicUrl: '', urls: [], error: '' }
    persist()
    return snapshot()
  }

  async function refresh() {
    if (mode !== 'embedded' && last.nodeSource !== 'embedded') {
      if (!applySystem() && last.nodeSource === 'system') {
        last = { ...last, nodeSource: 'none', state: 'disabled', backendState: 'disabled', urls: [], publicUrl: '' }
        persist()
      }
    }
    if (last.nodeSource === 'embedded') applyEmbedded()
    return snapshot()
  }

  function setAuthKey(nextKey) {
    authKey = String(nextKey || '').trim()
    if (authKey && !hostname.endsWith('-ak')) hostname += '-ak'
    if (!authKey && hostname.endsWith('-ak')) hostname = hostname.slice(0, -3)
    last = { ...last, authMode: authKey ? 'authkey' : 'login', hostname }
    persist()
    return snapshot()
  }

  function setHostname(nextName) {
    const value = String(nextName || '').trim()
    hostname = value || defaultHostname()
    if (authKey && !hostname.endsWith('-ak')) hostname += '-ak'
    last = { ...last, hostname }
    persist()
    return snapshot()
  }

  async function loginUrl() {
    const embedded = readEmbedded()
    return (embedded && embedded.loginUrl) || last.loginUrl || ''
  }

  return { start, stop, refresh, snapshot, loginUrl, setAuthKey, setHostname, enableServe: refresh, resolveHelperBinary }
}
