// Local shim for @deepseek-ai/dsh-home-paths (used by the vendored WorkBuddy
// adapter). Mirrors the DSH home resolution rules without adding a package
// dependency to the gateway plugin.
import os from 'node:os'
import path from 'node:path'

export function resolveDshHome() {
  const configured = String(process.env.DSH_HOME || '').trim()
  if (configured === '~') return os.homedir()
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2))
  if (configured) return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}
