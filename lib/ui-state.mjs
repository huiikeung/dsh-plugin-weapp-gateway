// 面板 UI 偏好：与网关身份/模式分开存储。该文件损坏时回退默认值，
// 不让插件启动失败（身份文件损坏才会 fail closed）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DEFAULTS = {
  version: 1,
  entryMaster: true,   // 左侧栏入口总开关
  sidebarEntry: true,  // 侧边栏底部入口
  pluginsEntry: true,  // 左侧栏上方插件区入口
  appModule: true,     // 连接与配对 · App 配对模块
  miniModule: true,    // 连接与配对 · 小程序配对模块
}
const FIELDS = Object.keys(DEFAULTS).filter(name => name !== 'version')
// 管理接口允许写入的偏好名单（/mgw/ui 用）。
export const UI_PREFERENCES = [...FIELDS]

export function createUiState(file) {
  let state = { ...DEFAULTS }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === 1 && typeof parsed.sidebarEntry === 'boolean') {
      state = {
        version: 1,
        entryMaster: parsed.entryMaster !== false,
        sidebarEntry: parsed.sidebarEntry,
        pluginsEntry: parsed.pluginsEntry !== false,
        appModule: parsed.appModule !== false,
        miniModule: parsed.miniModule !== false,
      }
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
    get entryMaster() { return state.entryMaster },
    get sidebarEntry() { return state.sidebarEntry },
    get pluginsEntry() { return state.pluginsEntry },
    get appModule() { return state.appModule },
    get miniModule() { return state.miniModule },
    // 快照：管理接口 GET 返回全部偏好。
    all() { const snapshot = {}; for (const field of FIELDS) snapshot[field] = state[field]; return snapshot },
    // 通用写入：name 必须是已知布尔偏好，一次只改一个字段，其余保持不变。
    set(name, value) {
      if (!FIELDS.includes(name)) throw new TypeError(`unknown ui preference: ${name}`)
      if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
      const next = { version: 1 }
      for (const field of FIELDS) next[field] = field === name ? value : state[field]
      write(next)
      state = next
    },
  }
}
