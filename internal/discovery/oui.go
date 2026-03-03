package discovery

import (
	"bufio"
	"bytes"
	_ "embed"
	"strings"
	"sync"
)

//go:embed data/oui.txt
var ouiRaw []byte

var (
	ouiOnce   sync.Once
	ouiTable  map[string]string // uppercase 6-hex-char prefix → vendor name
)

func initOUI() {
	ouiTable = make(map[string]string, 40000)
	sc := bufio.NewScanner(bytes.NewReader(ouiRaw))
	for sc.Scan() {
		line := sc.Text()
		// Skip comments and blank lines
		if line == "" || line[0] == '#' {
			continue
		}
		// Wireshark manuf format:
		//   00:00:00	Officially Xerox	Xerox Corporation
		// or short form:
		//   00:00:00	Xerox
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 2 {
			continue
		}
		prefix := strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(parts[0])), ":", "")
		// Prefer the full vendor name (col 3) over the abbreviated name (col 2).
		name := strings.TrimSpace(parts[1])
		if len(parts) == 3 && strings.TrimSpace(parts[2]) != "" {
			name = strings.TrimSpace(parts[2])
		}
		if len(prefix) == 6 { // 3-byte OUI only
			ouiTable[prefix] = name
		}
	}
}

// LookupVendor returns the IEEE OUI vendor name for a MAC address, or an empty
// string if the prefix is not found. mac may use any common separator.
func LookupVendor(mac string) string {
	ouiOnce.Do(initOUI)

	clean := strings.ToUpper(strings.NewReplacer(":", "", "-", "", ".", "").Replace(mac))
	if len(clean) < 6 {
		return ""
	}
	return ouiTable[clean[:6]]
}
