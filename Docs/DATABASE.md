# WhatsLive — Database Reference

WhatsLive uses a single SQLite file (`whatslive.db` by default) managed by `modernc.org/sqlite` (pure Go, no CGO). Schema is applied at startup via embedded Goose migrations.

---

## Migration Files

| File | Contents |
|------|----------|
| `001_initial.sql` | `devices`, `settings`, `check_results`, `state_history`, `node_positions` |
| `002_custom.sql` | Adds `label`, `hidden`, `group_id` to `devices`; creates `groups`, `custom_edges` |
| `003_custom_devices.sql` | Adds `is_custom` to `devices` |
| `004_workspaces.sql` | Creates `workspaces`, `workspace_positions`; inserts the permanent Overview workspace |
| `005_enhancements.sql` | Adds `last_latency_ms`, `notes` to `devices`; adds `label` to `custom_edges` |
| `006_edge_color.sql` | Adds `color` column to `custom_edges` (default `#7c3aed`) |

Migrations are embedded in the binary via `go:embed`. Applied automatically and idempotently on every startup.

---

## Tables

### `devices`

Primary store for all discovered and manually created devices.

| Column | Type | Notes |
|--------|------|-------|
| `mac` | TEXT PRIMARY KEY | MAC address, colon-separated lowercase |
| `ip` | TEXT | Last observed IP. For custom devices this is the user-supplied monitoring IP |
| `hostname` | TEXT | Reverse DNS result |
| `vendor` | TEXT | OUI vendor string from the MAC prefix |
| `label` | TEXT | User-editable display name |
| `device_type` | TEXT | Classifier output or user override (see types below) |
| `state` | TEXT | `unknown` / `up` / `degraded` / `down` / `ignored` |
| `hidden` | INTEGER | 1 = hidden from map (still monitored), 0 = visible |
| `group_id` | INTEGER | FK to `groups.id`, nullable |
| `is_custom` | INTEGER | 1 = manually created, 0 = auto-discovered |
| `notes` | TEXT | Free-text notes, default empty string |
| `last_latency_ms` | INTEGER | Most recent ping RTT in milliseconds, nullable |
| `first_seen` | DATETIME | Row insertion timestamp |
| `last_seen` | DATETIME | Timestamp of last state update |

**Device types:** `router`, `switch`, `ap`, `server`, `nas`, `printer`, `camera`, `isp`, `firewall`, `phone`, `workstation`, `laptop`, `tv`, `generic`

---

### `groups`

Visual/logical groupings of devices.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `name` | TEXT | Display name |
| `color` | TEXT | CSS hex colour for the group background (default `#1e3a5c`) |
| `x` | REAL | Last group centroid X on the canvas, nullable |
| `y` | REAL | Last group centroid Y on the canvas, nullable |

---

### `custom_edges`

User-drawn connections between two nodes. Source and target are MAC addresses or `grp:{id}` references.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `source_mac` | TEXT | Source node identifier |
| `target_mac` | TEXT | Target node identifier |
| `color` | TEXT | Hex colour for the edge line, default `#7c3aed` |
| `label` | TEXT | Optional text label on the edge, default empty |
| UNIQUE | (`source_mac`, `target_mac`) | Prevents duplicate edges |

---

### `node_positions`

Persisted node positions for the default (Overview) workspace.

| Column | Type | Notes |
|--------|------|-------|
| `device_mac` | TEXT PRIMARY KEY | FK to `devices.mac` |
| `x` | REAL | Canvas X coordinate |
| `y` | REAL | Canvas Y coordinate |

---

### `workspaces`

Named custom views / tabs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Auto-increment. ID 1 is the permanent Overview workspace |
| `name` | TEXT | Display name |
| `group_id` | INTEGER | FK to `groups.id`, nullable. If set, workspace shows only that group |
| `sort_order` | INTEGER | Tab display order |

---

### `workspace_positions`

Per-workspace node positions. Each workspace maintains an independent layout.

| Column | Type | Notes |
|--------|------|-------|
| `workspace_id` | INTEGER | FK to `workspaces.id` |
| `device_mac` | TEXT | FK to `devices.mac` |
| `x` | REAL | Canvas X coordinate |
| `y` | REAL | Canvas Y coordinate |
| PRIMARY KEY | (`workspace_id`, `device_mac`) | |

---

### `state_history`

Immutable log of all device state transitions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `device_mac` | TEXT | FK to `devices.mac` |
| `from_state` | TEXT | Previous state |
| `to_state` | TEXT | New state |
| `transitioned_at` | DATETIME | Timestamp of transition (default `CURRENT_TIMESTAMP`) |

---

### `check_results`

Raw per-device ping results. Not currently surfaced in the UI but available for future charting.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `device_mac` | TEXT | FK to `devices.mac` |
| `check_type` | TEXT | Currently always `icmp` |
| `success` | INTEGER | 1 = reachable, 0 = unreachable |
| `latency_ms` | INTEGER | RTT in milliseconds, nullable |
| `checked_at` | DATETIME | Default `CURRENT_TIMESTAMP` |

**Growth rate:** at the default 30-second heartbeat with 50 devices, this table adds ~5,000 rows/day (~1.8 M rows/year). The poller automatically prunes rows older than 30 days on every discovery scan (every 5 minutes by default), keeping the table bounded at roughly 150,000 rows. If you disable the poller or need manual cleanup, run:

```sql
DELETE FROM check_results WHERE checked_at < datetime('now', '-30 days');
```

---

### `settings`

Key-value store for all runtime configuration.

| Key | Default | Description |
|-----|---------|-------------|
| `subnet` | NULL (triggers setup page on first run) | CIDR range to monitor |
| `bind_addr` | `0.0.0.0:8080` | HTTP server listen address |
| `discovery_interval_s` | `300` | Full subnet sweep interval in seconds |
| `heartbeat_interval_s` | `30` | Per-device ping interval (hardcoded in poller, setting reserved for future use) |
| `webhook_url` | (empty) | HTTP endpoint for state-change POST payloads (set via UI) |
| `slack_webhook_url` | (empty) | Slack Incoming Webhook URL (set via UI) |
| `license_key` | (empty) | Active RSA-signed JWT license key (set via UI) |

---

## Helper Functions — `internal/db/db.go`

```go
// Read a setting value
val, ok := dbpkg.Setting(database, "subnet")

// Write a setting value
dbpkg.SetSetting(database, "subnet", "192.168.1.0/24")
```
