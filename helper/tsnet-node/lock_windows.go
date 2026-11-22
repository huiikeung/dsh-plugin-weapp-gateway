//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// acquireInstanceLock（Windows）：用 PID 文件做单实例判断。
func acquireInstanceLock(stateDir string) (func(), error) {
	lockPath := filepath.Join(stateDir, "helper.lock")
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.WriteString(fmt.Sprintf("%d\n", os.Getpid()))
			_ = f.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		data, readErr := os.ReadFile(lockPath)
		if readErr != nil {
			return nil, err
		}
		pidText := strings.TrimSpace(string(data))
		if pid, perr := os.FindProcess(atoiSafe(pidText)); perr == nil && pid != nil {
			if pid.Signal(os.Signal(nil)) == nil {
				return nil, fmt.Errorf("another dsh-tailscale-node is already running (pid %s) for %s", pidText, stateDir)
			}
		}
		_ = os.Remove(lockPath)
	}
	return nil, fmt.Errorf("could not acquire instance lock in %s", stateDir)
}

func atoiSafe(text string) int {
	value := 0
	for _, ch := range text {
		if ch < '0' || ch > '9' {
			return value
		}
		value = value*10 + int(ch-'0')
	}
	return value
}
