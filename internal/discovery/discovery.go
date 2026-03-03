// Package discovery scans a subnet, reads the OS ARP cache, and returns a
// list of live devices with their MAC, IP, hostname, and vendor.
package discovery

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// Device is a discovered host with all identifying information filled in.
type Device struct {
	MAC      string
	IP       string
	Hostname string
	Vendor   string
}

// Run discovers all live hosts in subnet (CIDR notation), writes them to the
// database (upsert on MAC), and returns the discovered list.
func Run(ctx context.Context, db *sql.DB, subnet string) ([]Device, error) {
	_, ipNet, err := net.ParseCIDR(subnet)
	if err != nil {
		return nil, fmt.Errorf("parse subnet %q: %w", subnet, err)
	}

	ips := expandCIDR(ipNet)
	log.Printf("discovery: scanning %d addresses in %s", len(ips), subnet)

	floodICMP(ctx, ips)

	entries, err := readARPCache()
	if err != nil {
		return nil, fmt.Errorf("read ARP cache: %w", err)
	}

	var (
		devices []Device
		mu      sync.Mutex
		wg      sync.WaitGroup
		sem     = make(chan struct{}, 64)
	)

	for _, entry := range entries {
		if !ipNet.Contains(entry.IP) {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(e arpEntry) {
			defer wg.Done()
			defer func() { <-sem }()

			hostname := reverseDNS(e.IP.String())
			vendor := LookupVendor(e.MAC)

			d := Device{
				MAC:      normaliseMAC(e.MAC),
				IP:       e.IP.String(),
				Hostname: hostname,
				Vendor:   vendor,
			}
			mu.Lock()
			devices = append(devices, d)
			mu.Unlock()
		}(entry)
	}
	wg.Wait()

	if db != nil {
		if err := upsertDevices(db, devices); err != nil {
			log.Printf("discovery: upsert error: %v", err)
		}
	}

	log.Printf("discovery: found %d devices", len(devices))
	return devices, nil
}

// expandCIDR returns all host IPs within the network (excludes network and
// broadcast addresses for IPv4).
func expandCIDR(ipNet *net.IPNet) []net.IP {
	var ips []net.IP
	for ip := cloneIP(ipNet.IP.Mask(ipNet.Mask)); ipNet.Contains(ip); incrementIP(ip) {
		// skip network address and broadcast
		dup := cloneIP(ip)
		ips = append(ips, dup)
	}
	if len(ips) > 2 {
		ips = ips[1 : len(ips)-1]
	}
	return ips
}

func cloneIP(ip net.IP) net.IP {
	dup := make(net.IP, len(ip))
	copy(dup, ip)
	return dup
}

func incrementIP(ip net.IP) {
	for i := len(ip) - 1; i >= 0; i-- {
		ip[i]++
		if ip[i] != 0 {
			break
		}
	}
}

// reverseDNS attempts a PTR lookup for ip, returning the first hostname or
// the raw IP string on failure.
func reverseDNS(ip string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	names, err := net.DefaultResolver.LookupAddr(ctx, ip)
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.TrimSuffix(names[0], ".")
}

// normaliseMAC converts any MAC format to the canonical lowercase colon form.
func normaliseMAC(mac string) string {
	mac = strings.ToLower(mac)
	mac = strings.ReplaceAll(mac, "-", ":")
	return mac
}

// upsertDevices writes devices to the DB, updating IP/hostname/vendor if the
// MAC already exists.
func upsertDevices(db *sql.DB, devices []Device) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`
		INSERT INTO devices (mac, ip, hostname, vendor, device_type, state, first_seen, last_seen)
		VALUES (?, ?, ?, ?, 'generic', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(mac) DO UPDATE SET
			ip        = excluded.ip,
			hostname  = excluded.hostname,
			vendor    = excluded.vendor,
			last_seen = CURRENT_TIMESTAMP
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, d := range devices {
		if _, err := stmt.Exec(d.MAC, d.IP, d.Hostname, d.Vendor); err != nil {
			return fmt.Errorf("upsert %s: %w", d.MAC, err)
		}
	}
	return tx.Commit()
}
