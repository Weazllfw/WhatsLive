//go:build windows

package main

import (
	"fmt"
	"os"
)

// handleServiceCommands processes --install-service and --uninstall-service flags.
// Returns nil if neither flag is set (normal run). Returns non-nil error on failure.
func handleServiceCommands() error {
	if *flagInstallService {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("could not determine executable path: %w", err)
		}
		if err := InstallService(exe, *flagSubnet); err != nil {
			return fmt.Errorf("install service: %w", err)
		}
		fmt.Println("WhatsLive service installed successfully.")
		os.Exit(0)
	}
	if *flagUninstallService {
		if err := UninstallService(); err != nil {
			return fmt.Errorf("uninstall service: %w", err)
		}
		fmt.Println("WhatsLive service removed.")
		os.Exit(0)
	}
	return nil
}
