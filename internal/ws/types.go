package ws

const (
	TypeSnapshot      = "snapshot"
	TypeStateChange   = "state_change"
	TypeDeviceAdded   = "device_added"
	TypeDeviceUpdated = "device_updated"
	TypeDeviceRemoved = "device_removed"
	TypeLatencyUpdate = "latency_update"
)

type Envelope struct {
	Type    string `json:"type"`
	Version int    `json:"v"`
	Payload any    `json:"payload"`
}

func NewEnvelope(msgType string, payload any) Envelope {
	return Envelope{Type: msgType, Version: 1, Payload: payload}
}

// Device is the canonical device representation in all WebSocket payloads.
type Device struct {
	MAC         string   `json:"mac"`
	IP          string   `json:"ip"`
	Hostname    string   `json:"hostname"`
	Label       string   `json:"label"`
	Vendor      string   `json:"vendor"`
	DeviceType  string   `json:"device_type"`
	State       string   `json:"state"`
	Hidden      bool     `json:"hidden"`
	GroupID     *int64   `json:"group_id"`
	IsCustom    bool     `json:"is_custom"`
	Notes       string   `json:"notes"`
	LatencyMs   *int     `json:"latency_ms,omitempty"`
	FirstSeen   string   `json:"first_seen"`
	LastSeen    string   `json:"last_seen"`
	PosX        *float64 `json:"pos_x,omitempty"`
	PosY        *float64 `json:"pos_y,omitempty"`
}

// DeviceRemovedPayload is the payload for TypeDeviceRemoved events.
type DeviceRemovedPayload struct {
	MAC string `json:"mac"`
}

type StateChangePayload struct {
	DeviceMAC string `json:"device_mac"`
	State     string `json:"state"`
	At        string `json:"at"`
	LatencyMs int    `json:"latency_ms"` // 0 = unavailable (TCP fallback or ICMP failed)
}

// LatencyUpdatePayload is broadcast every heartbeat cycle for each device.
type LatencyUpdatePayload struct {
	DeviceMAC string `json:"device_mac"`
	LatencyMs int    `json:"latency_ms"`
}

// CustomEdge is a manual connection drawn by the user between two devices.
type CustomEdge struct {
	ID        int64  `json:"id"`
	SourceMAC string `json:"source_mac"`
	TargetMAC string `json:"target_mac"`
	Color     string `json:"color"`
	Label     string `json:"label"`
}

// Group is a named visual container for grouping devices on the map.
type Group struct {
	ID    int64    `json:"id"`
	Name  string   `json:"name"`
	Color string   `json:"color"`
	X     *float64 `json:"x,omitempty"`
	Y     *float64 `json:"y,omitempty"`
}

// Workspace is a named, independently-positioned view of the topology map.
type Workspace struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	GroupID   *int64 `json:"group_id"`
	SortOrder int    `json:"sort_order"`
}
