#!/bin/bash
# 构建 dsh-tailscale-node（网关插件内嵌轻量节点）。
# 需要官方 Go（非 ohos 工具链）：默认 D:/Other/P-Program/_ts-build/go1.27.3/go，可用 GO_BIN 覆盖。
# 产物：helper/tsnet-node/bin/<goos>-<goarch>/dsh-tailscale-node[.exe]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
go_bin="${GO_BIN:-D:/Other/P-Program/_ts-build/go1.27.3/go/bin/go.exe}"
[[ -x "$go_bin" ]] || { echo "Go toolchain not found: $go_bin (set GO_BIN)" >&2; exit 1; }
targets="${TARGETS:-windows-amd64}"
export CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=mod
for target in $targets; do
  goos="${target%-*}"; goarch="${target#*-}"
  out="bin/${goos}-${goarch}"
  mkdir -p "$out"
  name="dsh-tailscale-node"; [[ "$goos" == "windows" ]] && name="$name.exe"
  echo "building $goos/$goarch ..."
  GOOS="$goos" GOARCH="$goarch" "$go_bin" build -trimpath -buildvcs=false -ldflags="-s -w" -o "$out/$name" .
  ls -lh "$out/$name"
done
