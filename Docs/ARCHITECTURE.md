# WhatsLive — Architecture Reference

---

## System Diagram

```
┌────────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                     │
│   TopologyMap · DeviceList · DevicePanel · WorkspaceTabs   │
└──────────────┬─────────────────────────┬───────────────────┘
               │ REST (HTTP/JSON)         │ WebSocket (JSON envelopes)
               ▼                          ▼
┌────────────────────────────────────────────────────────────┐
│               Go Agent  (single binary)                    │
│                                                            │
│  ┌───────────┐   ┌────────────┐   ┌─────────────────────┐  │
│  │  Gin API  │   │  WS Hub    │   │  State FSM          │  │
│  │ server.go │   │  hub.go    │   │  internal/state/    │  │
│  └─────┬─────┘   └─────┬──────┘   └──────────┬──────────┘  │
│        │               │                      │             │
│  ┌─────▼───────────────▼──────────┐   ┌───────▼──────────┐  │
│  │         SQLite DB              │   │     Poller       │  │
│  │    (modernc.org/sqlite)        │   │  internal/poller/│  │
│  └────────────────────────────────┘   └──────────────────┘  │
│                                                            │
│  ┌─────────────────┐   ┌──────────────────────────────┐   │
│  │   Discovery     │   │   Classifier                 │   │
│  │ internal/       │   │   internal/classifier/       │   │
│  │ discovery/      │   └──────────────────────────────┘   │
│  └─────────────────┘                                      │
└────────────────────────────────────────────────────────────┘
               │
               │  ICMP flood / ARP cache / TCP probe
               ▼
          LAN devices
```

---

## Backend Components

### Entry Point — `cmd/agent/main.go`

`main()` performs:
1. Parse CLI flags.
2. Handle `--install-service` / `--uninstall-service` if present (Windows only).
3. If running as a Windows Service, delegate to `runAsService()`.
4. Otherwise call `run(ctx, dbPath, subnetFlag, addrFlag)`.

`run()` startup sequence:
1. `db.Open(dbPath)` — opens SQLite file, applies any pending Goose migrations.
2. Resolve active subnet and bind address (CLI flag > settings table > defaults).
3. Create `state.Machine` + `eventCh` channel.
4. Create WebSocket `hub`.
5. Instantiate `license.Manager` — loads saved key from settings table, enforces device limit.
6. Instantiate `notify.Notifier` — fires webhooks / Slack on Pro-tier state transitions.
7. Start goroutine that fans `eventCh` → `hub.Broadcast(TypeStateChange)` + conditional `notifier.Send`.
8. If subnet is set, `go poller.Run(ctx, ...)`.
9. `go srv.Run(bindAddr)` — non-blocking HTTP server.
10. Block on `ctx.Done()`.

---

### HTTP + WebSocket Server — `internal/api/`

#### `server.go`

`Server` struct holds `*sql.DB`, `*Hub`, `*state.Machine`, `StartupFunc` callback, and `*license.Manager`.

