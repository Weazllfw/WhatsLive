// Package state implements the per-device availability state machine.
//
// States:
//   - unknown  : newly discovered, no checks completed yet
//   - up        : all checks passing for ≥2 consecutive cycles
//   - degraded  : intermittent failure / flapping detected
//   - down       : unreachable for ≥2 consecutive cycles
//   - ignored   : manually excluded (not set by the FSM itself)
//
// Noise suppression:
//   - A device must be observed for ≥90 seconds before leaving "unknown"
//   - A device must fail ≥2 consecutive cycles before transitioning to "down"
//   - A single failure from "up" goes to "degraded", not straight to "down"
package state

import (
	"database/sql"
	"fmt"
	"sync"
	"time"
)

// State constants.
const (
	StateUnknown  = "unknown"
	StateUp       = "up"
	StateDegraded = "degraded"
	StateDown     = "down"
	StateIgnored  = "ignored"
)

// noiseWindow is the minimum observation period before leaving unknown.
const noiseWindow = 90 * time.Second

// Event is emitted whenever a device transitions to a new state.
type Event struct {
	DeviceMAC string
	OldState  string
	NewState  string
	At        time.Time
	LatencyMs int // last measured round-trip; 0 = unavailable
}

// deviceRecord tracks in-memory polling state for one device.
type deviceRecord struct {
	mac              string
	state            string
	firstSeen        time.Time
	lastTransition   time.Time
	consecutiveFails int
	consecutiveOK    int
}

// Machine manages state for all known devices and emits transition events.
type Machine struct {
	mu      sync.Mutex
	devices map[string]*deviceRecord
	events  chan<- Event
	db      *sql.DB
}

// New creates a Machine that emits transition events on ch. Pass a nil db to
// disable persistence (useful in tests).
func New(db *sql.DB, ch chan<- Event) *Machine {
	return &Machine{
		devices: make(map[string]*deviceRecord),
		events:  ch,
		db:      db,
	}
}

// EnsureDevice adds a device to the state machine if it is not already known.
// Call this after discovery so heartbeat loops have something to check.
func (m *Machine) EnsureDevice(mac string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.devices[mac]; !ok {
		m.devices[mac] = &deviceRecord{
			mac:       mac,
			state:     StateUnknown,
			firstSeen: time.Now(),
		}
	}
}

// Record processes a check result for mac and returns the (possibly new) state.
// latencyMs is the round-trip time of the last ICMP check; 0 means unavailable
// (TCP fallback succeeded or ICMP failed entirely).
func (m *Machine) Record(mac string, success bool, latencyMs int) string {
	m.mu.Lock()
	defer m.mu.Unlock()

	dev, ok := m.devices[mac]
	if !ok {
		dev = &deviceRecord{
			mac:       mac,
			state:     StateUnknown,
			firstSeen: time.Now(),
		}
		m.devices[mac] = dev
	}

	oldState := dev.state
	if success {
		dev.consecutiveFails = 0
		dev.consecutiveOK++
	} else {
		dev.consecutiveOK = 0
		dev.consecutiveFails++
	}

	newState := m.nextState(dev)
	if newState != oldState {
		dev.state = newState
		dev.lastTransition = time.Now()
		m.persist(dev, oldState, newState)
		if m.events != nil {
			m.events <- Event{
				DeviceMAC: mac,
				OldState:  oldState,
				NewState:  newState,
				At:        dev.lastTransition,
				LatencyMs: latencyMs,
			}
		}
	}

	return dev.state
}

// State returns the current state for a device, or StateUnknown if not tracked.
func (m *Machine) State(mac string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if dev, ok := m.devices[mac]; ok {
		return dev.state
	}
	return StateUnknown
}

// KnownMACs returns all MAC addresses currently tracked by the machine.
func (m *Machine) KnownMACs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	macs := make([]string, 0, len(m.devices))
	for mac := range m.devices {
		macs = append(macs, mac)
	}
	return macs
}

// nextState computes the transition given the current record, applying all
// noise-suppression rules.
func (m *Machine) nextState(dev *deviceRecord) string {
	// Honour ignored — the FSM never overrides a manual exclusion.
	if dev.state == StateIgnored {
		return StateIgnored
	}

	// Within the noise window, only allow unknown → unknown.
	if dev.state == StateUnknown && time.Since(dev.firstSeen) < noiseWindow {
		return StateUnknown
	}

	switch dev.state {
	case StateUnknown:
		if dev.consecutiveOK >= 2 {
			return StateUp
		}
		if dev.consecutiveFails >= 2 {
			return StateDown
		}
		return StateUnknown

	case StateUp:
		if dev.consecutiveFails >= 2 {
			return StateDown
		}
		if dev.consecutiveFails == 1 {
			return StateDegraded
		}
		return StateUp

	case StateDegraded:
		if dev.consecutiveFails >= 2 {
			return StateDown
		}
		if dev.consecutiveOK >= 2 {
			return StateUp
		}
		return StateDegraded

	case StateDown:
		if dev.consecutiveOK >= 2 {
			return StateUp
		}
		if dev.consecutiveOK == 1 {
			return StateDegraded
		}
		return StateDown
	}

	return dev.state
}

func (m *Machine) persist(dev *deviceRecord, oldState, newState string) {
	if m.db == nil {
		return
	}
	_, err := m.db.Exec(
		`UPDATE devices SET state = ?, last_seen = CURRENT_TIMESTAMP WHERE mac = ?`,
		newState, dev.mac,
	)
	if err != nil {
		fmt.Printf("state: update device %s: %v\n", dev.mac, err)
	}
	_, err = m.db.Exec(
		`INSERT INTO state_history (device_mac, from_state, to_state) VALUES (?, ?, ?)`,
		dev.mac, oldState, newState,
	)
	if err != nil {
		fmt.Printf("state: insert history %s: %v\n", dev.mac, err)
	}
}
