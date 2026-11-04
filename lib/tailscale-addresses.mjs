// Tailscale 地址识别：100.64.0.0/10（CGNAT，Tailscale 使用其中 100.64–100.127）
// 与 fd7a:115c:a1e0::/48（Tailscale IPv6）。
//
// 只检查本网关进程所在网络命名空间的接口，绝不推断手机 IP；检测到接口地址
// 也不等于已登录 tailnet 或手机可达。取自上游 mobile-gateway（v0.11.2）。
import os from 'node:os'
import { isIP } from 'node:net'

export function isTailscaleIp(value) {
  if (typeof value !== 'string') return false
  const address = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
  }
  return isIP(address) === 6 && address.startsWith('fd7a:115c:a1e0:')
}

// 只读取本机接口；返回 Tailscale 地址列表与可用（已监听且绑定地址匹配）的 WS URL。
export function tailscaleInterfaceStatus({ listening, host, port, wsPath }, interfaces = os.networkInterfaces()) {
  const addresses = []
  for (const [name, records] of Object.entries(interfaces)) {
    const entries = (records || []).filter((record) => record && !record.internal)
    const knownInterface = /^(tailscale|utun|tun\d)/i.test(name)
      || entries.some((record) => isIP(record.address) === 6 && isTailscaleIp(record.address))
    if (!knownInterface) continue
    for (const record of entries) {
      if (isTailscaleIp(record.address) && !addresses.includes(record.address)) addresses.push(record.address)
    }
  }
  addresses.sort((a, b) => isIP(a) - isIP(b))
  const boundHost = (host || '').replace(/^\[|\]$/g, '')
  const urls = listening ? addresses.filter((address) =>
    boundHost === '::' || boundHost === address || (boundHost === '0.0.0.0' && isIP(address) === 4))
    .map((address) => `ws://${isIP(address) === 6 ? `[${address}]` : address}:${port}${wsPath}`) : []
  return { addresses, urls }
}
