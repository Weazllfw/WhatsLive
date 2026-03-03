//go:build !windows

package main

import "context"

// isWindowsService always returns false on non-Windows platforms.
func isWindowsService() bool { return false }

// runAsService is a no-op on non-Windows platforms.
func runAsService(_ func(ctx context.Context)) {}
