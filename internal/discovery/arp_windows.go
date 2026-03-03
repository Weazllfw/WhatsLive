//go:build windows

package discovery

import (
	"bufio"
	"bytes"
	"net"
	"os/exec"
	"strings"
)

// arpEntry holds one row from the OS ARP/neighbour cache.
type arpEntry struct {
	IP  net.IP
	MAC string
}

// readARPCache shells out to `arp -a` and parses the output.
// Sample output:
//
//	Interface: 192.168.1.10 --- 0x3
//	  Internet Address      Physical Address      Type
//	  192.168.1.1           dc-a6-32-00-00-00     dynamic
//	  192.168.1.5           00-11-22-33-44-55     dynamic
func readARPCache() ([]arpEntry, error) {
	out, err := exec.Command("arp", "-a").Output()
	if err != nil {
		return nil, err
	}

	var entries []arpEntry
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		// Only "dynamic" entries represent real hosts; skip "static" (OS entries)
		if strings.ToLower(fields[2]) != "dynamic" {
			continue
		}
		ip := net.ParseIP(fields[0])
		if ip == nil {
			continue
		}
		// Windows uses dashes; normalise to colons
		mac := strings.ReplaceAll(fields[1], "-", ":")
		entries = append(entries, arpEntry{IP: ip, MAC: mac})
	}
	return entries, sc.Err()
}
