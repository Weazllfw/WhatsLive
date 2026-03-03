# WhatsLive — API Reference

All endpoints are served by the embedded Gin HTTP server. The default base URL is `http://<host>:8080`.

---

## WebSocket

### `GET /ws`

Upgrades to a WebSocket connection. The server immediately sends a `snapshot` envelope containing the full current state, then pushes delta envelopes as changes occur.

#### Envelope format

```json
{
  "type": "snapshot",
  "v": 1,
  "payload": { ... }
}
```

#### Envelope types

| `type` | Direction | Description |
|--------|-----------|-------------|
| `snapshot` | server → client | Full state on connect |
| `state_change` | server → client | Device availability transition |
| `latency_update` | server → client | Real-time ping RTT update |
| `device_added` | server → client | New device discovered or created |
| `device_updated` | server → client | Device label / type / group / notes changed |
| `device_removed` | server → client | Device deleted |

#### `snapshot` payload

```json
{
  "devices":    [ ...Device ],
  "edges":      [ ...CustomEdge ],
  "groups":     [ ...Group ],
  "workspaces": [ ...Workspace ]
}
```

#### `state_change` payload

```json
{
  "device_mac": "aa:bb:cc:dd:ee:ff",
  "state":      "down",
  "at":         "2026-03-02T14:00:00Z",
  "latency_ms": 0
}
```

#### `latency_update` payload

```json
{
  "device_mac": "aa:bb:cc:dd:ee:ff",
  "latency_ms": 4
}
```

---

## Setup

### `GET /api/status`

Returns whether the agent is configured with a subnet.

**Response `200`**

```json
{ "ok": true, "has_subnet": true, "subnet": "192.168.1.0/24" }
```

If `has_subnet` is `false`, the frontend shows the setup page.

---

### `POST /api/setup`

Saves the subnet and starts the poller. Called once on first run.

**Request body**

```json
{ "subnet": "192.168.1.0/24" }
```

**Response `200`**

```json
{ "ok": true, "subnet": "192.168.1.0/24" }
```

---

## Devices

### `GET /api/devices`

Returns all devices.

**Response `200`**

```json
[
  {
    "mac":           "aa:bb:cc:dd:ee:ff",
    "ip":            "192.168.1.1",
    "hostname":      "router.local",
    "vendor":        "Cisco Systems",
    "label":         "Main Router",
    "device_type":   "router",
    "state":         "up",
    "hidden":        false,
    "group_id":      null,
    "is_custom":     false,
    "notes":         "",
    "latency_ms":    3,
    "first_seen":    "2026-03-01T10:00:00Z",
    "last_seen":     "2026-03-02T14:00:00Z",
    "pos_x":         320.5,
    "pos_y":         180.0
  }
]
```

---

### `POST /api/devices`

Creates a custom (non-discovered) device.

**Request body**

```json
{
  "label":       "Office Printer",
  "device_type": "printer",
  "ip":          "192.168.1.50"
}
```

`ip` is the monitoring target. `label` is required.

**Response `201`** — created device object.

**Response `403`** — device limit reached (free tier, 25 devices).

---

### `PATCH /api/devices/:mac`

Updates an existing device.

**Request body** (all fields optional)

```json
{
  "label":       "Main Switch",
  "device_type": "switch",
  "ip":          "192.168.1.2",
  "notes":       "Cisco SG350, closet rack",
  "state":       "ignored",
  "group_id":    1
}
```

Setting `group_id` to `null` removes the device from its group.

**Response `200`** — updated device object.

---

### `DELETE /api/devices/:mac`

Removes a device and all associated positions and history.

**Response `204`**

---

### `PUT /api/devices/:mac/position`

Saves the node position for the Overview (default) workspace.

**Request body**

```json
{ "x": 320.5, "y": 180.0 }
```

**Response `200`**

---

### `PUT /api/devices/:mac/visibility`

Toggles the map visibility of a device (hidden devices are still monitored).

**Request body**

```json
{ "hidden": true }
```

**Response `200`**

---

### `GET /api/devices/:mac/history`

Returns state transition history for a device, most recent first.

**Response `200`**

```json
[
  {
    "from_state": "up",
    "to_state":   "down",
    "at":         "2026-03-02T14:00:00Z"
  }
]
```

