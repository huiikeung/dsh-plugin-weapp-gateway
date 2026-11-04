// 面板 UI 偏好：侧边栏入口开关的持久化、默认值与损坏回退。
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

test('defaults to showing the sidebar entry', () => {
  const { directory, file } = tempFile()
  try {
    const state = createUiState(file)
    assert.equal(state.sidebarEntry, true)
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('persists the toggle across instances and writes a private file', () => {
  const { directory, file } = tempFile()
  try {
    createUiState(file).setSidebarEntry(false)
    assert.equal(createUiState(file).sidebarEntry, false)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(file, 'utf8'), /"sidebarEntry":false/)
    createUiState(file).setSidebarEntry(true)
    assert.equal(createUiState(file).sidebarEntry, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('rejects non-boolean values without touching the saved state', () => {
  const { directory, file } = tempFile()
  try {
    const state = createUiState(file)
    state.setSidebarEntry(false)
    assert.throws(() => state.setSidebarEntry('no'), /boolean/)
    assert.equal(createUiState(file).sidebarEntry, false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a corrupt preference file falls back to defaults instead of failing startup', () => {
  const { directory, file } = tempFile()
  try {
    fs.writeFileSync(file, '{not json')
    const state = createUiState(file)
    assert.equal(state.sidebarEntry, true)
    fs.writeFileSync(file, JSON.stringify({ version: 1, sidebarEntry: 'yes' }))
    assert.equal(createUiState(file).sidebarEntry, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
