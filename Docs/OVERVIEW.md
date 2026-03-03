# WhatsLive — Project Overview

> Last updated: 2026-03-03

WhatsLive is a self-hosted, single-binary network topology monitor for small business and home-lab environments. It auto-discovers every device on a LAN, tracks availability with a debounced state machine, and presents a live drag-and-drop visual map in the browser. It requires no cloud account, no separate database server, and no runtime dependencies beyond the binary itself.

---

## Goals

| Goal | Description |
|------|-------------|
| Zero-friction install | One binary, one command. Subnet entered via a web form on first run. |
| Always-on visibility | 30-second heartbeat per device; 5-minute discovery sweep for new arrivals. |
| Honest state model | Debounced FSM — a single missed ping does not trigger a DOWN alert. |
| Portable | Pure-Go SQLite (no CGO). Cross-compiles to Linux and Windows from any host. |
| LAN-first | Binds `0.0.0.0:8080` by default; works from a second monitor or a remote browser on the same network. |

---

## Technology Stack

### Backend (Go)

| Concern | Package |
|---------|---------|
| HTTP / REST API | `github.com/gin-gonic/gin` |
| WebSocket hub | `github.com/gorilla/websocket` |
| Database | `modernc.org/sqlite` (pure Go, no CGO) |
| Migrations | `github.com/pressly/goose/v3` (SQL files embedded in binary) |
| ICMP ping | `github.com/prometheus-community/pro-bing` |
| Windows Service | `golang.org/x/sys/windows/svc` |
| Static UI embed | `go:embed` directive, activated by `embedui` build tag |

### Frontend (React + TypeScript)

| Concern | Package |
|---------|---------|
| Bundler | Vite |
| Graph canvas | `cytoscape` |
| Node icons | `lucide-react` (rendered to SVG data-URIs via `renderToStaticMarkup`) |
| Styling | Plain CSS with CSS custom properties (light / dark theme) |

---

## Repository Layout

```
WhatsLive/
├── cmd/
│   └── agent/                  Entry point + Windows Service wrappers
│       ├── main.go
│       ├── service_windows.go
│       ├── service_stub.go         (non-Windows build stub)
│       └── service_commands_windows.go
│
├── internal/
│   ├── api/                    HTTP + WebSocket server (Gin)
│   │   ├── server.go           Route registration and all REST handlers
│   │   ├── hub.go              WebSocket broadcast hub
│   │   ├── server_embed.go     (build tag: embedui) serves compiled React UI
│   │   └── server_noembed.go   (build tag: !embedui) dev proxy placeholder
│   │
│   ├── db/                     Database open + migration runner
│   │   ├── db.go
│   │   └── migrations/
│   │       ├── 001_initial.sql
│   │       ├── 002_custom.sql
│   │       ├── 003_custom_devices.sql
│   │       ├── 004_workspaces.sql
│   │       └── 005_enhancements.sql
│   │
│   ├── state/
│   │   └── fsm.go              Per-device availability FSM
│   │
│   ├── poller/
│   │   ├── poller.go           Heartbeat + discovery scheduler
│   │   ├── icmp_windows.go
│   │   └── icmp_linux.go
│   │
│   ├── discovery/              One-shot subnet sweep
│   │   ├── discovery.go
│   │   ├── arp_windows.go
│   │   ├── arp_linux.go
│   │   ├── icmp_windows.go
│   │   └── icmp_linux.go
│   │
│   ├── classifier/
│   │   └── classifier.go       Infers device type from MAC OUI + TCP port probing
│   │
│   ├── license/
│   │   └── license.go          Offline RSA-signed JWT license validation
│   │
│   ├── notify/
│   │   └── notify.go           Webhook + Slack notification sender
│   │
│   └── ws/
│       └── types.go            Canonical WebSocket envelope and payload structs
│
├── ui/                         React + TypeScript frontend (Vite)
│   └── src/
│       ├── App.tsx             Root component; owns all shared state
│       ├── types.ts            TypeScript interfaces mirroring ws/types.go
│       ├── index.css           Global CSS + theme custom properties
│       └── components/
│           ├── TopologyMap.tsx     Cytoscape canvas + edge toolbar
│           ├── DevicePanel.tsx     Side panel (edit, notes, state history)
│           ├── DeviceList.tsx      Left sidebar device list
│           ├── WorkspaceTabs.tsx   Tab bar + breadcrumb navigation
│           ├── SettingsModal.tsx   License + notification settings
│           └── GroupNameModal.tsx  Create/rename group dialog
│
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose.dev.yml
│
├── .github/
│   └── workflows/
│       ├── ci.yml              Vet + test on every push/PR
│       └── release.yml         Build binaries + Docker image on vX.Y.Z tag
│
├── Docs/
│   └── Assets/                 Logo and favicon assets
│
├── Makefile
├── go.mod
├── LICENSE
└── README.md
```

---

## Key Design Decisions

1. **MAC address as primary key.** Devices can change IPs via DHCP; MAC is the stable identity. MAC randomisation (modern mobile OSes) creates a new entry — treated as a known limitation, documented publicly.

2. **Pure-Go SQLite.** `modernc.org/sqlite` is a transpiled port of the real SQLite C source. No CGO means cross-compilation works on any host without a C toolchain. Driver name is `"sqlite"` not `"sqlite3"`.

3. **Goose migrations.** SQL migration files are embedded in the binary. Applied automatically and idempotently on startup. Sequential numbered files ensure a clean upgrade path.

4. **Debounced FSM.** A device must fail ≥ 2 consecutive 30-second checks before reaching `down`. A single failure from `up` moves to `degraded` first. This materially reduces alert fatigue from transient packet loss.

5. **WebSocket-first UI.** On connect the server sends a full `snapshot` envelope containing all devices, groups, edges, and workspaces. All subsequent changes are pushed as targeted delta envelopes. The browser never polls.

6. **`go:embed` single binary.** The production binary embeds the compiled React app. The `embedui` build tag activates `server_embed.go`; without it `server_noembed.go` proxies to the Vite dev server.

---

## Development Quick-Start

### Prerequisites

- Go 1.22+
- Node 20+
- Windows: run as Administrator (ICMP requires raw sockets)
- Linux: `sudo` or `CAP_NET_RAW` capability

### Run in development mode

```bash
# Terminal 1 — Go backend (air hot-reload)
make run-dev SUBNET=192.168.1.0/24

# Terminal 2 — Vite dev server (proxies /api and /ws to :8080)
make ui-dev
```

Open `http://localhost:5173`.

### Build a self-contained binary

```bash
make build-native          # current platform
make build-agent-linux     # cross-compile → dist/whatslive-linux-amd64
make build-agent-windows   # cross-compile → dist/whatslive-windows-amd64.exe
```
