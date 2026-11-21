// dsh-tailscale-node: 网关插件用的轻量 Tailscale 节点。
//
// 设计目标：不依赖系统安装的 Tailscale、不占用系统 VPN / TUN、不需要管理员权限。
// 它用 tailscale.com/tsnet 把本进程加入用户自己的 tailnet，然后在 tailnet 上监听
// 网关端口，把连接转发到本机 127.0.0.1 上的真实网关；可选再用 tsnet 的证书能力
// 提供 wss://<节点>.<tailnet>.ts.net 入口。
//
// 插件通过 -status-file 轮询状态；授权方式与手机端一致：用户自己的 Auth Key，
// 或不断刷新的 login URL 走浏览器登录。控制平面地址可自定义（自建 Headscale）。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const schemaVersion = 1

type statusFile struct {
	Schema     int    `json:"schema"`
	State      string `json:"state"` // starting | needs-login | running | failed | stopped
	AuthMode   string `json:"authMode"` // authkey | login
	Error      string `json:"error"`
	LoginURL   string `json:"loginUrl"`
	DNSName    string `json:"dnsName"`
	IPv4       string `json:"ipv4"`
	ListenPort int    `json:"listenPort"`
	HTTPSPort  int    `json:"httpsPort"`
	HTTPSUrl   string `json:"httpsUrl"`
	HTTPSError string `json:"httpsError,omitempty"`
	Hostname   string `json:"hostname"`
	ControlURL string `json:"controlUrl"`
	UpdatedAt  int64  `json:"updatedAt"`
}

var (
	stateDir    = flag.String("state-dir", "", "tsnet 状态目录（必填，插件传 ~/.dsh/tailscale）")
	hostname    = flag.String("hostname", "dsh-gateway", "节点名（tailscale hostname）")
	controlURL  = flag.String("control-url", "https://controlplane.tailscale.com", "控制平面地址（自建 Headscale 填自己的域名）")
	authKey     = flag.String("auth-key", "", "用户自己的 Tailscale Auth Key；留空则输出登录链接")
	listenPort  = flag.Int("listen-port", 3081, "tailnet 监听端口")
	targetPort  = flag.Int("target-port", 0, "转发目标端口，0 表示与 listen-port 相同（本机 127.0.0.1）")
	httpsPort   = flag.Int("https-port", 0, "可选：ts.net HTTPS 监听端口（wss 入口），0 关闭")
	statusPath  = flag.String("status-file", "", "状态文件路径，默认 <state-dir>/embedded-node.json")
	proxyAddr   = flag.String("proxy", "", "HTTP/SOCKS5 proxy for control plane (empty = auto detect)")
	proxyAutoFlag = flag.Bool("proxy-auto", true, "auto detect local proxy ports when --proxy is empty")
	verbose     = flag.Bool("verbose", false, "输出 tsnet 详细日志")
	statusMu    sync.Mutex
	current     = statusFile{Schema: schemaVersion, State: "starting"}
	listenOnce  sync.Once
	httpsOnce   sync.Once
	listenErr   atomic.Value // string
	httpsErr    atomic.Value // string
	localTarget int
)

func logf(format string, args ...any) { log.Printf(format, args...) }

func writeStatus() {
	if *statusPath == "" {
		return
	}
	statusMu.Lock()
	current.UpdatedAt = time.Now().UnixMilli()
	payload, err := json.MarshalIndent(current, "", "  ")
	statusMu.Unlock()
	if err != nil {
		logf("marshal status: %v", err)
		return
	}
	tmp := *statusPath + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		logf("write status: %v", err)
		return
	}
	if err := os.Rename(tmp, *statusPath); err != nil {
		logf("rename status: %v", err)
	}
}

func setState(state, errText string) {
	statusMu.Lock()
	current.State = state
	current.Error = errText
	statusMu.Unlock()
	writeStatus()
}

func setLoginURL(url string) {
	statusMu.Lock()
	if current.LoginURL != url {
		current.LoginURL = url
	}
	statusMu.Unlock()
	writeStatus()
}

func setNetwork(dnsName, ipv4 string) {
	statusMu.Lock()
	current.DNSName = dnsName
	current.IPv4 = ipv4
	statusMu.Unlock()
	writeStatus()
}

