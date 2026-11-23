// 面板 UI 偏好：侧边栏入口与配对模块开关的持久化、默认值与损坏回退。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createUiState } from '../lib/ui-state.mjs'

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-ui-state-'))
  return { directory, file: path.join(directory, 'devices.json.ui.json') }
}

test('defaults: sidebar + plugins-area entries visible, modules shown', () => {
  const { directory, file } = tempFile()
  try {
    const state = createUiState(file)
    assert.equal(state.entryMaster, true)
    assert.equal(state.sidebarEntry, true)
    assert.equal(state.pluginsEntry, true)
    assert.equal(state.appModule, true)
    assert.equal(state.miniModule, true)
    // 快照与逐项 getter 一致
    assert.deepEqual(state.all(), {
      entryMaster: true, sidebarEntry: true, pluginsEntry: true,
      appModule: true, miniModule: true,
    })
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('persists toggles across instances and writes a private file', () => {
  const { directory, file } = tempFile()
  try {
    const state = createUiState(file)
    state.set('sidebarEntry', false)
    state.set('pluginsEntry', true)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const reloaded = createUiState(file)
    assert.equal(reloaded.sidebarEntry, false)
    assert.equal(reloaded.pluginsEntry, true)
    assert.equal(reloaded.entryMaster, true)
    state.set('miniModule', false)
    state.set('appModule', false)
    state.set('miniModule', false)
    const after = createUiState(file)
    assert.equal(after.appModule, false)
    assert.equal(after.miniModule, false)
    // 其余字段互不覆盖
    assert.equal(after.sidebarEntry, false)
    assert.equal(after.entryMaster, true)
    assert.match(fs.readFileSync(file, 'utf8'), /"appModule":false/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('rejects unknown names and non-boolean values without touching the saved state', () => {
  const { directory, file } = tempFile()
  try {
    const state = createUiState(file)
    state.set('sidebarEntry', false)
    assert.throws(() => state.set('sidebarEntry', 'no'), /boolean/)
    assert.throws(() => state.set('nope', true), /unknown ui preference/)
    assert.throws(() => state.set('appModule', 1), /boolean/)
    const after = createUiState(file)
    assert.equal(after.sidebarEntry, false)
    assert.equal(after.appModule, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a corrupt preference file falls back to defaults instead of failing startup', () => {
  const { directory, file } = tempFile()
  try {
    fs.writeFileSync(file, '{not json')
    const state = createUiState(file)
    assert.equal(state.entryMaster, true)
    assert.equal(state.sidebarEntry, true)
    assert.equal(state.pluginsEntry, true)
    fs.writeFileSync(file, JSON.stringify({ version: 1, sidebarEntry: 'yes' }))
    assert.equal(createUiState(file).sidebarEntry, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a legacy file without the new flags keeps known values and defaults the rest', () => {
  const { directory, file } = tempFile()
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sidebarEntry: false, entryMaster: false }))
    const state = createUiState(file)
    assert.equal(state.sidebarEntry, false)
    assert.equal(state.entryMaster, false)
    assert.equal(state.pluginsEntry, true)
    assert.equal(state.appModule, true)
    assert.equal(state.miniModule, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
