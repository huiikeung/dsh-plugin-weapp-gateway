import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** 从宿主入口解析启动包，避免误读插件依赖或 PATH 上另一份 DSH 的版本。 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 从桌面端打包的 runtime.json 读真实版本（Electron 宿主里 without app-boot 依赖时兜底） */
function resolveDesktopRuntimeVersion() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'runtime', 'primary-runtime', 'runtime.json'))
    candidates.push(path.join(process.resourcesPath, 'runtime', 'runtime.json'))
  }
  if (typeof process.execPath === 'string' && process.execPath) {
    const dir = path.dirname(process.execPath)
    candidates.push(path.join(dir, '..', 'Resources', 'runtime', 'primary-runtime', 'runtime.json'))
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      const version = manifest.desktopVersion
      if (typeof version === 'string' && SEMVER.test(version)) return version
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return undefined
}

export function resolveDshRuntimeVersion(entrypoint = process.argv[1]) {
  if (entrypoint) {
    try {
      const entry = fs.realpathSync(path.resolve(entrypoint))
      const require = createRequire(entry)
      const filename = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
      const version = manifest.version
      // 探测失败时省略字段，不能把适配基线伪装成实际版本。
      if (manifest.name === '@deepseek-ai/dsh-app-boot' && typeof version === 'string' && SEMVER.test(version)) {
        return version
      }
    } catch {
      // 落回桌面端 runtime.json
    }
  }
  return resolveDesktopRuntimeVersion()
}
