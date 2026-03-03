//go:build linux

package poller

import (
	"context"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// pingICMP sends a single ICMP echo request and returns (reachable, latencyMs).
// Requires CAP_NET_RAW or root on Linux.
func pingICMP(ctx context.Context, ip string) (bool, int) {
	pinger, err := probing.NewPinger(ip)
	if err != nil {
		return false, 0
	}
	pinger.Count = 1
	pinger.Timeout = 500 * time.Millisecond
	pinger.SetPrivileged(true)

	if err := pinger.RunWithContext(ctx); err != nil {
		return false, 0
	}
	stats := pinger.Statistics()
	if stats.PacketsRecv == 0 {
		return false, 0
	}
	return true, int(stats.AvgRtt.Milliseconds())
}
