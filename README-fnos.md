# FnOS 上配置 dsh-plugin-weapp-gateway（手机连接）

本机环境（已实测，2026-09-11）：

| 项 | 实测值 |
|---|---|
| FnOS 部署 | `access_mode: fngateway`，DSH web 只监听 `127.0.0.1:2298`，启动器另开 `*:2299` |
| 局域网 IP | `192.168.3.110`（唯一物理口 `bond1-ovs`，无其它物理 IPv4） |
| FnOS 防火墙 | `fw.conf` 里 `enable: false`，iptables INPUT 全 ACCEPT → 3081 不会被挡 |
| FnOS 域名 | `*.mmhhhlb.fnos.net`（走 FN Connect 中继，见下文「外网」） |
| 反代/DDNS 组件 | 本机已装 **Lucky**（`lucky_reverseproxy.lkcf`、`lucky_ddns.lkcf`） |
| 插件版本 | npm `dsh-plugin-weapp-gateway@0.7.3` |

---

## 0. 一句话结论

- **局域网：装完即用，地址自动探测**，会广播 `ws://192.168.3.110:3081/ws/mobile`。
- **外网：不要走 `*.fnos.net`**（实测是门户中继，需要 FnOS 登录 token，手机 WS 握不了手），
  要用**你自己的域名**做一层反代/隧道，然后写一行配置让插件自动广播 `wss://你的域名/ws/mobile`。
- **安卓客户端要另配**：这个插件的官方客户端是 **iOS**。

---

## 1. 安装插件

```bash
dsh plugin --profile web add dsh-plugin-weapp-gateway@latest
# 装完必须完整重启，否则侧边栏不出现「移动设备」
dsh web
```

> **本机已安装完成**，实际可用的 `dsh` CLI 在：
> `/vol1/@appdata/deepseek.harness/dsh-runtime/node_modules/.bin/dsh`
>
> ⚠️ 本机 pnpm 开了 `minimumReleaseAge` 供应链策略，profile 里已有 6 个包处于 24h 等待期内，
> 直接 `add` 会报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 而**静默失败**（退出码仍是 0，要看完整输出）。
> 可用的绕过方式：
> ```bash
> dsh plugin --profile web add dsh-plugin-weapp-gateway@latest --config.minimum-release-age=0
> ```

`dsh web` 由 FnOS 应用中心托管时，用应用面板的「重启」；直接重启进程会导致当前会话所在的 Web 服务中断。

> ⚠️ **不要执行** `npx dsh-plugin-weapp-gateway@latest init` / `setup`。
> 那条流程是给「带固定公网 IPv4 的 Ubuntu/Debian 服务器」准备的：它会 `apt-get install nginx python3` +
> 用 certbot 给公网 IP 签证书 + 装 systemd helper。FnOS 自带 nginx 已占用 80/443/5666/5667，
> 会直接冲突，且 helper 的 `ProtectSystem=full`、`/etc/nginx` 路径假设也与 FnOS 不同。

插件 bundle 自带的 `cordis.patch.yml` 默认就是：

```yaml
lanEnabled: true
lanHost: 0.0.0.0
lanPort: 3081
publicUrlFile: /etc/dsh-mobile-gateway/public-url
requireAuth: true
adminLoopbackOnly: true
```

所以**局域网部分不需要改配置**，插件的 `privateLanAddresses()` 会自动枚举物理网卡并广播地址
（虚拟口 `docker*/br-*/veth*/tailscale*/wg*` 被排除，因此不会被 172.x 的 docker 网桥带偏）。

---

## 2. 局域网配对（手机同一 Wi-Fi）

1. **必须用回环地址打开面板**：`http://127.0.0.1:2298/`
   （源码 `/mgw` 管理路由默认 `adminLoopbackOnly: true`，从 NAS IP/域名打开面板会 403，
    这和你之前遇到的插件设置页 RPC 降级是同一类「非 loopback 来源」问题）
   - 人在远程时先开隧道：`ssh -N -L 2298:127.0.0.1:2298 <用户>@192.168.3.110`
