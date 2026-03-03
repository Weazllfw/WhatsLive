# WhatsLive

**Live network topology for small business IT. One binary, no cloud required.**

WhatsLive auto-discovers every device on your LAN, classifies it (router, switch, server, camera, etc.), runs continuous availability checks, and shows a real-time colour-coded topology map in your browser.

Know your network is working before employees tell you it's broken.

![WhatsLive topology map showing grouped devices, live status indicators, and custom connections](Docs/Assets/Screenshot%202026-03-03%20170946.png)

---

## Background

I spent years as a systems administrator for small and medium businesses. Every time something went down, I found out the same way: someone walked over and told me.

The monitoring tools I tried were either priced for enterprise IT departments (WhatsUp Gold, PRTG, SolarWinds) or required a serious time investment just to get running (Zabbix, LibreNMS, Nagios). Neither was a good fit for a small environment where you just need to know what's up and what's down.

What I wanted was simple: open a browser, see my network, see what's green and what's red, drag the icons into a layout that matched reality, and leave it running.

WhatsLive is what I built. Drop the binary on any machine, point it at a subnet, open the browser. It finds everything on the LAN, draws the map, and starts monitoring. No agents, no database server, no config files.

It doesn't do SNMP, bandwidth graphs, or compliance reports. It does the one thing the other tools made too complicated: tell you at a glance whether your network is working.

---

## Features

- **Auto-discovery**: subnet sweep every 5 minutes finds new devices automatically
- **Live status map**: Cytoscape.js topology with green / amber / red status, real-time updates via WebSocket
- **Device classification**: router, switch, firewall, server, workstation, laptop, camera, phone, ISP, TV and more; inferred from MAC OUI + TCP port probing
- **Drag-and-drop layout**: arrange nodes to match your physical network; positions persist across restarts and scans
- **Groups and workspaces**: group devices visually, create per-group workspace tabs for focused views
- **Custom devices**: add devices that are not auto-discovered (static IPs, cloud endpoints, etc.)
- **Custom connections**: draw labelled lines between any two nodes
- **Downtime history**: per-device state-change log viewable in the side panel
- **Browser notifications**: alert when any device transitions to DOWN or DEGRADED
- **Response latency**: last measured ping RTT displayed on nodes and in the device panel
- **Notes per device**: free-text notes attached to any node, persisted in the database
- **Single binary**: Go binary embeds the entire React UI via `go:embed`; no Node, no separate web server
- **No CGO**: uses `modernc.org/sqlite` (pure Go); builds and runs on Windows without a C toolchain
- **Windows Service**: installs as a native Windows service running as LocalSystem
- **Dark / light mode**: toggle from the header

---

## Quick Start — Docker

```bash
docker run -d \
  --name whatslive \
  --network host \
  --cap-add NET_RAW \
  -e SUBNET=192.168.1.0/24 \
  -v whatslive-data:/data \
  ghcr.io/weazllfw/whatslive:latest
```

Then open **http://[host-ip]:8080**.

> `--network host` lets the agent see LAN traffic.  
> `--cap-add NET_RAW` is required for ICMP ping. Some hardened environments strip this — WhatsLive falls back to TCP-only checks automatically if ICMP is unavailable.

Or with Docker Compose:

```bash
SUBNET=192.168.1.0/24 docker compose -f deploy/docker-compose.yml up -d
```

---

## Quick Start — Windows

1. Download `whatslive-windows-amd64.exe` from the [Releases](https://github.com/weazllfw/whatslive/releases) page
2. Run as **Administrator**
3. Enter your subnet when prompted (e.g. `192.168.1.0/24`)
4. The agent installs as a Windows Service and starts automatically
5. Open **http://localhost:8080** — or `http://[machine-ip]:8080` from any machine on the LAN

Add a Windows Firewall inbound rule for TCP port 8080 if you want LAN-wide access.

---

## Quick Start — Linux binary

```bash
curl -L https://github.com/weazllfw/whatslive/releases/latest/download/whatslive-linux-amd64 \
  -o whatslive && chmod +x whatslive
sudo ./whatslive --subnet 192.168.1.0/24
```

Open **http://[host-ip]:8080**.

> Linux requires `sudo` (or `CAP_NET_RAW`) for ICMP.

---

## Build from Source

```bash
git clone https://github.com/weazllfw/whatslive
cd whatslive

# Full production build (React UI embedded into Go binary)
make build-all
# → dist/whatslive-linux-amd64
# → dist/whatslive-windows-amd64.exe

# Development run (hot-reload UI via Vite, no embed)
make run-dev SUBNET=192.168.1.0/24
```

**Requirements:** Go 1.22+, Node 20+ (only needed for `build-all` or `run-dev`).

---

## Configuration

All settings are stored in the SQLite database and configurable through the web UI. The `--subnet` CLI flag and `SUBNET` environment variable override the database value on startup.

| Key | Default | Description |
|-----|---------|-------------|
| `subnet` | (prompted on first run) | CIDR range to scan, e.g. `192.168.1.0/24` |
| `discovery_interval_s` | `300` | Full subnet sweep interval in seconds |
| `heartbeat_interval_s` | `30` | Per-device ping interval in seconds |
| `bind_addr` | `0.0.0.0:8080` | HTTP server bind address |

---

## Database Maintenance

WhatsLive stores all state in a single SQLite file (`whatslive.db`). Most data is bounded, but the `check_results` table grows continuously with raw ping results.

**Growth rate:** at the default 30-second heartbeat, 50 devices generates roughly 5,000 rows per day. The poller automatically prunes rows older than 30 days on every discovery cycle (every 5 minutes), so the table stays bounded in normal operation. If you need to reclaim space manually:

```sql
DELETE FROM check_results WHERE checked_at < datetime('now', '-30 days');
VACUUM;
```

---

## Architecture

```
whatslive (single Go binary)
├── embeds React UI via go:embed
├── SQLite database (modernc.org/sqlite, no CGO)
├── ICMP + TCP heartbeat every 30 s per device
├── Full subnet discovery every 5 min
└── WebSocket push to browser for real-time map updates
```

Full documentation is in the [`Docs/`](Docs/) folder:

- [OVERVIEW.md](Docs/OVERVIEW.md) — goals, tech stack, repo layout, design decisions
- [ARCHITECTURE.md](Docs/ARCHITECTURE.md) — component breakdown, data flows, build tags
- [API.md](Docs/API.md) — all REST endpoints + WebSocket envelope reference
- [DATABASE.md](Docs/DATABASE.md) — schema, migrations, settings table
- [FRONTEND.md](Docs/FRONTEND.md) — component tree, state management, CSS architecture

---

## Notifications (Webhooks)

WhatsLive can POST a JSON payload to any URL when a device changes state:

```json
{
  "mac":        "aa:bb:cc:dd:ee:ff",
  "label":      "Office NAS",
  "from_state": "UP",
  "to_state":   "DOWN",
  "at":         "2026-03-02T14:00:00Z"
}
```

Slack incoming webhooks are supported natively. Configure both in **Settings → Notifications**.

---

## Contributing

Issues and PRs are welcome. The codebase is intentionally small and self-contained — no CGO, no external databases, no microservices.

1. Fork and clone
2. `make run-dev SUBNET=your.subnet/24`
3. UI hot-reloads at `http://localhost:5173`, API at `:8080`

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built by [IT Marshall](https://itmarshall.net)*
