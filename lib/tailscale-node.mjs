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
  const stateDir = options.stateDir || path.join(os.homedir(), '.dsh', 'tailscale')
  const statusFile = options.statusFile || path.join(stateDir, EMBEDDED_STATUS)
  const snapshotFile = options.snapshotFile || path.join(stateDir, 'tailscale-node.json')
  const wsPath = options.wsPath || '/ws/mobile'
  const listenPort = Number(options.listenPort) || 3081
  const httpsPort = Number(options.httpsPort) || 0
  const hostname = String(options.hostname || 'dsh-gateway').trim() || 'dsh-gateway'
  const controlURL = String(options.controlUrl || DEFAULT_CONTROL_URL).trim() || DEFAULT_CONTROL_URL
  const authKey = String(options.authKey || '').trim()
  const helperPath = resolveHelperBinary(options.helperPath)
  const forceEmbedded = options.forceEmbedded === true

  let child = null
  let timer = null
  let stopping = false
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

  function applyEmbedded() {
    const state = readEmbedded()
    if (!state) {
      if (child && child.exitCode === null) return
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

  async function start() {
    stopping = false
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
    // 2) 内嵌节点：只有用户配置了 authKey、或显式开启、或 mode=embedded 时才 spawn，
    //    避免在用户完全没配置 Tailscale 时凭空起一个等待登录的节点。
    if (!forceEmbedded && !authKey && mode !== 'embedded') {
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
    log('tailscale-node: spawning embedded helper ' + helperPath)
    child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

  async function loginUrl() {
    const embedded = readEmbedded()
    return (embedded && embedded.loginUrl) || last.loginUrl || ''
  }

  return { start, stop, refresh, snapshot, loginUrl, enableServe: refresh, resolveHelperBinary }
}