2. 左侧栏 →「移动设备」→ 打开「允许移动设备连接」，保持「设备鉴权」开启
3. 面板会显示 `ws://192.168.3.110:3081/ws/mobile`（自动探测结果）
4. 填设备名称 →「生成配对二维码」→ 手机端扫码
5. 「可信设备」显示**在线**即成功

二维码一次性、5 分钟过期。

---

## 3. 外网（关键：fnOS 域名为什么不行）

### ✅ 本机已完成的配置（实测确认）

| 环节 | 状态 |
|---|---|
| 插件安装 | `dsh-plugin-weapp-gateway@0.7.3` 已装入 `web` profile，已列入 `dsh.profile.bundles` |
| 外网地址文件 | `/etc/dsh-mobile-gateway/public-url` → `wss://mdsh.zo1.top:16662/ws/mobile` |
| Lucky 反代 | `mdsh.zo1.top:16662` 全部路径 → `192.168.3.110:3081`（探针实测命中，且来源是私网地址，可通过插件的私网校验） |
| TLS 证书 | `*.zo1.top`，Let's Encrypt 签发，公网可信（安卓/iOS 都会接受） |
| 待办 | **重启 `dsh web`**，然后到 `http://127.0.0.1:2298/` 面板开启网关并配对 |

探针原始证据（在 3081 临时起监听，从外部域名请求）：

```
GET /probe-local  Host=127.0.0.1:3081        Remote=('127.0.0.1', 53420)
GET /ws/mobile    Host=mdsh.zo1.top:16662    Remote=('192.168.3.110', 56902)   ← 经 Lucky 命中
GET /             Host=mdsh.zo1.top:16662    Remote=('192.168.3.110', 56918)
```

### 实测证据：为什么不能用 fnOS 自己的域名

```
$ getent hosts mmhhhlb.fnos.net
101.69.221.122                      # FN Connect 中继，不是本机公网出口(82.47.34.108)

$ curl -skI https://mmhhhlb.fnos.net/app/deepseek-harness/fngateway/
HTTP/2 302
location: https://fnos.net/mmhhhlb/app/deepseek-harness/fngateway/   # 跳门户登录

$ curl -sI http://127.0.0.1:5666/app/deepseek-harness/fngateway/
HTTP/1.1 200
invalid token                        # 网关自己的应用 token 校验
```

→ `*.fnos.net` 是 FnOS 门户/中继链路，连接要带 FnOS 会话与应用 token；
手机客户端做的是裸 WebSocket 握手（插件还默认 `allowQueryToken: false`），拿不到这套凭据。
**所以「外网自动用 fnOS 域名连」这条在 FnOS 上不成立。**

### 可行的替代：用你自己的域名

插件只要求 `/etc/dsh-mobile-gateway/public-url` 里有**一行 wss:// 地址**，就会自动广播它
（源码 `configuredPublicUrl()` + `advertisedEndpoints()`）。所以只要你在外面有一层能
**终止 TLS 并把 `/ws/mobile` 转发到本机**的反代/隧道，就能实现「外网自动用域名连」。

三种做法，配置样例见 `reverse-proxy-ws.conf.example`：

| 方案 | 适合 | 后端目标 |
|---|---|---|
| **Lucky 反代**（本机已装） | 有自己的域名 + DDNS | `127.0.0.1:3081`（记得开 WebSocket/长连接） |
| **FnOS 自带 nginx** | 已有可信证书 | `127.0.0.1:3081`，只加一个 `location = /ws/mobile` |
| **Tunnel**（cloudflared / `tailscale serve`） | 无公网 IP、临时或长期 | 转发到 `127.0.0.1:3081` |

⚠️ 唯一注意：**Tailscale 直连 `http://100.x.x.x:3081` 会被插件 403**，
因为 `isPrivateNetworkHostname()` 的白名单只有 `10/8、172.16/12、192.168/16、169.254/16、localhost、.local、fc00::/7`，
**不含 `100.64.0.0/10`（CGNAT）**。必须用 `tailscale serve`（从回环发起）。