func proxyConn(client net.Conn, targetAddr string) {
	defer client.Close()
	server, err := net.DialTimeout("tcp", targetAddr, 10*time.Second)
	if err != nil {
		logf("dial target %s: %v", targetAddr, err)
		return
	}
	defer server.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(server, client)
		if tcp, ok := server.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(client, server)
	if tcp, ok := client.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	<-done
}

func serveListener(listener net.Listener, targetAddr string) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			logf("accept: %v", err)
			return
		}
		go proxyConn(conn, targetAddr)
	}
}

func startListeners(srv *tsnet.Server) {
	target := fmt.Sprintf("127.0.0.1:%d", localTarget)
	listenOnce.Do(func() {
		listener, err := srv.Listen("tcp", fmt.Sprintf(":%d", *listenPort))
		if err != nil {
			listenErr.Store(err.Error())
			logf("tailnet listen :%d failed: %v", *listenPort, err)
			return
		}
		logf("tailnet listener ready on :%d -> %s", *listenPort, target)
		go serveListener(listener, target)
	})
	if *httpsPort > 0 {
		httpsOnce.Do(func() {
			go startTLSListener(srv, target, context.Background())
		})
	}
	statusMu.Lock()
	current.ListenPort = *listenPort
	current.HTTPSPort = *httpsPort
	if v, ok := listenErr.Load().(string); ok {
		current.Error = v
	}
	statusMu.Unlock()
	writeStatus()
}

// TLS(443) 监听：证书由 Tailscale 控制面按需签发，刚登录时可能还取不到，
// 因此失败后要重试，而不是一次性放弃（否则 httpsUrl 永远为空）。
func startTLSListener(srv *tsnet.Server, target string, ctx context.Context) {
	for attempt := 1; attempt <= 30; attempt++ {
		listener, err := srv.ListenTLS("tcp", fmt.Sprintf(":%d", *httpsPort))
		if err == nil {
			statusMu.Lock()
			current.HTTPSError = ""
			statusMu.Unlock()
			logf("ts.net TLS listener ready on :%d -> %s", *httpsPort, target)
			writeStatus()
			serveListener(listener, target)
			return
		}
		statusMu.Lock()
		current.HTTPSError = err.Error()
		statusMu.Unlock()
		writeStatus()
		logf("ts.net ListenTLS :%d failed (attempt %d/30): %v", *httpsPort, attempt, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func pollLoop(ctx context.Context, srv *tsnet.Server) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		client, err := srv.LocalClient()
		if err != nil {
			continue
		}
		status, err := client.Status(ctx)
		if err != nil {
			continue
		}
		backendState := string(status.BackendState)
		loginURL := status.AuthURL
		dnsName := ""
		ipv4 := ""
		if status.Self != nil {
			dnsName = strings.TrimSuffix(status.Self.DNSName, ".")
		}
		for _, addr := range status.TailscaleIPs {
			if addr.Is4() {
				ipv4 = addr.String()
				break
			}
		}
		switch backendState {
		case "Running":
			setNetwork(dnsName, ipv4)
			statusMu.Lock()
			ok := current.State != "running"
			statusMu.Unlock()
			if ok {
				statusMu.Lock()
				current.Error = ""
				statusMu.Unlock()
				writeStatus()
			}
			setState("running", "")
			if dnsName != "" {
				startListeners(srv)
			}
		case "NeedsLogin":
			if loginURL != "" {
				setLoginURL(loginURL)
			}
			setState("needs-login", "")
		case "Stopped":
			setState("stopped", "")
		default:
			setState("starting", "")
		}
	}
}

// ---------- 本机代理自动探测 ----------
// tsnet 的控制面/DERP 连接不读系统代理，fake-ip 代理环境下必须显式给 HTTP(S)_PROXY。
// 不同代理软件的端口不一样（Clash 7897/7890、V2Ray 1080/10808、Surge 6152…），
// 这里按常见端口逐个探测，谁能代理到控制面就用谁。

var proxyPorts = []int{
	7897, 7890, 7891, 7892, 7893, 7899,
	1080, 1081, 1087, 10808, 10809, 10810,
	6152, 6153, 8118, 8080, 8081, 8888, 8889,
	20171, 20172, 20170, 9090,
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func probeHTTPProxy(port int) bool {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(1500 * time.Millisecond))
	req := "CONNECT controlplane.tailscale.com:443 HTTP/1.1\r\nHost: controlplane.tailscale.com:443\r\nProxy-Connection: keep-alive\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		return false
	}
	buf := make([]byte, 96)
	n, err := conn.Read(buf)
	if err != nil || n <= 0 {
		return false
	}
	head := string(buf[:n])
	return strings.HasPrefix(head, "HTTP/1.") && strings.Contains(head, " 200")
}

