# Tailscale 节点：系统优先 + 自研轻量节点兜底

网关插件不再依赖官方的 `tailscaled` 二进制。`lib/tailscale-node.mjs` 按 `tailscaleMode` 选择节点来源：

| mode | 行为 |
|---|---|
| `auto`（默认） | 检测到系统 Tailscale（本机 100.64/10 地址）就用系统节点，不启动任何进程；否则在用户配置了 Auth Key / 开启旧开关 / 显式 `embedded` 时启动自研节点 |
| `system` | 只允许系统节点；检测不到时报错并提示安装 Tailscale |
| `embedded` | 只启动自研节点（helper/tsnet-node，tsnet 1.104.5），授权用用户自己的 Auth Key 或登录链接 |
| `off` | 不做任何 Tailscale 相关动作 |

## 节点来源

- **system**：用户电脑已安装并登录 Tailscale，插件只读取网卡地址，配对入口是
  `ws://100.x.x.x:3081/ws/mobile`，账号完全归用户。
- **embedded**：电脑没有 Tailscale 时，插件 spawn `dsh-tailscale-node`（Go + tsnet），
  - 不占系统 VPN / TUN，不需要管理员权限；
  - 用户填自己的 Auth Key（`tailscaleAuthKey`）或用 `/mgw/tailscale/login` 的登录链接授权；
  - 控制平面地址可填自建 Headscale（`tailscaleControlUrl`）；
  - tailnet 监听 3081 并转发到本机网关，配对入口是 `ws://100.x.x.x:3081/ws/mobile`；
    可选 `--https-port` 走 ts.net 证书提供 `wss://<node>.<tailnet>.ts.net`。

## 插件设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `tailscaleMode` | auto | auto / system / embedded / off |
| `tailscaleEnabled` | false | 旧开关：true 时即使没填 authKey 也会启动自研节点（走登录链接） |
| `tailscaleAuthKey` | 空 | 用户自己的 `tskey-auth-…` |
| `tailscaleHostname` | dsh-gateway | 节点名 |
| `tailscaleServePort` | 3081 | tailnet 监听端口 |
| `tailscaleControlUrl` | 官方 | 自建 Headscale 填自己的域名 |
| `tailscaleHelperPath` | 空 | 覆盖 helper 二进制路径（默认按平台目录查找） |

## 状态

`/mgw/status` 的 `tailscale` 字段包含 `nodeSource`（system / embedded / none）与 `serve`
快照（state、loginUrl、dnsName、ipv4、urls、error）。`GET /mgw/tailscale` 返回同一快照，
`GET /mgw/tailscale/login` 302 到登录链接。
