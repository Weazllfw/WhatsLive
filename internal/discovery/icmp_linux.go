//go:build linux

package discovery

import (
	"context"
	"net"
	"sync"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// floodICMP sends one ICMP echo to every IP in the list concurrently to warm
// the OS ARP cache. Errors are swallowed — the ARP cache read is authoritative.
// Requires CAP_NET_RAW or root on Linux.
func floodICMP(ctx context.Context, ips []net.IP) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 256)

	for _, ip := range ips {
		wg.Add(1)
		sem <- struct{}{}
		go func(addr string) {
			defer wg.Done()
			defer func() { <-sem }()

			pinger, err := probing.NewPinger(addr)
			if err != nil {
				return
			}
			pinger.Count = 1
			pinger.Timeout = 200 * time.Millisecond
			pinger.SetPrivileged(true)
			_ = pinger.RunWithContext(ctx)
		}(ip.String())
	}
	wg.Wait()
}
