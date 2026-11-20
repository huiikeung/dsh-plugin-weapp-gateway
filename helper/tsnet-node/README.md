# dsh-tailscale-node

网关插件的轻量 Tailscale 节点（Go + tailscale.com/tsnet 1.104.5）。
用于「用户电脑没有安装 Tailscale」时的兜底：把网关加入用户自己的 tailnet，
再把 tailnet 上 :3081 的连接转发到本机 127.0.0.1:3081。

- 不依赖系统 tailscaled、不占系统 VPN/TUN、不需要管理员权限
- 授权归用户：`--auth-key`（用户自己生成）或不断刷新的 `loginUrl` 浏览器登录
- 控制平面可自定义（`--control-url`，支持自建 Headscale）
- 状态写入 `<state-dir>/embedded-node.json`，插件每 1.5s 轮询

## 构建

```bash
# 需要官方 Go（非 OpenHarmony 工具链）
GO_BIN=/path/to/go/bin/go bash build.sh                 # 当前平台
TARGETS="windows-amd64 darwin-arm64 linux-amd64" bash build.sh
```

产物在 `bin/<goos>-<goarch>/dsh-tailscale-node[.exe]`，插件按
`helper/tsnet-node/bin/<platform>-<arch>/` 自动查找，也可用插件设置
`tailscaleHelperPath` 或环境变量 `DSH_TSNET_HELPER` 指定。

## 参数

| 参数 | 说明 |
|---|---|
| `--state-dir` | tsnet 状态目录（必填，插件传 `~/.dsh/tailscale`） |
| `--hostname` | 节点名，默认 `dsh-gateway` |
| `--control-url` | 控制平面，默认官方；自建 Headscale 填自己的域名 |
| `--auth-key` | 用户自己的 Auth Key；留空则写登录链接 |
| `--listen-port` | tailnet 监听端口，默认 3081 |
| `--target-port` | 本机转发目标端口，默认同 listen-port |
| `--https-port` | 可选：ts.net HTTPS（wss）监听端口，0 关闭 |
| `--status-file` | 状态文件，默认 `<state-dir>/embedded-node.json` |
