// Tailscale 地址识别与接口状态：100.64/10 与 fd7a:115c:a1e0::/48。
// 该能力让同一 tailnet 的手机可以直接连 ws://100.x 的局域网监听，
// 不再必须 tailscale serve。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTailscaleIp, tailscaleInterfaceStatus } from '../lib/tailscale-addresses.mjs'

test('isTailscaleIp accepts the CGNAT range and Tailscale IPv6 only', () => {
  for (const address of ['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1']) {
    assert.equal(isTailscaleIp(address), true, address)
  }
  for (const address of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.1.2', '::1', '2001:db8::1', '', undefined, 42]) {
    assert.equal(isTailscaleIp(address), false, String(address))
  }
})

test('tailscaleInterfaceStatus only reports Tailscale interfaces and bound URLs', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.3.10', internal: false }],
    utun4: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.64.0.9', internal: false }],
  }
  const boundAny = tailscaleInterfaceStatus({ listening: true, host: '0.0.0.0', port: 3081, wsPath: '/ws/mobile' }, interfaces)
  assert.deepEqual([...boundAny.addresses].sort(), ['100.101.102.103', '100.64.0.9'])
  assert.deepEqual([...boundAny.urls].sort(), ['ws://100.101.102.103:3081/ws/mobile', 'ws://100.64.0.9:3081/ws/mobile'])

  // 监听关掉时没有可用 URL；绑定到具体地址时只给该地址的 URL。
  assert.deepEqual(tailscaleInterfaceStatus({ listening: false, host: '0.0.0.0', port: 3081, wsPath: '/ws/mobile' }, interfaces).urls, [])
  const boundOne = tailscaleInterfaceStatus({ listening: true, host: '100.101.102.103', port: 4000, wsPath: '/ws/mobile' }, interfaces)
  assert.deepEqual(boundOne.urls, ['ws://100.101.102.103:4000/ws/mobile'])

  // 没有 Tailscale 接口时不编造地址。
  assert.deepEqual(tailscaleInterfaceStatus({ listening: true, host: '0.0.0.0', port: 3081, wsPath: '/ws/mobile' }, {
    en0: [{ family: 'IPv4', address: '192.168.3.10', internal: false }],
  }), { addresses: [], urls: [] })
})

test('IPv6 Tailscale interfaces are bracketed in URLs', () => {
  const status = tailscaleInterfaceStatus({ listening: true, host: '::', port: 3081, wsPath: '/ws/mobile' }, {
    tailscale0: [{ family: 'IPv6', address: 'fd7a:115c:a1e0::42', internal: false }],
  })
  assert.deepEqual(status.urls, ['ws://[fd7a:115c:a1e0::42]:3081/ws/mobile'])
})
