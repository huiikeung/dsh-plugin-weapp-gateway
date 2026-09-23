#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# fnOS 适配脚本：dsh-plugin-mobile-gateway
#
# 作用：
#   1. 自动探测本机局域网 IP（物理网卡优先，忽略 docker/br-/veth 等虚拟口）
#   2. 自动/手动确定外网域名，按插件要求写入 /etc/dsh-mobile-gateway/public-url
#   3. 校验 3081（局域网入口）与 /ws/mobile 是否真的可达
#   4. 打印可直接给手机用的两条地址
#
# 明确不做的事（FnOS 上做了会坏系统）：
#   * 不执行 `dsh-plugin-mobile-gateway init` / `setup`
#     （那个流程会 apt 安装 nginx+certbot 并按固定公网 IPv4 签证书，
#      会与 FnOS 自带 nginx 的 80/443/5666/5667 冲突）
#
# 用法：
#   bash fnos-mobile-gateway.sh probe                  # 只探测并打印地址
#   bash fnos-mobile-gateway.sh apply --domain d.example.com
#   bash fnos-mobile-gateway.sh apply --domain d.example.com --path /ws/mobile
#   bash fnos-mobile-gateway.sh apply --lan-only       # 只用局域网
#   bash fnos-mobile-gateway.sh check                  # 连通性自检
#   bash fnos-mobile-gateway.sh clear                  # 清除外网地址
# ---------------------------------------------------------------------------
set -euo pipefail

PUBLIC_URL_FILE="${PUBLIC_URL_FILE:-/etc/dsh-mobile-gateway/public-url}"
WS_PATH="${WS_PATH:-/ws/mobile}"
LAN_PORT="${LAN_PORT:-3081}"
DSH_PORT="${DSH_PORT:-2298}"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# --------------------------------------------------------------------------
# 1. 局域网 IP 自动探测：与插件 privateLanAddresses() 的取向保持一致
#    物理网卡优先（排除 docker/br-/veth/utun/tailscale/wg 等虚拟口），
#    并在多个物理口时优先选择默认路由所在的口。
# --------------------------------------------------------------------------
is_private_v4() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|169.254.*) return 0 ;;
    *) return 1 ;;
  esac
}

is_virtual_iface() {
  case "$1" in
    lo|docker*|br-*|veth*|utun*|awdl*|llw*|vmnet*|vbox*|virbr*|tailscale*|wg*|tun) return 0 ;;
    *) return 1 ;;
  esac
}

detect_lan_ips() {
  local primary="" candidates=""
  # 默认路由出口 IP：本机跑着 mihomo TUN，ip route get 会返回 198.18.0.1，
  # 因此只有「本身属于私有网段且不在虚拟口上」才采信。
  primary="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true

  local iface addr
  while read -r iface addr; do
    [ -z "${iface:-}" ] && continue
    is_virtual_iface "$iface" && continue
    is_private_v4 "$addr" || continue
    candidates="${candidates}${candidates:+$'\n'}${iface} ${addr}"
  done < <(ip -4 -o addr show 2>/dev/null | awk '{print $2, $4}' | sed 's#/.*##')

  [ -z "$candidates" ] && return 0
  if [ -n "$primary" ] && is_private_v4 "$primary" && \
     printf '%s\n' "$candidates" | awk -v p="$primary" '$2==p{f=1} END{exit !f}'; then
    printf '%s\n' "$primary"
  fi
  printf '%s\n' "$candidates" | awk -v p="$primary" '$2!=p {print $2}'
}

first_lan_ip() {
  local ip
  while read -r ip; do
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
  done < <(detect_lan_ips)
  return 0
}

# --------------------------------------------------------------------------
# 2. 外网域名：优先命令行，其次读 FnOS 已知域名，最后留空
#    注意：*.fnos.net 域名经实测走 Fn Connect 门户中继（302 → fnos.net 门户登录），
#    不能作为手机 WS 直连端点；这里只把它作为“提示”，不会自动采用。
# --------------------------------------------------------------------------
detect_fnos_domains() {
  local f=/usr/trim/etc/network_cert_all.conf
  [ -f "$f" ] || return 0
  grep -oE '\*?\.[A-Za-z0-9._-]*fnos\.net' "$f" 2>/dev/null | sed 's/^\*\.//' | awk '!seen[$0]++' || true
  grep -oE '"domain"[^,]*' "$f" 2>/dev/null | grep -oE '[A-Za-z0-9._-]+\.[A-Za-z]{2,}' | awk '!seen[$0]++' || true
}

current_public_url() {
  [ -f "$PUBLIC_URL_FILE" ] || return 0
  awk 'NF && $0 !~ /^#/ {print; exit}' "$PUBLIC_URL_FILE" 2>/dev/null || true
}

