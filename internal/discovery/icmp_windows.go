//go:build windows

package discovery

import (
	"context"
	"net"
	"sync"
	"syscall"
	"unsafe"
)

var (
	iphlpapi        = syscall.NewLazyDLL("iphlpapi.dll")
	icmpCreateFile  = iphlpapi.NewProc("IcmpCreateFile")
	icmpSendEcho    = iphlpapi.NewProc("IcmpSendEcho")
	icmpCloseHandle = iphlpapi.NewProc("IcmpCloseHandle")
)

// floodICMP uses IcmpSendEcho (iphlpapi.dll) to send one ICMP echo per host.
// Unlike raw sockets, IcmpSendEcho works without administrator privileges on
// Windows, making it suitable for both elevated and non-elevated contexts.
func floodICMP(ctx context.Context, ips []net.IP) {
	handle, _, _ := icmpCreateFile.Call()
	if handle == 0 {
		// IcmpCreateFile failed; ARP cache read will still run.
		return
	}
	defer icmpCloseHandle.Call(handle) //nolint:errcheck

	var wg sync.WaitGroup
	sem := make(chan struct{}, 256)

	for _, ip := range ips {
		select {
		case <-ctx.Done():
			break
		default:
		}

		ip4 := ip.To4()
		if ip4 == nil {
			continue
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(addr [4]byte) {
			defer wg.Done()
			defer func() { <-sem }()

			destAddr := *(*uint32)(unsafe.Pointer(&addr[0]))

			const (
				replyBufSize = 28 // sizeof(ICMP_ECHO_REPLY) on 32-bit; safe on 64-bit
				timeoutMs    = 200
			)
			sendData := []byte("whatslive")
			replyBuf := make([]byte, replyBufSize+len(sendData))

			icmpSendEcho.Call(
				handle,
				uintptr(destAddr),
				uintptr(unsafe.Pointer(&sendData[0])),
				uintptr(len(sendData)),
				0,
				uintptr(unsafe.Pointer(&replyBuf[0])),
				uintptr(len(replyBuf)),
				timeoutMs,
			)
		}([4]byte{ip4[0], ip4[1], ip4[2], ip4[3]})
	}
	wg.Wait()
}
