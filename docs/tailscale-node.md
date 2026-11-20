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

## 用户授权的两种方式（与手机端一致）

1. **浏览器登录（推荐给普通用户）**
   面板 Tailscale 区域点「启动隧道」→ 插件在无系统 Tailscale 时自动 spawn 内嵌节点 →
   约 10–20 秒后状态变为「内嵌隧道需要授权」，出现「去授权」按钮 →
   浏览器打开登录链接完成授权（`GET /mgw/tailscale/login` 302 到该链接）。
   授权后节点自动 Running，地址 `ws://100.x:3081/ws/mobile` 自动填入。
2. **Auth Key（免浏览器、可无人值守）**
   在插件设置里填用户自己在 `login.tailscale.com/admin/settings/keys` 生成的
   `tskey-auth-…`（`tailscaleAuthKey`），再点「启动隧道」，内嵌节点会带 key 直接加入 tailnet。

两种方式都只使用**用户自己**的 Tailscale 账号；插件不内置任何共享节点或凭据。
已有登录态（`~/.dsh/tailscale/tailscaled.state`）时，DSH 重启后 `auto` 模式会自动恢复内嵌节点。

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