### 写入外网地址

```bash
# 自动探测本机局域网 IP + 校验，并写入外网地址
sudo bash fnos-mobile-gateway.sh apply --domain d.example.com

# 只探测/自检，不改任何东西
bash fnos-mobile-gateway.sh probe
bash fnos-mobile-gateway.sh check

# 只保留局域网
sudo bash fnos-mobile-gateway.sh apply --lan-only
```

写完 `/etc/dsh-mobile-gateway/public-url` 后**重启 `dsh web`**，面板里就会出现这条 wss 地址，
生成二维码时手机端拿到的就是外网地址。

### 重启后的验收（三条命令）

```bash
# 1. 3081 是否起来了（插件加载成功）
ss -lnt | grep 3081

# 2. 本机路由是否生效：应返回 401（需要设备鉴权）或 503（网关未开）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2298/ws/mobile

# 3. 外网链路是否通：同样应返回 401/503，而不是 502/404
curl -sk -o /dev/null -w '%{http_code}\n' https://mdsh.zo1.top:16662/ws/mobile
```

三条都对上以后，去 `http://127.0.0.1:2298/` 打开「移动设备」→ 开启「允许移动设备连接」→ 生成二维码。

---

## 4. 安卓客户端

插件本身与客户端无关（`PROTOCOL.md` 是公开协议），但这个仓库的配套客户端
[`dsh-mobile`](https://github.com/Clarklevis1995/dsh-mobile) 是 **iOS 17+ SwiftUI**，
**没有安卓端**。安卓有这些第三方选择，注意第 2、3 类**根本不走本插件**：

| 项目 | 走本插件？ | 说明 |
|---|---|---|
| [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 否（自有插件） | 安卓 App + 浏览器，自带局域网/隧道方案 |
| [SparkWeiyang/DeepseekHarness-AndroidClient](https://github.com/SparkWeiyang/DeepseekHarness-AndroidClient) | ❌ | 直连 DSH web 的 `POST /api/` + `/api/events.mux`，自带局域网 /24 扫描 |
| [daetz-coder/DSH-Mobile](https://github.com/daetz-coder/DSH-Mobile) | ❌ | 扫码配对 + 通知，加载官方 Web UI 页面 |
| [sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile) | ❌ | Kotlin/Compose，Wi-Fi 主动扫描 + 手动 host:port |

**所以先确认你要用哪个安卓客户端**：如果它不走 `/ws/mobile`，那装这个插件对你没意义，
直接用客户端自己的连接方式即可；只有客户端实现了 `dsh-mobile-v1` 协议时，本插件的网关才有用。

---

## 5. 排查

| 现象 | 处理 |
|---|---|
| 侧边栏没有「移动设备」 | 插件必须装在 `web` profile，且要**完整重启** `dsh web` |
| 面板打不开/403 | 必须用 `http://127.0.0.1:2298/`（`/mgw` 默认只允许回环），远程走 SSH 隧道 |
| 手机 503 | 面板里打开「允许移动设备连接」 |
| 手机 401 | 二维码过期/被用过，重新生成配对 |
| 手机连的是 `127.0.0.1` | 面板里手填 `ws://192.168.3.110:3081/ws/mobile` |
| 外网连不上 | 检查反代是否透传了 `Upgrade`/`Connection` 头、是否限定了 `/ws/mobile` 路径 |
| 服务端日志 | `tail -f /tmp/mobile-gateway.log` |

---

## 6. 本目录文件

| 文件 | 用途 |
|---|---|
| `fnos-mobile-gateway.sh` | FnOS 适配：局域网 IP 自动探测、外网地址写入、连通性自检 |
| `reverse-proxy-ws.conf.example` | Lucky / FnOS nginx / Tunnel 三种反代样例 |
| `README-fnos.md` | 本文档 |
