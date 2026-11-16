import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 网关内嵌 Tailscale（userspace，不占系统 VPN、不需要安装 Tailscale.app）：
 *  - 启动 tailscaled --tun=userspace-networking
 *  - authKey 或登录链接加入 tailnet（一次性）
 *  - tailscale serve --bg <端口> 把网关端口暴露成 wss://<node>.<tailnet>.ts.net/ws/mobile
 */
function resolveBinary(name) {
  const candidates = [
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/Applications/Tailscale.app/Contents/MacOS/' + (name === 'tailscaled' ? 'tailscaled' : 'Tailscale'),
    name,
  ]
  for (const candidate of candidates) {
    try {
      if (candidate === name) return name
      if (require('node:fs').existsSync(candidate)) return candidate
    } catch (error) { /* ignore */ }
  }
  return name
}

export function createTailscaleServe(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const wsPath = options.wsPath || '/ws/mobile'
  const baseDir = options.baseDir || path.join(os.homedir(), '.dsh', 'tailscale')
  const stateFile = path.join(baseDir, 'tailscaled.state')
  const socketPath = options.socketPath || path.join(baseDir, 'tailscaled.sock')
  const cacheFile = options.file || path.join(baseDir, 'tailscale-serve.json')
  const servePort = Number(options.servePort) || 3081
  const hostname = String(options.hostname || 'dsh-gateway').trim() || 'dsh-gateway'
  const authKey = String(options.authKey || '').trim()
  const tailscaledBin = options.tailscaledPath || resolveBinary('tailscaled')
  const tailscaleBin = options.tailscalePath || resolveBinary('tailscale')

  let child = null
  let starting = false
  let state = { enabled: false, backendState: 'disabled', loginUrl: '', publicUrl: '', error: '' }

  const snapshot = () => ({ ...state })

  async function persist() {
    try {
      await fs.mkdir(baseDir, { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify(snapshot(), null, 2))
    } catch (error) {
      log('tailscale: persist failed ' + (error && error.message ? error.message : String(error)))
    }
  }

  async function cli(args, timeoutMs = 15000) {
    const result = await execFileAsync(tailscaleBin, ['--socket=' + socketPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return String(result.stdout || '')
  }

  async function statusJson() {
    const text = await cli(['status', '--json'])
    return JSON.parse(text)
  }

  async function waitForBackend(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const status = await statusJson()
        state.backendState = String(status.BackendState || 'unknown')
        if (state.backendState === 'Running') return status
        if (state.backendState === 'NeedsLogin' && !state.loginUrl) {
          const authUrl = status.AuthURL || ''
          if (authUrl) state.loginUrl = authUrl
        }
      } catch (error) {
        // tailscaled 尚未就绪
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return null
  }

  async function enableServe() {
    try {
      await cli(['serve', '--bg', String(servePort)])
    } catch (error) {
      log('tailscale: serve failed ' + (error && error.message ? error.message : String(error)))
    }
  }

  async function refresh() {
    const status = await statusJson()
    state.backendState = String(status.BackendState || 'unknown')
    const dnsName = status.Self && status.Self.DNSName ? String(status.Self.DNSName).replace(/\.$/, '') : ''
    if (state.backendState === 'Running' && dnsName) {
      await enableServe()
      state.publicUrl = 'wss://' + dnsName + wsPath
      state.error = ''
    }
    await persist()
    return snapshot()
  }

  async function start() {
    if (starting) return snapshot()
    starting = true
    state = { ...state, enabled: true, error: '' }
    try {
      await fs.mkdir(baseDir, { recursive: true })
      const args = [
        '--tun=userspace-networking',
        '--state=' + stateFile,
        '--socket=' + socketPath,
        '--port=41642',
        '--socks5-server=127.0.0.1:1055',
      ]
      child = spawn(tailscaledBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk) => log('tailscaled: ' + String(chunk).trim()))
      child.stderr.on('data', (chunk) => log('tailscaled: ' + String(chunk).trim()))
      child.on('error', (error) => {
        state.error = 'spawn-failed: ' + (error && error.message ? error.message : String(error))
        log('tailscale: spawn failed ' + state.error)
        child = null
      })
      child.on('exit', (code) => {
        log('tailscaled exited code=' + code)
        child = null
      })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (authKey) {
        try {
          await cli(['up', '--authkey=' + authKey, '--hostname=' + hostname], 60000)
        } catch (error) {
          log('tailscale: up with authkey failed ' + (error && error.message ? error.message : String(error)))
        }
      } else {
        try {
          await cli(['up', '--hostname=' + hostname], 8000)
        } catch (error) {
          const text = String((error && error.stdout) || '') + String((error && error.stderr) || '') +
            String((error && error.message) || '')
          const match = text.match(/https:\/\/login\.tailscale\.com\/[a-z0-9]+/i)
          if (match) state.loginUrl = match[0]
        }
        if (!state.loginUrl) {
          try {
            const status = await statusJson()
            state.loginUrl = status.AuthURL || ''
          } catch (error) { /* ignore */ }
        }
      }
      const running = await waitForBackend()
      if (!running) {
        state.error = state.loginUrl ? 'needs-login' : 'backend-not-running'
      } else {
        await enableServe()
        const dnsName = running.Self && running.Self.DNSName
          ? String(running.Self.DNSName).replace(/\.$/, '') : ''
        if (dnsName) {
          state.publicUrl = 'wss://' + dnsName + wsPath
        }
        state.error = ''
      }
      await persist()
    } catch (error) {
      state.error = error && error.message ? error.message : String(error)
      log('tailscale: start failed ' + state.error)
    } finally {
      starting = false
    }
    return snapshot()
  }

  async function stop() {
    state = { ...state, enabled: false, publicUrl: '', loginUrl: '' }
    if (child) {
      try { child.kill('SIGTERM') } catch (error) { /* ignore */ }
      child = null
    }
    await persist()
    return snapshot()
  }

  async function loginUrl() {
    try {
      const status = await statusJson()
      return status.AuthURL || state.loginUrl
    } catch (error) {
      return state.loginUrl
    }
  }

  return { start, stop, refresh, snapshot, loginUrl, enableServe }
}
