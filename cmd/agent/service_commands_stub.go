//go:build !windows

package main

// handleServiceCommands is a no-op on non-Windows platforms.
func handleServiceCommands() error { return nil }
