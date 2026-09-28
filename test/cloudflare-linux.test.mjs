// Fork extension: managed Cloudflare Tunnels on Linux servers.
//
// Upstream keeps cloudflared PC-only because its checksummed auto-download only
// publishes darwin/win32 assets. On Linux the operator installs cloudflared
// from Cloudflare's GPG-signed distro repo (pkg.cloudflare.com/cloudflared),
// so the tunnel manager must (a) report the platform as supported and (b) run
// the installed binary instead of downloading one.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCloudflared } from '../lib/cloudflared-binary.mjs'
import { createCloudflareTunnel } from '../lib/cloudflare-tunnel.mjs'

let checks = 0
function check(ok, what) {
  checks++
  if (!ok) { console.error(`FAIL  ${what}`); process.exitCode = 1 }
  else console.log(`OK    ${what}`)
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-linux-'))

// --- ensureCloudflared: Linux resolves an installed binary, never downloads ---

// A bare name on Linux goes through PATH lookup, not the PC download table.
const externalBinary = path.join(temp, 'installed-cloudflared')
fs.writeFileSync(externalBinary, '#!/bin/sh\n', { mode: 0o755 })
check(await ensureCloudflared({
  cacheDir: path.join(temp, 'cache'), platform: 'linux',
  resolveExecutable: async () => externalBinary,
  fetchImpl: () => { throw new Error('unexpected download on Linux') },
}) === externalBinary, 'linux resolves cloudflared via PATH to the installed binary')

// A configured absolute path still wins on Linux.
check(await ensureCloudflared({
  cacheDir: path.join(temp, 'cache'), platform: 'linux', executable: externalBinary,
  resolveExecutable: async () => { throw new Error('PATH lookup should be skipped') },
}) === externalBinary, 'linux prefers a configured cloudflaredPath without PATH lookup')

// Nothing installed, nothing configured: a clear, actionable error.
await assert.rejects(() => ensureCloudflared({
  cacheDir: path.join(temp, 'cache'), platform: 'linux',
  resolveExecutable: async () => null,
  fetchImpl: () => { throw new Error('unexpected download on Linux') },
}), /未找到 cloudflared/, 'linux without cloudflared fails with the install hint')
console.log('OK    linux without cloudflared fails with the install hint')

// --- index.mjs gate: Linux is reported as supported -------------------------
const indexSrc = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
check(/supported: process\.platform === 'linux' \|\| process\.platform === 'darwin'/.test(indexSrc),
  'index.mjs reports cloudflare support on linux as well as darwin/win32')

// --- tunnel manager: spawns the Linux binary end to end ----------------------
// supported=true with the real host platform (Linux in CI here) plus the
// installed-binary resolution path the plugin uses on the NAS.
const stateFile = path.join(temp, 'state.json')
const spawns = []
const spawned = createCloudflareTunnel({
  file: stateFile,
  port: 3182,
  wsPath: '/ws/mobile',
  supported: true,
  isGatewayEnabled: () => true,
  onUpgrade: () => {},
  spawnProcess: (command, args, options) => {
    spawns.push({ command, args, windowsHide: options.windowsHide })
    return { killed: false, kill() {}, stdout: { on() {} }, stderr: { on() {} }, on() {} }
  },
  prepareExecutable: async () => externalBinary,
})

await spawned.configure({ enabled: true, mode: 'quick' })
await new Promise((resolve) => setTimeout(resolve, 30))
check(spawns.length === 1, 'linux supported tunnel spawns a child')
check(spawns[0]?.command === externalBinary, 'linux tunnel runs the installed cloudflared binary')
const quickArgs = spawns[0]?.args || []
check(quickArgs.includes('--url') && quickArgs[quickArgs.indexOf('--url') + 1] === 'http://127.0.0.1:3182',
  'quick mode targets the loopback mobile endpoint')
const snap = spawned.snapshot()
check(snap.supported === true && snap.enabled === true, 'snapshot reports an enabled supported tunnel on linux')
spawned.dispose()
await new Promise((resolve) => setTimeout(resolve, 30))

console.log(`\ncloudflare-linux: ${checks} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