func probeSOCKS5(port int) bool {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(1200 * time.Millisecond))
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return false
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return false
	}
	return buf[0] == 0x05 && buf[1] == 0x00
}

func detectProxy() string {
	for _, port := range proxyPorts {
		if probeHTTPProxy(port) {
			return fmt.Sprintf("http://127.0.0.1:%d", port)
		}
	}
	for _, port := range proxyPorts {
		if probeSOCKS5(port) {
			return fmt.Sprintf("socks5://127.0.0.1:%d", port)
		}
	}
	return ""
}

func applyProxyEnv(proxy string) {
	if proxy == "" {
		return
	}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"} {
		_ = os.Setenv(key, proxy)
	}
	logf("proxy: using %s", proxy)
}

func main() {
	flag.Parse()
	// 显式代理优先；否则自动探测常见端口（也可以用 HTTPS_PROXY 环境变量覆盖）。
	explicitProxy := firstNonEmpty(*proxyAddr, os.Getenv("HTTPS_PROXY"), os.Getenv("https_proxy"), os.Getenv("ALL_PROXY"), os.Getenv("all_proxy"))
	if explicitProxy != "" {
		applyProxyEnv(explicitProxy)
	} else if *proxyAutoFlag {
		applyProxyEnv(detectProxy())
	}
	if *stateDir == "" {
		logf("-state-dir is required")
		os.Exit(2)
	}
	if *statusPath == "" {
		*statusPath = filepath.Join(*stateDir, "embedded-node.json")
	}
	localTarget = *listenPort
	if *targetPort > 0 {
		localTarget = *targetPort
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		logf("mkdir state dir: %v", err)
		os.Exit(2)
	}
	authMode := "login"
	if strings.TrimSpace(*authKey) != "" {
		authMode = "authkey"
	}
	statusMu.Lock()
	current.AuthMode = authMode
	current.Hostname = *hostname
	current.ControlURL = *controlURL
	current.ListenPort = *listenPort
	current.HTTPSPort = *httpsPort
	statusMu.Unlock()
	writeStatus()

	srv := &tsnet.Server{
		Dir:        *stateDir,
		Hostname:   *hostname,
		ControlURL: *controlURL,
		AuthKey:    strings.TrimSpace(*authKey),
	}
	if *verbose {
		srv.Logf = logf
	}
	srv.UserLogf = func(format string, args ...any) {
		message := fmt.Sprintf(format, args...)
		logf("tsnet: %s", message)
		if index := strings.Index(message, "https://login.tailscale.com/"); index >= 0 {
			tail := message[index:]
			if end := strings.IndexAny(tail, " \n\t"); end > 0 {
				tail = tail[:end]
			}
			setLoginURL(tail)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		cancel()
		setState("stopped", "")
		_ = srv.Close()
		os.Exit(0)
	}()

	logf("starting tsnet node hostname=%s control=%s authMode=%s stateDir=%s", *hostname, *controlURL, authMode, *stateDir)
	// Up() 会阻塞到 Running（未登录时会一直等），因此放到后台；状态完全由 pollLoop 维护，
	// 这样 needs-login / 登录链接能在几秒内写进状态文件。
	go func() {
		upCtx, upCancel := context.WithTimeout(ctx, 10*time.Minute)
		defer upCancel()
		_, upErr := srv.Up(upCtx)
		if upErr != nil && ctx.Err() == nil {
			logf("tsnet Up returned: %v", upErr)
		}
	}()
	go pollLoop(ctx, srv)

	// 保持进程存活，状态由 pollLoop 维护
	select {
	case <-ctx.Done():
	case <-time.After(24 * time.Hour):
	}
	_ = srv.Close()
}
