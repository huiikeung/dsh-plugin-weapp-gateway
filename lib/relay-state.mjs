import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Pairing payload shapes. `direct` keeps the historical QR that advertises the
// gateway's own ws/wss endpoints; `relay` emits the outbound-relay payload the
// WeChat mini-program consumes. Both stay supported and the operator picks one.
export const PAIRING_MODES = ['direct', 'relay']

const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BASE64 = /^[A-Za-z0-9+/]{20,}={0,2}$/

const isRelay = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.relay === 'string' && /^wss?:\/\//.test(value.relay)
  && typeof value.nodeId === 'string' && NODE_ID.test(value.nodeId)
  && typeof value.agentPubKey === 'string' && BASE64.test(value.agentPubKey)
  && typeof value.gatewayName === 'string' && value.gatewayName.length > 0
  && value.gatewayName.length <= 80
  && Number.isSafeInteger(value.updatedAt)

// A dedicated file keeps the relay registration independent of device
// revocation and of the gateway identity. A malformed file must fail startup
// rather than silently drop a registration the operator relies on.
export function createRelayState(file) {
  const validate = (value) => {
    if (!value || value.version !== 1) throw new Error('invalid relay state')
    if (!PAIRING_MODES.includes(value.pairingMode)) throw new Error('invalid pairing mode')
    if (value.relay !== null && !isRelay(value.relay)) throw new Error('invalid relay registration')
    return value
  }
  const read = () => validate(JSON.parse(fs.readFileSync(file, 'utf8')))
  const write = (value, initial = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      if (initial) fs.linkSync(tmp, file) // Never overwrite a concurrently created file.
      else fs.renameSync(tmp, file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  let state
  try {
    try {
      state = read()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // `direct` is the historical behaviour, so an existing installation that
      // has never seen a relay keeps producing exactly the QR it always did.
      state = { version: 1, pairingMode: 'direct', relay: null }
      try { write(state, true) } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
        state = read()
      }
    }
    fs.chmodSync(file, 0o600)
  } catch (error) {
    throw new Error(`failed to load relay state ${file}: ${error.message}`, { cause: error })
  }
  return {
    get pairingMode() { return state.pairingMode },
    get relay() { return state.relay },
    setPairingMode(mode) {
      if (!PAIRING_MODES.includes(mode)) throw new TypeError('invalid pairing mode')
      const next = { ...state, pairingMode: mode }
      write(next)
      state = next
    },
    setRelay(relay) {
      const next = { ...state, relay: relay === null ? null : { ...relay, updatedAt: Date.now() } }
      write(next)
      state = next
    },
  }
}
