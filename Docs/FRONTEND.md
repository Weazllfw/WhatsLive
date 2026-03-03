# WhatsLive — Frontend Reference

The frontend is a React + TypeScript single-page application built with Vite. In production it is compiled to `internal/api/ui_static/` and embedded directly into the Go binary via `go:embed`. In development it runs on `:5173` and proxies `/api` and `/ws` to the Go server on `:8080`.

---

## Component Tree

```
App.tsx  ← root; owns all shared state
 │
 ├─ SetupPage            Shown on first run if subnet is not configured
 │
 ├─ ConnectionBanner     Reconnecting indicator (shown when WS is disconnected)
 │
 ├─ WorkspaceTabs        Tab bar across the top; breadcrumb back button for group workspaces
 │
 ├─ DeviceList           Left sidebar — searchable device list; drag source for adding to map
 │
 ├─ TopologyMap          Cytoscape.js canvas — the main interactive map
 │   ├─ Group overlay    Background rect behind grouped nodes
 │   ├─ Edge toolbar     Floating bar on selected edge (colour picker, label, delete)
 │   └─ Scale overlay    Resize handle (currently reserved)
 │
 ├─ DevicePanel          Right slide-in panel; shown when a node is selected
 │   ├─ Edit fields      Label, device type, IP override
 │   ├─ Notes            Free-text notes textarea
 │   ├─ Latency          Last measured ping RTT
 │   └─ State history    Chronological DOWN/DEGRADED/UP event log
 │
 └─ SettingsModal        Full-screen modal; license key entry + notification config
```

---

## State Management

All shared state lives in `App.tsx`. There is no Redux or Zustand — React hooks only.

| State variable | Type | Source |
|----------------|------|--------|
| `devices` | `Device[]` | WebSocket snapshot + delta envelopes |
| `groups` | `Group[]` | WebSocket snapshot + REST mutations |
| `customEdges` | `CustomEdge[]` | WebSocket snapshot + REST mutations |
| `workspaces` | `Workspace[]` | WebSocket snapshot + REST mutations |
| `activeWorkspaceId` | `number` | `localStorage` |
| `selectedNodeId` | `string \| null` | User click |
| `darkMode` | `boolean` | `localStorage` |
| `licInfo` | `LicenseInfo \| null` | REST `GET /api/license` on mount |
| `showSettings` | `boolean` | Header settings button |

---

## WebSocket Hook — `useWebSocket.ts`

Manages the WebSocket lifecycle:
- Opens `ws://<host>/ws` on mount.
- Reconnects with exponential backoff on disconnect.
- Dispatches incoming envelopes to `App.tsx` via the `onMessage` callback.
- Exposes `send(envelope)` for future client-to-server messages.

---

## Theme Hook — `useTheme.ts`

Reads and persists `darkMode` in `localStorage`. Applies `data-theme="dark"` to `<html>` which activates the dark CSS custom property set.

---

## Cytoscape Map — `TopologyMap.tsx`

### Initialisation

On mount, a `cytoscape` instance is created with:
- Custom node stylesheet (SVG icons, state-based border/shadow colours, text outlines).
- Compound node support for groups.
- Pointer event handlers: `tap` (select node), `taphold` (deselect), `tapstart` on edge (show edge toolbar).

### Node rendering

Each device is rendered as a Cytoscape node:

```
{
  data: {
    id:         mac,
    label:      device.label || device.hostname || device.ip,
    type:       device.device_type,
    state:      device.state,
    latency:    device.last_latency_ms,
    parent:     device.group_id ? `group:${device.group_id}` : undefined
  }
}
```

The node icon is a `lucide-react` SVG rendered to a `data:image/svg+xml` URI and applied as a Cytoscape `background-image`.

State → border colour mapping:
| State | Border | Shadow |
|-------|--------|--------|
| `up` | `#22c55e` | green glow |
| `degraded` | `#f59e0b` | amber glow |
| `down` | `#ef4444` | red glow |
| `unknown` | `#6b7280` | none |
| `ignored` | `#374151` | none |