# --------------------------------------------------------------------------
probe() {
  echo "== 本机基础 =="
  echo "hostname        : $(hostname)"
  echo "DSH web         : 127.0.0.1:${DSH_PORT}（仅回环）"
  echo "插件局域网入口  : 0.0.0.0:${LAN_PORT}${WS_PATH}"
  echo

  echo "== 局域网地址（自动探测） =="
  local ips
  ips="$(detect_lan_ips || true)"
  if [ -z "$ips" ]; then
    c_err "未探测到私有网段 IPv4，请检查网络"
    return 1
  fi
  local ip
  while read -r ip; do
    [ -n "$ip" ] && echo "  ws://${ip}:${LAN_PORT}${WS_PATH}"
  done <<< "$ips"
  echo

  local cur; cur="$(current_public_url)"
  echo "== 外网地址（public-url 文件） =="
  if [ -n "$cur" ]; then
    echo "  ${cur}"
  else
    echo "  （未配置）文件：${PUBLIC_URL_FILE}"
  fi
  echo
  echo "== 提示 =="
  local d
  d="$(detect_fnos_domains | head -1)"
  if [ -n "$d" ]; then
    c_warn "本机 FnOS 域名：*.${d}"
    c_warn "实测该域名走 Fn Connect 门户中继（需 FnOS 登录 token），不能给手机当 WS 直连地址。"
    c_warn "外网请用你自己的域名（Lucky 反代 / DDNS / Tunnel），再用 --domain 写入。"
  fi
}

# --------------------------------------------------------------------------
apply() {
  local domain="" path="$WS_PATH" lan_only=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:-}"; shift 2 ;;
      --path)   path="${2:-}";   shift 2 ;;
      --lan-only) lan_only=1;    shift ;;
      *) c_err "未知参数：$1"; exit 2 ;;
    esac
  done

  [ "$(id -u)" = "0" ] || { c_err "写入 ${PUBLIC_URL_FILE} 需要 root（sudo bash $0 apply ...）"; exit 1; }

  mkdir -p "$(dirname "$PUBLIC_URL_FILE")"

  local url=""
  if [ "$lan_only" = "0" ] && [ -n "$domain" ]; then
    domain="${domain#http://}"; domain="${domain#https://}"; domain="${domain%%/*}"
    case "$domain" in
      *.fnos.net)
        c_err "拒绝使用 ${domain}：Fn Connect 门户中继需要 FnOS 登录 token，手机 WS 无法直连。"
        c_err "请改用你自己的域名（Lucky 反代 / DDNS / Tunnel 终止 TLS）。"
        exit 1 ;;
    esac
    url="wss://${domain}${path}"
  fi

  if [ -n "$url" ]; then
    {
      echo "# Managed by fnos-mobile-gateway.sh — read by dsh-plugin-mobile-gateway (publicUrlFile)"
      echo "$url"
    } > "$PUBLIC_URL_FILE"
    chmod 644 "$PUBLIC_URL_FILE"
    c_ok "已写入外网地址：${url}"
    echo "  → 重启 dsh web 后，插件的「移动设备」面板会自动广播这条 wss 地址"
  else
    if [ -f "$PUBLIC_URL_FILE" ]; then
      mv "$PUBLIC_URL_FILE" "${PUBLIC_URL_FILE}.bak"
      c_ok "已移除外网地址（备份到 ${PUBLIC_URL_FILE}.bak），仅保留局域网入口"
    else
      c_ok "未配置外网地址，仅局域网入口"
    fi
  fi

  echo
  probe
  echo
  check || true
}

# --------------------------------------------------------------------------
check() {
  echo "== 连通性自检 =="
  local ip; ip="$(first_lan_ip)"
  printf '3081 端口监听    : '
  if ss -lnt 2>/dev/null | grep -q ":${LAN_PORT} "; then
    c_ok "已监听"
  else
    c_warn "未监听 —— 插件未安装/未加载，或 lanEnabled=false（插件 bundle 默认已开启）"
  fi

  printf '2298 /ws/mobile   : '
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DSH_PORT}${WS_PATH}" 2>/dev/null || true)"
  [ -n "$code" ] || code=000
  case "$code" in
    404) c_warn "404 —— 插件未安装或未重启 dsh web（安装后应为 401/503，代表路由已存在且要求鉴权）" ;;
    401|503) c_ok "${code} 路由已生效（401=需要设备鉴权，503=网关未开启）" ;;
    000) c_warn "000 —— 2298 未响应，确认 dsh web 正在运行" ;;
    *) c_warn "${code} 请人工确认" ;;
  esac

  if [ -n "$ip" ]; then
    printf '局域网入口自测    : '
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://${ip}:${LAN_PORT}${WS_PATH}" 2>/dev/null || true)"
    [ -n "$code" ] || code=000
    case "$code" in
      401) c_ok "401 需要设备鉴权 —— 局域网入口正常" ;;
      503) c_ok "503 网关未开启 —— 在面板打开「允许移动设备连接」" ;;
      000) c_warn "000 连不上（插件未加载 / 未开放 3081）" ;;
      *) c_warn "${code}" ;;
    esac
  fi

  echo
  echo "== 面板入口（必须走回环，否则 /mgw 会 403） =="
  echo "  http://127.0.0.1:${DSH_PORT}/   → 左侧「移动设备」"
  echo "  远程操作时用 SSH 隧道：ssh -N -L ${DSH_PORT}:127.0.0.1:${DSH_PORT} <用户>@<NAS地址>"
}

clear_all() {
  [ "$(id -u)" = "0" ] || { c_err "需要 root"; exit 1; }
  [ -f "$PUBLIC_URL_FILE" ] && mv "$PUBLIC_URL_FILE" "${PUBLIC_URL_FILE}.bak" && c_ok "已清除外网地址（备份保留）"
}

case "${1:-probe}" in
  probe) probe ;;
  apply) shift; apply "$@" ;;
  check) check ;;
  clear) clear_all ;;
  *) sed -n '2,25p' "$0" ;;
esac