Routes registered by `New().Run(addr)`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/ws` | WebSocket upgrade |
| GET | `/api/status` | Setup status (has subnet?) |
| POST | `/api/setup` | Submit subnet, starts poller |
| GET | `/api/devices` | List all devices |
| POST | `/api/devices` | Create custom device |
| PATCH | `/api/devices/:mac` | Update label / type / IP / notes / group |
| DELETE | `/api/devices/:mac` | Remove device |
| PUT | `/api/devices/:mac/position` | Save node position (Overview) |
| PUT | `/api/devices/:mac/visibility` | Toggle map visibility |
| GET | `/api/devices/:mac/history` | State transition log |
| GET | `/api/groups` | List groups |
| POST | `/api/groups` | Create group |
| PUT | `/api/groups/:id` | Rename / recolour group |
| DELETE | `/api/groups/:id` | Delete group |
| GET | `/api/edges` | List custom edges |
| POST | `/api/edges` | Create custom edge |
| PATCH | `/api/edges/:id` | Update edge label |
| DELETE | `/api/edges/:id` | Delete custom edge |
| GET | `/api/workspaces` | List workspaces |
| POST | `/api/workspaces` | Create workspace |
| PUT | `/api/workspaces/:id` | Rename workspace |
| DELETE | `/api/workspaces/:id` | Delete workspace |
| GET | `/api/workspaces/:id/positions` | Get all node positions for workspace |
| PUT | `/api/workspaces/:id/devices/:mac/position` | Save node position for workspace |
| GET | `/api/license` | License status |
| POST | `/api/license` | Apply license key |
| DELETE | `/api/license` | Clear license key |
| GET | `/api/notifications` | Get notification config |
| PUT | `/api/notifications` | Save notification config |
| POST | `/api/notifications/test` | Send a test notification |

#### `hub.go`

`Hub` serialises all WebSocket writes through a single internal goroutine.

- `Register(conn, snapshot)` — sends the snapshot as the client's first message, then adds the connection to the active set.
- `Broadcast(env)` — writes to all connected clients; dead connections are pruned.

---

### State Machine — `internal/state/fsm.go`

#### States

| State | Meaning |
|-------|---------|
| `unknown` | Newly tracked; no completed checks yet |
| `up` | Two or more consecutive successful pings |
| `degraded` | First failure from `up`, or recovering from `down` |
| `down` | Two or more consecutive failures |
| `ignored` | Manually excluded; FSM never overrides this |

#### Transition rules (noise suppression)

- New devices remain in `unknown` for the first **90 seconds** to prevent startup flapping.
- `up` → `degraded` on the first failure (not straight to `down`).
- Any state → `down` requires **2 consecutive** failures.
- `down` → `degraded` on the first success; `down` → `up` on 2 consecutive successes.
- `degraded` → `up` on 2 consecutive successes; `degraded` → `down` on 2 consecutive failures.

#### On state transition the FSM:
1. Updates `devices.state` and `devices.last_seen` in SQLite.
2. Inserts a row in `state_history`.
3. Sends an `Event` on `eventCh` (picked up by `main.go`).

---

### Poller — `internal/poller/poller.go`

Two concurrent loops started by `Run(ctx, db, subnet, fsm, eventCh, broadcast)`:

#### Discovery loop

- Default interval: **300 s** (configurable via `discovery_interval_s` setting).
- Runs once immediately on startup.
- Calls `discovery.Run` → ICMP flood + ARP cache read.
- For each discovered device: classifies if type is still `generic`, then calls `fsm.EnsureDevice`.

#### Heartbeat loop

- Fixed interval: **30 seconds**.
- For each MAC known to the FSM (excluding `ignored` and placeholder `0.0.0.0`):
  1. `checkDevice(ctx, ip, dtype)` — ICMP ping; TCP fallback on a type-appropriate port.
  2. `fsm.Record(mac, ok, latencyMs)` — may trigger a transition event.
  3. Persist result to `check_results`; update `devices.last_latency_ms`.
  4. `broadcast(TypeLatencyUpdate, {...})` — real-time RTT push to browser.

#### TCP fallback ports

| Device type | Port |
|-------------|------|
| `router`, `switch`, `ap` | 443 |
| `server` | 22 |
| `printer` | 9100 |
| `nas` | 445 |
| *(default)* | 80 |

---

### Discovery — `internal/discovery/`

`Run(ctx, db, subnet)`:
1. Concurrent ICMP flood across all hosts in the subnet (OS-specific via build tags).
2. Read OS ARP cache — warm after the ping flood.
3. Reverse DNS lookup for hostnames.
4. Upsert each device into `devices` (MAC = primary key; preserves existing label/type/group/notes).

---

### Classifier — `internal/classifier/classifier.go`

`Classify(ctx, ip, vendor) string`:
1. OUI vendor string matching against known prefixes (e.g. "Cisco" → `router`, "Synology" → `nas`, "Ubiquiti" → `ap`).
2. TCP port probing on characteristic ports (22, 80, 443, 445, 554, 9100, etc.) to infer type from which ports respond.
3. Returns `"generic"` if neither method resolves a type.

Recognised types: `router`, `switch`, `ap`, `server`, `nas`, `printer`, `camera`, `isp`, `firewall`, `phone`, `workstation`, `laptop`, `tv`, `generic`.

---

### License — `internal/license/`

Offline RSA-signed JWT validation. The public key is embedded at compile time. The agent never phones home to validate a key — validation is entirely local.

- Free tier: 25 device limit.
- Pro tier: unlimited devices. Required for webhook / Slack notifications.

---

### Notify — `internal/notify/`

`Notifier.Send(cfg, mac, label, from, to, at)` fires asynchronously (goroutine) to avoid blocking the FSM event loop. Supports generic JSON webhooks and Slack Incoming Webhooks natively.

---

## Frontend

See **FRONTEND.md** for component-level detail.

```
App.tsx  (root — all shared state lives here)
 ├─ WebSocket connection  → drives devices / groups / edges / workspaces state
 ├─ REST calls            → CRUD mutations, settings, license
 │
 ├─ WorkspaceTabs         → tab bar + breadcrumb back button
 ├─ DeviceList            → left sidebar, filter, drag source
 ├─ TopologyMap           → Cytoscape canvas, edge toolbar, group overlay
 ├─ DevicePanel           → right slide-in panel, notes, downtime history
 └─ SettingsModal         → license key entry + notification URL config
```

---

## Data Flow: Device State Change

```
heartbeat tick (30 s)
  │
  ▼
poller.checkDevice(ip, type)
  │
  ├─ ICMP ok ─────────────────────────────────────────────┐
  │                                                        │
  └─ ICMP fail → TCP fallback → ok / fail ──────────►  fsm.Record(mac, ok, latencyMs)
                                                          │
                                            ┌─────────────┤ no state change → no event
                                            │             │
                                            │             └─ state changed
                                            │                 ├─ UPDATE devices
                                            │                 ├─ INSERT state_history
                                            │                 └─ eventCh <- Event
                                            ▼
                                  main.go goroutine
                                            │
                                  ┌─────────┴──────────┐
                                  │                     │
                              hub.Broadcast         notifier.Send
                           TypeStateChange         (Pro tier only)
                                  │
                                  └─► all WebSocket clients
                                              │
                                              ▼
                                       App.tsx handleMessage
                                         ├─ update device state
                                         ├─ browser Notification API
                                         └─ Cytoscape node re-style
```

---

## Data Flow: Initial WebSocket Hydration

```
Browser opens /ws
  │
  ▼
hub.go: Upgrade → buildSnapshot(db)
  │    ├─ SELECT all devices (with workspace positions)
  │    ├─ SELECT all custom_edges
  │    ├─ SELECT all groups
  │    └─ SELECT all workspaces
  │
  └─► TypeSnapshot envelope → client
          │
          ▼
     App.tsx handleMessage('snapshot')
       ├─ setDevices(payload.devices)
       ├─ setCustomEdges(payload.edges)
       ├─ setGroups(payload.groups)
       └─ setWorkspaces(payload.workspaces)
```

After hydration, only delta envelopes arrive: `state_change`, `latency_update`, `device_added`, `device_updated`, `device_removed`.

---

## Build Tags

| Tag | Effect |
|-----|--------|
| `embedui` | `server_embed.go` active — embeds `internal/api/ui_static/` and serves it |
| *(absent)* | `server_noembed.go` active — returns dev placeholder HTML for `/` |
