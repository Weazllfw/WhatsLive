//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "WhatsLive"
const serviceDisplayName = "WhatsLive Network Monitor"
const serviceDescription = "Auto-discovers and monitors network devices. Web UI at http://localhost:8080"

// isWindowsService reports whether the process is running as a Windows Service.
func isWindowsService() bool {
	isSvc, err := svc.IsWindowsService()
	return err == nil && isSvc
}

// runAsService starts the Windows Service event loop. It blocks until the
// service manager sends a stop command.
func runAsService(runFn func(ctx context.Context)) {
	elog, err := eventlog.Open(serviceName)
	if err != nil {
		// Fall through without event log — not fatal.
		log.Printf("eventlog open: %v", err)
	}
	if elog != nil {
		defer elog.Close()
		_ = elog.Info(1, "WhatsLive service starting")
	}

	if err := svc.Run(serviceName, &serviceHandler{run: runFn}); err != nil {
		if elog != nil {
			_ = elog.Error(3, fmt.Sprintf("service run error: %v", err))
		}
		log.Fatalf("service run: %v", err)
	}
}

// serviceHandler implements svc.Handler.
type serviceHandler struct {
	run func(ctx context.Context)
}

func (h *serviceHandler) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {
	const acceptedCmds = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go h.run(ctx)

	status <- svc.Status{State: svc.Running, Accepts: acceptedCmds}

	for req := range requests {
		switch req.Cmd {
		case svc.Interrogate:
			status <- req.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			cancel()
			// Give goroutines a moment to flush.
			time.Sleep(500 * time.Millisecond)
			return false, 0
		}
	}
	return false, 0
}

// InstallService registers WhatsLive as a Windows Service running as LocalSystem.
// Pass subnet as the value to store; pass "" to skip setting it now.
func InstallService(exePath, subnet string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect() //nolint:errcheck

	args := []string{"--db", `C:\ProgramData\WhatsLive\whatslive.db`}
	if subnet != "" {
		args = append(args, "--subnet", subnet)
	}

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName:      serviceDisplayName,
		Description:      serviceDescription,
		StartType:        mgr.StartAutomatic,
		ServiceStartName: "LocalSystem",
	}, args...)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		// Non-fatal — the service will still work without the event log source.
		log.Printf("install event log: %v", err)
	}
	return nil
}

// UninstallService removes the WhatsLive Windows Service.
func UninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect() //nolint:errcheck

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	_ = eventlog.Remove(serviceName)
	return s.Delete()
}
