// 面板 UI 偏好：与网关身份/模式分开存储。该文件损坏时回退默认值，
// 不让插件启动失败（身份文件损坏才会 fail closed）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DEFAULTS = { version: 1, sidebarEntry: true }

export function createUiState(file) {
  let state = { ...DEFAULTS }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === 1 && typeof parsed.sidebarEntry === 'boolean') {
      state = { version: 1, sidebarEntry: parsed.sidebarEntry }
    }
  } catch { /* 首次运行或文件损坏：使用默认值 */ }
  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  return {
    get sidebarEntry() { return state.sidebarEntry },
    setSidebarEntry(value) {
      if (typeof value !== 'boolean') throw new TypeError('sidebarEntry must be a boolean')
      const next = { version: 1, sidebarEntry: value }
      write(next)
      state = next
    },
  }
}
