//go:build windows

package poller

import (
	"context"
	"net"
	"syscall"
	"unsafe"
)

var (
	iphlpapiPoller  = syscall.NewLazyDLL("iphlpapi.dll")
	icmpCreateP     = iphlpapiPoller.NewProc("IcmpCreateFile")
	icmpSendEchoP   = iphlpapiPoller.NewProc("IcmpSendEcho")
	icmpCloseP      = iphlpapiPoller.NewProc("IcmpCloseHandle")
)

type icmpEchoReply struct {
	Address      uint32
	Status       uint32
	RoundTrip    uint32
	DataSize     uint16
	_            uint16
	DataPtr      uintptr
	Ttl          uint8
	Tos          uint8
	Flags        uint8
	OptionsSize  uint8
	OptionsData  uintptr
}

// pingICMP sends a single ICMP echo via IcmpSendEcho (no raw socket required).
func pingICMP(ctx context.Context, ip string) (bool, int) {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false, 0
	}
	ip4 := parsed.To4()
	if ip4 == nil {
		return false, 0
	}

	handle, _, _ := icmpCreateP.Call()
	if handle == 0 {
		return false, 0
	}
	defer icmpCloseP.Call(handle) //nolint:errcheck

	destAddr := *(*uint32)(unsafe.Pointer(&ip4[0]))
	sendData := []byte("whatslive-hb")
	replyBuf := make([]byte, int(unsafe.Sizeof(icmpEchoReply{}))+len(sendData)+8)

	ret, _, _ := icmpSendEchoP.Call(
		handle,
		uintptr(destAddr),
		uintptr(unsafe.Pointer(&sendData[0])),
		uintptr(len(sendData)),
		0,
		uintptr(unsafe.Pointer(&replyBuf[0])),
		uintptr(len(replyBuf)),
		500, // timeout ms
	)
	if ret == 0 {
		return false, 0
	}

	reply := (*icmpEchoReply)(unsafe.Pointer(&replyBuf[0]))
	if reply.Status != 0 { // 0 = IP_SUCCESS
		return false, 0
	}
	return true, int(reply.RoundTrip)
}
