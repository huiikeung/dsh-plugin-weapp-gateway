import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  assertPublicIpv4,
  certName,
  currentPackageSpec,
  helperService,
  isMainModule,
  nginxHttpConfig,
  nginxTlsConfig,
  parseArgs,
  pluginInstallArgs,
  renewalService,
  renewalTimer,
} from '../bin/setup-ip.mjs'

const parsed = parseArgs(['setup', '--ip', '203.0.113.7', '--port', '33080', '--email', 'ops@example.com', '--yes'])
assert.deepEqual(parsed, {
  command: 'setup',
  port: 33080,
  yes: true,
  ip: '203.0.113.7',
  email: 'ops@example.com',
})

assert.doesNotThrow(() => assertPublicIpv4('8.8.8.8'))
for (const address of ['', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '224.0.0.1']) {
  assert.throws(() => assertPublicIpv4(address))
}

assert.equal(certName('203.0.113.7'), 'dsh-mobile-gateway-203-0-113-7')
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(currentPackageSpec(), `${packageManifest.name}@${packageManifest.version}`)
assert.deepEqual(pluginInstallArgs('dsh-plugin-weapp-gateway@9.8.7'), [
  'plugin', '--profile', 'web', 'add', 'dsh-plugin-weapp-gateway@9.8.7',
  '--config.minimum-release-age-exclude=dsh-plugin-weapp-gateway@9.8.7',
])

const httpConfig = nginxHttpConfig('203.0.113.7')
assert.match(httpConfig, /listen 80;/)
assert.match(httpConfig, /server_name 203\.0\.113\.7;/)
assert.match(httpConfig, /\.well-known\/acme-challenge/)
assert.match(httpConfig, /location \/ \{ return 404; \}/)

const tlsConfig = nginxTlsConfig('203.0.113.7', 33080)
assert.match(tlsConfig, /listen 443 ssl;/)
assert.match(tlsConfig, /location = \/ws\/mobile/)
assert.match(tlsConfig, /proxy_pass http:\/\/127\.0\.0\.1:33080;/)
assert.match(tlsConfig, /if \(\$args != ""\) \{ return 404; \}/)
assert.doesNotMatch(tlsConfig, /location \/mgw/)

assert.match(renewalService(), /certbot renew --quiet/)
assert.match(renewalService(), /systemctl reload nginx/)
assert.match(renewalTimer(), /OnCalendar=\*-\*-\* 00,12:00:00/)
assert.match(helperService(1000), /ExecStart=\/usr\/bin\/python3 .* --uid 1000/)
assert.match(helperService(1000), /NoNewPrivileges=true/)
assert.doesNotMatch(helperService(1000), /\/bin\/sh/)

const helperPath = fileURLToPath(new URL('../helper/dsh_mobile_gateway_helper.py', import.meta.url))
// 真解释器探测：Windows 上 python3/python 可能只是 App Execution Alias 占位桩，
// 能以 0 退出却什么都不做（"Python was not found; ..."）。用版本号开头判断真假，
// 找不到可用解释器就跳过这项语法检查——它是 lint，不是被测逻辑本身。
function resolvePython() {
  for (const candidate of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0 && /^Python \d+\.\d+/m.test((probe.stdout || '') + (probe.stderr || ''))) return candidate
  }
  return null
}
const pythonInterpreter = resolvePython()
if (pythonInterpreter) {
  const helperSyntax = spawnSync(pythonInterpreter, ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")', helperPath], { encoding: 'utf8' })
  assert.equal(helperSyntax.status, 0, helperSyntax.stderr)
} else {
  console.log('helper syntax check skipped: no working Python interpreter on PATH (set PYTHON to enable)')
}

const binPath = fileURLToPath(new URL('../bin/setup-ip.mjs', import.meta.url))
const directInvocation = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' })
assert.equal(directInvocation.status, 0, directInvocation.stderr)
assert.match(directInvocation.stdout, /dsh-plugin-weapp-gateway setup/)
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-gateway-bin-'))
try {
  const linkedBin = path.join(temporaryDirectory, 'dsh-plugin-weapp-gateway')
  fs.symlinkSync(binPath, linkedBin)
  assert.equal(isMainModule(linkedBin), true)
  const linkedInvocation = spawnSync(process.execPath, [linkedBin, '--help'], { encoding: 'utf8' })
  assert.equal(linkedInvocation.status, 0, linkedInvocation.stderr)
  assert.match(linkedInvocation.stdout, /dsh-plugin-weapp-gateway setup/)
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
  console.log(`symlink launcher test skipped: ${error.code}`)
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true })
}

console.log('public IP setup tests passed')
