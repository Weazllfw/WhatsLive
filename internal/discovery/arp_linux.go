//go:build linux

package discovery

import (
	"bufio"
	"net"
	"os"
	"strings"
)

// arpEntry holds one row from the OS ARP/neighbour cache.
type arpEntry struct {
	IP  net.IP
	MAC string
}

// readARPCache reads /proc/net/arp and returns all complete entries.
// The format is:
//
//	IP address       HW type  Flags  HW address             Mask  Device
//	192.168.1.1      0x1      0x2    dc:a6:32:00:00:00      *     eth0
func readARPCache() ([]arpEntry, error) {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []arpEntry
	sc := bufio.NewScanner(f)
	sc.Scan() // skip header line
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		// flags 0x0 means incomplete (no response); skip those
		if fields[2] == "0x0" {
			continue
		}
		ip := net.ParseIP(fields[0])
		if ip == nil {
			continue
		}
		entries = append(entries, arpEntry{IP: ip, MAC: fields[3]})
	}
	return entries, sc.Err()
}