### Position persistence

After any drag event, `TopologyMap` calls `PUT /api/positions/:workspaceId` with the current positions of all nodes. Positions are restored from the snapshot on mount and applied before the initial render to prevent layout flash.

### Edge drawing

Custom edges are drawn as Cytoscape edges. The user initiates edge creation from the DevicePanel. Edges are styled with the user-chosen colour and rendered with the optional text label.

---

## DevicePanel — `DevicePanel.tsx`

Slides in from the right when a node is selected. Sections:

1. **Header** — device label, type icon, state badge, latency badge.
2. **Edit** — inline fields for label, device type dropdown, IP override.
3. **Connection toggles** — per-device toggle to show/hide auto-generated connection lines.
4. **Notes** — `<textarea>` with auto-save on blur.
5. **State history** — `GET /api/devices/:mac/history` on open; rendered as a timeline list.
6. **Danger zone** — delete device button.

---

## WorkspaceTabs — `WorkspaceTabs.tsx`

- Tab bar renders one button per workspace.
- Active workspace tab is highlighted.
- "+" button opens a dialog to create a new workspace (name + optional group link).
- If the active workspace has a `group_id`, a breadcrumb back button appears: clicking it returns to the Overview workspace.
- Clicking on the canvas background in a group workspace also returns to Overview.

---

## SettingsModal — `SettingsModal.tsx`

Two tabs:

### License tab
- Shows current tier, device count, and limit.
- Free tier: text input to paste a Pro license key + "Activate" button.
- Pro tier: shows tenant ID, expiry date, and a "Remove license" button.

### Notifications tab
- Fields for generic webhook URL and Slack webhook URL.
- "Save" persists via `PUT /api/notifications`.
- "Send test" fires `POST /api/notifications/test`.
- Gated behind a Pro tier check — inputs are disabled with an upgrade prompt if on free tier.

---

## CSS Architecture — `index.css`

All colours are CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark). No CSS-in-JS, no Tailwind.

Key custom properties:

```css
--bg-primary      /* main canvas background */
--bg-secondary    /* sidebar / panel background */
--bg-elevated     /* cards, modals */
--border          /* subtle dividers */
--text-primary    /* body text */
--text-secondary  /* labels, hints */
--accent          /* interactive elements, active tabs */
--state-up        /* #22c55e */
--state-degraded  /* #f59e0b */
--state-down      /* #ef4444*/
```

---

## TypeScript Types — `types.ts`

Mirror of the Go `ws/types.go` structs. Key interfaces:

```typescript
interface Device {
  mac:         string;
  ip:          string;
  hostname:    string;
  vendor:      string;
  label:       string;
  device_type: string;
  state:       string;        // "unknown" | "up" | "degraded" | "down" | "ignored"
  hidden:      boolean;
  group_id:    number | null;
  is_custom:   boolean;
  notes:       string;
  latency_ms?: number;        // omitted if not yet measured
  first_seen:  string;        // RFC3339
  last_seen:   string;        // RFC3339
  pos_x?:      number;        // omitted if no saved position
  pos_y?:      number;
}

interface Group {
  id:    number;
  name:  string;
  color: string;
  x?:    number;
  y?:    number;
}

interface CustomEdge {
  id:         number;
  source_mac: string;   // MAC address or "grp:{id}"
  target_mac: string;
  label:      string;
  // Note: edge colour is stored in localStorage, not in the database
}

interface Workspace {
  id:         number;
  name:       string;
  group_id:   number | null;
  sort_order: number;
}

interface LicenseInfo {
  tier:         'free' | 'pro';
  valid:        boolean;
  device_limit: number;   // -1 = unlimited
  device_count: number;
  tenant_id?:   string;
  expires_at?:  string;
}
```
