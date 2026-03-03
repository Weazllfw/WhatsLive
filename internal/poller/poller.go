// Package poller runs the heartbeat and discovery loops.
//
// Heartbeat: every 30 seconds, ICMP ping + TCP check each known device.
// Discovery: every discovery_interval_s seconds (default 300), full subnet scan.
package poller

import (
	"context"
	"database/sql"
	"log"
	"net"
	"strconv"
	"time"

	"github.com/weazllfw/whatslive/internal/classifier"
	dbpkg "github.com/weazllfw/whatslive/internal/db"
	"github.com/weazllfw/whatslive/internal/discovery"
	"github.com/weazllfw/whatslive/internal/state"
	"github.com/weazllfw/whatslive/internal/ws"
)

const heartbeatInterval = 30 * time.Second

// Run starts the heartbeat and discovery goroutines. It blocks until ctx is
// cancelled. broadcast is called on every heartbeat result so the UI receives
// real-time latency updates; pass nil to disable.
func Run(ctx context.Context, database *sql.DB, subnet string, fsm *state.Machine, events chan<- state.Event, broadcast func(ws.Envelope)) {
	// Seed FSM with any devices already in the database.
	seedFromDB(database, fsm)

	go runDiscovery(ctx, database, subnet, fsm)
	go runHeartbeat(ctx, database, fsm, broadcast)

	<-ctx.Done()
}

// runDiscovery runs the periodic subnet discovery loop.
func runDiscovery(ctx context.Context, database *sql.DB, subnet string, fsm *state.Machine) {
	intervalSec := 300
	if v, ok := dbpkg.Setting(database, "discovery_interval_s"); ok {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			intervalSec = n
		}
	}
	ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
	defer ticker.Stop()

	// Run once immediately on startup.
	runOneScan(ctx, database, subnet, fsm)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runOneScan(ctx, database, subnet, fsm)
		}
	}
}

func runOneScan(ctx context.Context, database *sql.DB, subnet string, fsm *state.Machine) {
	devices, err := discovery.Run(ctx, database, subnet)
	if err != nil {
		log.Printf("poller: discovery error: %v", err)
		return
	}
	for _, d := range devices {
		current := deviceType(database, d.MAC)
		if current == "" || current == "generic" {
			classifyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			dtype := classifier.Classify(classifyCtx, d.IP, d.Vendor)
			cancel()
			if dtype != "generic" || current == "" {
				updateDeviceType(database, d.MAC, dtype)
			}
		}
		fsm.EnsureDevice(d.MAC)
	}

	// Prune check_results older than 30 days to prevent unbounded database growth.
	// At a 30-second heartbeat with 50 devices this table grows at ~5,000 rows/day.
	pruneCheckResults(database)
}

// pruneCheckResults deletes check_results rows older than 30 days.
func pruneCheckResults(database *sql.DB) {
	res, err := database.Exec(
		`DELETE FROM check_results WHERE checked_at < datetime('now', '-30 days')`,
	)
	if err != nil {
		log.Printf("poller: prune check_results: %v", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("poller: pruned %d old check_results rows", n)
	}
}

// runHeartbeat runs the 30-second heartbeat loop.
func runHeartbeat(ctx context.Context, database *sql.DB, fsm *state.Machine, broadcast func(ws.Envelope)) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkAllDevices(ctx, database, fsm, broadcast)
		}
	}
}

func checkAllDevices(ctx context.Context, database *sql.DB, fsm *state.Machine, broadcast func(ws.Envelope)) {
	macs := fsm.KnownMACs()
	for _, mac := range macs {
		if fsm.State(mac) == state.StateIgnored {
			continue
		}
		ip, dtype := deviceIPAndType(database, mac)
		if ip == "" || ip == "0.0.0.0" {
			continue
		}

		ok, latencyMs := checkDevice(ctx, ip, dtype)
		fsm.Record(mac, ok, latencyMs)

		persistCheckResult(database, mac, ok, latencyMs)

		log.Printf("heartbeat: %s (%s) latency=%dms ok=%v", ip, mac, latencyMs, ok)

		// Broadcast a lightweight latency update so the UI reflects real-time RTT.
		if broadcast != nil {
			broadcast(ws.NewEnvelope(ws.TypeLatencyUpdate, ws.LatencyUpdatePayload{
				DeviceMAC: mac,
				LatencyMs: latencyMs,
			}))
		}
	}
}

// checkDevice runs ICMP + TCP checks for the given IP/device type.
// Returns overall reachability and ICMP latency.
func checkDevice(ctx context.Context, ip, dtype string) (bool, int) {
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	icmpOK, latencyMs := pingICMP(checkCtx, ip)
	if icmpOK {
		return true, latencyMs
	}

	// ICMP failed — fall back to TCP on a type-appropriate port.
	port := fallbackPort(dtype)
	if port > 0 {
		addr := net.JoinHostPort(ip, strconv.Itoa(port))
		conn, err := (&net.Dialer{Timeout: 500 * time.Millisecond}).DialContext(checkCtx, "tcp", addr)
		if err == nil {
			conn.Close()
			return true, 0
		}
	}
	return false, 0
}

// fallbackPort returns the most likely open TCP port for a device type.
func fallbackPort(dtype string) int {
	switch dtype {
	case "router", "switch", "ap":
		return 443
	case "server":
		return 22
	case "printer":
		return 9100
	case "nas":
		return 445
	default:
		return 80
	}
}

// --- database helpers ---

func seedFromDB(database *sql.DB, fsm *state.Machine) {
	rows, err := database.Query(`SELECT mac FROM devices WHERE state != 'ignored'`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var mac string
		if rows.Scan(&mac) == nil {
			fsm.EnsureDevice(mac)
		}
	}
}

func deviceIPAndType(database *sql.DB, mac string) (string, string) {
	var ip, dtype string
	database.QueryRow(`SELECT ip, device_type FROM devices WHERE mac = ?`, mac).Scan(&ip, &dtype) //nolint:errcheck
	return ip, dtype
}

func deviceType(database *sql.DB, mac string) string {
	var dtype string
	database.QueryRow(`SELECT device_type FROM devices WHERE mac = ?`, mac).Scan(&dtype) //nolint:errcheck
	return dtype
}

func updateDeviceType(database *sql.DB, mac, dtype string) {
	database.Exec(`UPDATE devices SET device_type = ? WHERE mac = ?`, dtype, mac) //nolint:errcheck
}

func persistCheckResult(database *sql.DB, mac string, ok bool, latencyMs int) {
	success := 0
	if ok {
		success = 1
	}
	var lat *int
	if latencyMs > 0 {
		lat = &latencyMs
	}
	database.Exec( //nolint:errcheck
		`INSERT INTO check_results (device_mac, check_type, success, latency_ms)
		 VALUES (?, 'icmp', ?, ?)`,
		mac, success, lat,
	)
	database.Exec( //nolint:errcheck
		`UPDATE devices SET last_seen = CURRENT_TIMESTAMP, last_latency_ms = ? WHERE mac = ?`,
		lat, mac,
	)
}
