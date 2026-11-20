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
			listener, err := srv.ListenTLS("tcp", fmt.Sprintf(":%d", *httpsPort))
			if err != nil {
				httpsErr.Store(err.Error())
				logf("ts.net ListenTLS :%d failed: %v", *httpsPort, err)
				return
			}
			logf("ts.net TLS listener ready on :%d -> %s", *httpsPort, target)
			go serveListener(listener, target)
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

func main() {
	flag.Parse()
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
