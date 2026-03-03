// Package classifier assigns a device_type to a discovered host using MAC OUI
// vendor strings and TCP port probing. SNMP enrichment is intentionally absent
// at Phase 1; the Enrich hook is the designated insertion point for v1.1.
package classifier

import (
	"context"
	"net"
	"strings"
	"time"
)

// DeviceType constants match the values stored in the devices table.
const (
	TypeRouter      = "router"
	TypeFirewall    = "firewall"
	TypeSwitch      = "switch"
	TypeServer      = "server"
	TypePrinter     = "printer"
	TypeAP          = "ap"
	TypeNAS         = "nas"
	TypeWorkstation = "workstation"
	TypeLaptop      = "laptop"
	TypePhone       = "phone"
	TypeTV          = "tv"
	TypeCamera      = "camera"
	TypeISP         = "isp"
	TypeCloud       = "cloud"
	TypeGeneric     = "generic"
)

// portProbe defines which TCP ports to check for a given device type.
var portProbes = map[string][]int{
	TypeRouter:   {80, 443, 22},
	TypeFirewall: {443, 22, 80},
	TypeSwitch:   {80, 443, 22},
	TypeServer:   {22, 3389, 443, 445},
	TypePrinter:  {9100, 631},
	TypeAP:       {80, 443, 22},
	TypeNAS:      {445, 2049, 80},
	TypeCamera:   {80, 554, 8080},
	TypePhone:    {5060, 80},
	TypeGeneric:  {80},
}

// ouiHints maps lowercase OUI vendor substrings to device types.
// Longer, more-specific strings must come before shorter ones in the slice so
// that the first match wins with the right priority.
var ouiHints = []struct {
	substr     string
	deviceType string
}{
	// Firewalls / security appliances
	{"fortinet", TypeFirewall},
	{"palo alto", TypeFirewall},
	{"sonicwall", TypeFirewall},
	{"watchguard", TypeFirewall},
	{"barracuda", TypeFirewall},
	{"checkpoint", TypeFirewall},

	// Routers / gateways
	{"opnsense", TypeRouter},
	{"pfsense", TypeRouter},
	{"cisco", TypeRouter},
	{"juniper", TypeRouter},
	{"mikrotik", TypeRouter},

	// Access points
	{"ubiquiti", TypeAP},
	{"aruba", TypeAP},
	{"ruckus", TypeAP},
	{"engenius", TypeAP},
	{"meraki", TypeAP},

	// Servers / hypervisors
	{"proxmox", TypeServer},
	{"vmware", TypeServer},
	{"dell", TypeServer},
	{"hewlett", TypeServer},
	{"supermicro", TypeServer},

	// Switches
	{"netgear", TypeSwitch},
	{"tp-link", TypeSwitch},
	{"zyxel", TypeSwitch},
	{"d-link", TypeSwitch},
	{"extreme", TypeSwitch},

	// NAS
	{"buffalo", TypeNAS},
	{"synology", TypeNAS},
	{"qnap", TypeNAS},
	{"western digital", TypeNAS},
	{"seagate", TypeNAS},

	// Printers
	{"ricoh", TypePrinter},
	{"brother", TypePrinter},
	{"canon", TypePrinter},
	{"xerox", TypePrinter},
	{"epson", TypePrinter},
	{"kyocera", TypePrinter},
	{"lexmark", TypePrinter},

	// IP cameras / CCTV
	{"hikvision", TypeCamera},
	{"dahua", TypeCamera},
	{"axis", TypeCamera},
	{"hanwha", TypeCamera},
	{"reolink", TypeCamera},
	{"uniview", TypeCamera},

	// VoIP phones
	{"polycom", TypePhone},
	{"yealink", TypePhone},
	{"grandstream", TypePhone},
	{"snom", TypePhone},
	{"cisco spa", TypePhone},

	// Smart TVs / streaming
	{"samsung", TypeTV},
	{"lg electronics", TypeTV},
	{"sony", TypeTV},
	{"vizio", TypeTV},
	{"roku", TypeTV},
	{"nvidia shield", TypeTV},

	// Workstations / laptops (mac/apple last to avoid false matches)
	{"apple", TypeWorkstation},
}

// Classify infers the device type for a host identified by vendor (from OUI)
// and confirms via TCP port probing. It returns the best-guess device type.
func Classify(ctx context.Context, ip, vendor string) string {
	guess := fromOUI(vendor)
	return confirm(ctx, ip, guess)
}

// Enrich is the reserved hook for SNMP-based enrichment in v1.1. Currently a
// no-op; callers may pass the result of Classify to it safely.
func Enrich(_ context.Context, deviceType, _ /*ip*/ string) string {
	return deviceType
}

// fromOUI maps a vendor string to a device type using substring matching.
func fromOUI(vendor string) string {
	lower := strings.ToLower(vendor)
	for _, hint := range ouiHints {
		if strings.Contains(lower, hint.substr) {
			return hint.deviceType
		}
	}
	return TypeGeneric
}

// confirm probes TCP ports to validate or upgrade the OUI-based guess.
// If none of the type-specific ports respond, the guess is kept as-is.
func confirm(ctx context.Context, ip, guess string) string {
	// Port-based override: check well-known service ports regardless of OUI.
	type portType struct {
		port       int
		deviceType string
	}
	portOverrides := []portType{
		{9100, TypePrinter},
		{631,  TypePrinter},
		{2049, TypeNAS},
		{554,  TypeCamera}, // RTSP — IP cameras
		{5060, TypePhone},  // SIP — VoIP phones
	}
	for _, pt := range portOverrides {
		if tcpOpen(ctx, ip, pt.port) {
			return pt.deviceType
		}
	}

	// Validate the OUI guess by checking its expected ports.
	ports := portProbes[guess]
	if guess == TypeGeneric {
		// For generic, check server ports to see if it's actually a server.
		if tcpOpen(ctx, ip, 22) || tcpOpen(ctx, ip, 3389) || tcpOpen(ctx, ip, 443) {
			return TypeServer
		}
		return TypeGeneric
	}
	for _, p := range ports {
		if tcpOpen(ctx, ip, p) {
			return guess
		}
	}

	// No ports responded — fall back to generic.
	return TypeGeneric
}

// tcpOpen attempts a TCP connection and returns true if it succeeds or is
// refused (refused means the host is up, just nothing listening on that port).
func tcpOpen(ctx context.Context, ip string, port int) bool {
	addr := net.JoinHostPort(ip, intToStr(port))
	d := net.Dialer{Timeout: 300 * time.Millisecond}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func intToStr(n int) string {
	b := make([]byte, 0, 6)
	if n == 0 {
		return "0"
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