---

## Groups

### `GET /api/groups`

Returns all groups.

**Response `200`**

```json
[
  {
    "id":    1,
    "name":  "VLAN 1",
    "color": "#3b82f6",
    "x":     null,
    "y":     null
  }
]
```

Note: group membership is managed by setting `group_id` on devices via `PATCH /api/devices/:mac`.

---

### `POST /api/groups`

**Request body**

```json
{ "name": "VLAN 1", "color": "#3b82f6" }
```

**Response `201`** — created group object.

---

### `PUT /api/groups/:id`

**Request body** (all optional)

```json
{ "name": "Server Room", "color": "#10b981" }
```

**Response `200`**

---

### `DELETE /api/groups/:id`

Deletes the group. Member devices have their `group_id` set to null automatically.

**Response `204`**

---

## Custom Edges

### `GET /api/edges`

Returns all user-drawn connections.

**Response `200`**

```json
[
  {
    "id":         1,
    "source_mac": "aa:bb:cc:dd:ee:ff",
    "target_mac": "grp:2",
    "label":      "uplink"
  }
]
```

`source_mac` and `target_mac` are either a device MAC address or `grp:{id}` for a group node. Edge colours are not persisted server-side; they are stored in the browser.

---

### `POST /api/edges`

**Request body**

```json
{
  "source_mac": "aa:bb:cc:dd:ee:ff",
  "target_mac": "11:22:33:44:55:66",
  "label":      ""
}
```

**Response `201`** — created edge object.

---

### `PATCH /api/edges/:id`

**Request body** (all optional)

```json
{ "label": "WAN uplink" }
```

**Response `200`**

---

### `DELETE /api/edges/:id`

**Response `204`**

---

## Workspaces

### `GET /api/workspaces`

**Response `200`**

```json
[
  {
    "id":         1,
    "name":       "Overview",
    "group_id":   null,
    "sort_order": 0
  },
  {
    "id":         2,
    "name":       "VLAN 1",
    "group_id":   1,
    "sort_order": 1
  }
]
```

A workspace with `group_id` set shows only devices belonging to that group.

---

### `POST /api/workspaces`

**Request body**

```json
{ "name": "Server Room", "group_id": 2 }
```

**Response `201`**

---

### `PUT /api/workspaces/:id`

**Request body**

```json
{ "name": "Renamed" }
```

**Response `200`**

---

### `DELETE /api/workspaces/:id`

The Overview workspace (id 1) cannot be deleted.

**Response `204`**

---

## Workspace Positions

### `GET /api/workspaces/:id/positions`

Returns all saved node positions for a workspace.

**Response `200`**

```json
{
  "aa:bb:cc:dd:ee:ff": { "x": 320.5, "y": 180.0 }
}
```

---

### `PUT /api/workspaces/:id/devices/:mac/position`

Saves the position of a single node within a workspace.

**Request body**

```json
{ "x": 320.5, "y": 180.0 }
```

**Response `200`**

---

## License

### `GET /api/license`

**Response `200`**

```json
{
  "tier":         "free",
  "valid":        false,
  "device_limit": 25,
  "device_count": 12,
  "tenant_id":    null,
  "expires_at":   null
}
```

`device_limit` is `-1` for unlimited (Pro tier).

---

### `POST /api/license`

Applies a license key. Validates the RSA-JWT signature offline.

**Request body**

```json
{ "key": "eyJ..." }
```

**Response `200`** — updated license info object.

**Response `400`** — invalid or expired key.

---

### `DELETE /api/license`

Clears the active license key (reverts to free tier).

**Response `204`**

---

## Notifications

### `GET /api/notifications`

**Response `200`**

```json
{
  "webhook_url":       "https://example.com/hook",
  "slack_webhook_url": ""
}
```

---

### `PUT /api/notifications`

**Request body**

```json
{
  "webhook_url":       "https://example.com/hook",
  "slack_webhook_url": "https://hooks.slack.com/services/..."
}
```

**Response `200`**

---

### `POST /api/notifications/test`

Fires a test payload to both configured URLs. Requires Pro license and at least one URL configured.

**Response `200`**

```json
{ "ok": true }
```

**Response `400`** — Pro license required, or no URLs configured.
