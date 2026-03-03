package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"math/rand"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	dbpkg "github.com/weazllfw/whatslive/internal/db"
	"github.com/weazllfw/whatslive/internal/license"
	"github.com/weazllfw/whatslive/internal/state"
	"github.com/weazllfw/whatslive/internal/ws"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// StartupFunc is called after the server is configured but before it binds.
// Used by main to trigger a first discovery run when a subnet is submitted.
type StartupFunc func(subnet string)

// Server holds runtime state shared across HTTP handlers.
type Server struct {
	db      *sql.DB
	hub     *Hub
	fsm     *state.Machine
	onSetup StartupFunc
	lic     *license.Manager
}

// New creates a Server.
func New(db *sql.DB, hub *Hub, fsm *state.Machine, onSetup StartupFunc, lic *license.Manager) *Server {
	return &Server{db: db, hub: hub, fsm: fsm, onSetup: onSetup, lic: lic}
}

// Run configures Gin routes and listens on addr until an error occurs.
func (s *Server) Run(addr string) error {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// API routes.
	api := r.Group("/api")
	{
		api.GET("/status",  s.handleStatus)
		api.POST("/setup",  s.handleSetup)

		// Devices
		api.GET("/devices",                  s.handleDevices)
		api.POST("/devices",                 s.handleCreateDevice)
		api.PATCH("/devices/:mac",           s.handleUpdateDevice)
		api.DELETE("/devices/:mac",          s.handleDeleteDevice)
		api.PUT("/devices/:mac/position",    s.handleSetPosition)
		api.PUT("/devices/:mac/visibility",  s.handleSetVisibility)

		// Custom edges
		api.GET("/edges",          s.handleGetEdges)
		api.POST("/edges",         s.handleCreateEdge)
		api.PATCH("/edges/:id",    s.handleUpdateEdge)
		api.DELETE("/edges/:id",   s.handleDeleteEdge)

		// Device history
		api.GET("/devices/:mac/history", s.handleGetDeviceHistory)

		// Groups
		api.GET("/groups",       s.handleGetGroups)
		api.POST("/groups",      s.handleCreateGroup)
		api.PUT("/groups/:id",   s.handleUpdateGroup)
		api.DELETE("/groups/:id", s.handleDeleteGroup)

		// Workspaces
		api.GET("/workspaces",                                 s.handleGetWorkspaces)
		api.POST("/workspaces",                                s.handleCreateWorkspace)
		api.PUT("/workspaces/:id",                             s.handleUpdateWorkspace)
		api.DELETE("/workspaces/:id",                          s.handleDeleteWorkspace)
		api.GET("/workspaces/:id/positions",                   s.handleGetWorkspacePositions)
		api.PUT("/workspaces/:id/devices/:mac/position",       s.handleSetWorkspacePosition)

		// License
		api.GET("/license",    s.handleGetLicense)
		api.POST("/license",   s.handleApplyLicense)
		api.DELETE("/license", s.handleClearLicense)

		// Notification settings (webhook / Slack)
		api.GET("/notifications",  s.handleGetNotifications)
		api.PUT("/notifications",  s.handleSetNotifications)
		api.POST("/notifications/test", s.handleTestNotification)
	}

	// WebSocket endpoint.
	r.GET("/ws", s.handleWS)

	// Static UI — served from embedded FS or a dev placeholder.
	s.mountUI(r)

	log.Printf("server: listening on %s", addr)
	return r.Run(addr)
}

func (s *Server) handleStatus(c *gin.Context) {
	subnet, hasSubnet := dbpkg.Setting(s.db, "subnet")
	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"has_subnet": hasSubnet,
		"subnet":     subnet,
	})
}

func (s *Server) handleSetup(c *gin.Context) {
	var body struct {
		Subnet string `json:"subnet" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := dbpkg.SetSetting(s.db, "subnet", body.Subnet); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if s.onSetup != nil {
		go s.onSetup(body.Subnet)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "subnet": body.Subnet})
}

func (s *Server) handleDevices(c *gin.Context) {
	devices, err := queryDevices(s.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, devices)
}

func (s *Server) handleSetPosition(c *gin.Context) {
	mac := c.Param("mac")
	var body struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_, err := s.db.Exec(
		`INSERT INTO node_positions (device_mac, x, y) VALUES (?, ?, ?)
		 ON CONFLICT(device_mac) DO UPDATE SET x = excluded.x, y = excluded.y`,
		mac, body.X, body.Y,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleWS(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	snapshot, err := buildSnapshot(s.db)
	if err != nil {
		log.Printf("ws snapshot: %v", err)
		conn.Close()
		return
	}
	s.hub.Register(conn, snapshot)
}

// mountUI serves the embedded React build from / and /assets.
// If the embed FS is empty (dev mode), serves a one-line placeholder.
func (s *Server) mountUI(r *gin.Engine) {
	sub, err := fs.Sub(uiFS, "ui_static")
	if err != nil {
		// Dev mode: no embedded UI yet.
		r.GET("/", func(c *gin.Context) {
			c.Data(http.StatusOK, "text/html", []byte(devPlaceholder))
		})
		return
	}
	fileServer := http.FileServer(http.FS(sub))
	r.NoRoute(func(c *gin.Context) {
		// SPA: try the file; if 404, serve index.html.
		path := c.Request.URL.Path
		if _, err := fs.Stat(sub, path[1:]); err != nil {
			index, _ := fs.ReadFile(sub, "index.html")
			c.Data(http.StatusOK, "text/html", index)
			return
		}
		fileServer.ServeHTTP(c.Writer, c.Request)
	})
}

const devPlaceholder = `<!doctype html><html><body>
<h2>WhatsLive — dev mode</h2>
<p>Run <code>npm run build</code> in /ui then rebuild the binary to serve the UI.</p>
<p>WebSocket: <code>ws://` + `localhost:8080/ws</code></p>
</body></html>`

// --- database helpers ---

func queryDevices(db *sql.DB) ([]ws.Device, error) {
	rows, err := db.Query(`
		SELECT d.mac, d.ip, d.hostname, d.label, d.vendor, d.device_type,
		       d.state, d.hidden, d.group_id, d.is_custom,
		       d.notes, d.last_latency_ms,
		       d.first_seen, d.last_seen,
		       np.x, np.y
		FROM   devices d
		LEFT JOIN node_positions np ON np.device_mac = d.mac
		ORDER BY d.ip
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []ws.Device
	for rows.Next() {
		var d ws.Device
		var x, y sql.NullFloat64
		var groupID sql.NullInt64
		var latencyMs sql.NullInt64
		var hidden, isCustom int
		var firstSeen, lastSeen time.Time
		if err := rows.Scan(
			&d.MAC, &d.IP, &d.Hostname, &d.Label, &d.Vendor,
			&d.DeviceType, &d.State, &hidden, &groupID, &isCustom,
			&d.Notes, &latencyMs,
			&firstSeen, &lastSeen, &x, &y,
		); err != nil {
			return nil, err
		}
		d.Hidden    = hidden != 0
		d.IsCustom  = isCustom != 0
		d.FirstSeen = firstSeen.Format(time.RFC3339)
		d.LastSeen  = lastSeen.Format(time.RFC3339)
		if x.Valid         { d.PosX      = &x.Float64  }
		if y.Valid         { d.PosY      = &y.Float64  }
		if groupID.Valid   { d.GroupID   = &groupID.Int64 }
		if latencyMs.Valid { v := int(latencyMs.Int64); d.LatencyMs = &v }
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (s *Server) handleCreateDevice(c *gin.Context) {
	var body struct {
		Label      string `json:"label"       binding:"required"`
		IP         string `json:"ip"`
		DeviceType string `json:"device_type"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.DeviceType == "" { body.DeviceType = "generic" }
	if body.IP         == "" { body.IP         = "0.0.0.0" }

	// Enforce device cap.
	if s.lic != nil {
		limit := s.lic.DeviceLimit()
		if limit > 0 {
			var count int
			_ = s.db.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&count)
			if count >= limit {
				c.JSON(http.StatusForbidden, gin.H{
					"error": fmt.Sprintf("device limit of %d reached — upgrade to WhatsLive Pro to add more devices", limit),
					"limit_reached": true,
				})
				return
			}
		}
	}

	mac := fmt.Sprintf("custom-%08x", rand.Uint32())

	now := time.Now()
	_, err := s.db.Exec(
		`INSERT INTO devices (mac, ip, hostname, label, device_type, state, is_custom, first_seen, last_seen)
		 VALUES (?, ?, '', ?, ?, 'unknown', 1, ?, ?)`,
		mac, body.IP, body.Label, body.DeviceType, now, now,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Register with FSM so the heartbeat will monitor it (if IP is valid)
	if s.fsm != nil {
		s.fsm.EnsureDevice(mac)
	}

	devices, _ := queryDevices(s.db)
	for _, d := range devices {
		if d.MAC == mac {
			s.hub.Broadcast(ws.NewEnvelope(ws.TypeDeviceAdded, d))
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "mac": mac})
}

func (s *Server) handleDeleteDevice(c *gin.Context) {
	mac := c.Param("mac")

	var isCustom int
	err := s.db.QueryRow(`SELECT is_custom FROM devices WHERE mac = ?`, mac).Scan(&isCustom)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "device not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if isCustom == 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "only custom devices can be deleted"})
		return
	}

	s.db.Exec(`DELETE FROM node_positions WHERE device_mac = ?`, mac)
	s.db.Exec(`DELETE FROM custom_edges   WHERE source_mac = ? OR target_mac = ?`, mac, mac)
	s.db.Exec(`UPDATE devices SET group_id = NULL WHERE mac = ?`, mac)
	if _, err := s.db.Exec(`DELETE FROM devices WHERE mac = ?`, mac); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	s.hub.Broadcast(ws.NewEnvelope(ws.TypeDeviceRemoved, ws.DeviceRemovedPayload{MAC: mac}))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// --- device update handlers ---

func (s *Server) handleUpdateDevice(c *gin.Context) {
	mac := c.Param("mac")
	var body struct {
		Label      *string `json:"label"`
		DeviceType *string `json:"device_type"`
		GroupID    *any    `json:"group_id"` // null or int64
		IP         *string `json:"ip"`       // only honoured for custom devices
		Notes      *string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Label != nil {
		if _, err := s.db.Exec(`UPDATE devices SET label = ? WHERE mac = ?`, *body.Label, mac); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if body.DeviceType != nil {
		if _, err := s.db.Exec(`UPDATE devices SET device_type = ? WHERE mac = ?`, *body.DeviceType, mac); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if body.GroupID != nil {
		gid := *body.GroupID
		if _, err := s.db.Exec(`UPDATE devices SET group_id = ? WHERE mac = ?`, gid, mac); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if body.IP != nil {
		// IP updates are only allowed for manually-created devices
		var isCustom int
		s.db.QueryRow(`SELECT is_custom FROM devices WHERE mac = ?`, mac).Scan(&isCustom) //nolint:errcheck
		if isCustom == 1 {
			if _, err := s.db.Exec(`UPDATE devices SET ip = ? WHERE mac = ?`, *body.IP, mac); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			if s.fsm != nil {
				s.fsm.EnsureDevice(mac)
			}
		}
	}
	if body.Notes != nil {
		if _, err := s.db.Exec(`UPDATE devices SET notes = ? WHERE mac = ?`, *body.Notes, mac); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleSetVisibility(c *gin.Context) {
	mac := c.Param("mac")
	var body struct {
		Hidden bool `json:"hidden"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hidden := 0
	if body.Hidden {
		hidden = 1
	}
	if _, err := s.db.Exec(`UPDATE devices SET hidden = ? WHERE mac = ?`, hidden, mac); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// --- custom edge handlers ---

func (s *Server) handleGetEdges(c *gin.Context) {
	rows, err := s.db.Query(`SELECT id, source_mac, target_mac, color, label FROM custom_edges`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var edges []ws.CustomEdge
	for rows.Next() {
		var e ws.CustomEdge
		if err := rows.Scan(&e.ID, &e.SourceMAC, &e.TargetMAC, &e.Color, &e.Label); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		edges = append(edges, e)
	}
	if edges == nil {
		edges = []ws.CustomEdge{}
	}
	c.JSON(http.StatusOK, edges)
}

func (s *Server) handleCreateEdge(c *gin.Context) {
	var body struct {
		SourceMAC string `json:"source_mac" binding:"required"`
		TargetMAC string `json:"target_mac" binding:"required"`
		Color     string `json:"color"`
		Label     string `json:"label"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Color == "" {
		body.Color = "#7c3aed"
	}
	res, err := s.db.Exec(
		`INSERT OR IGNORE INTO custom_edges (source_mac, target_mac, color, label) VALUES (?, ?, ?, ?)`,
		body.SourceMAC, body.TargetMAC, body.Color, body.Label,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, ws.CustomEdge{ID: id, SourceMAC: body.SourceMAC, TargetMAC: body.TargetMAC, Color: body.Color, Label: body.Label})
}

func (s *Server) handleUpdateEdge(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Color *string `json:"color"`
		Label *string `json:"label"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Color != nil {
		if _, err := s.db.Exec(`UPDATE custom_edges SET color = ? WHERE id = ?`, *body.Color, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if body.Label != nil {
		if _, err := s.db.Exec(`UPDATE custom_edges SET label = ? WHERE id = ?`, *body.Label, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleDeleteEdge(c *gin.Context) {
	id := c.Param("id")
	if _, err := s.db.Exec(`DELETE FROM custom_edges WHERE id = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleGetDeviceHistory(c *gin.Context) {
	mac := c.Param("mac")
	rows, err := s.db.Query(
		`SELECT from_state, to_state, transitioned_at
		 FROM   state_history
		 WHERE  device_mac = ?
		 ORDER  BY transitioned_at DESC
		 LIMIT  25`,
		mac,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type HistoryEntry struct {
		FromState string `json:"from_state"`
		ToState   string `json:"to_state"`
		At        string `json:"at"`
	}
	var out []HistoryEntry
	for rows.Next() {
		var e HistoryEntry
		var at time.Time
		if err := rows.Scan(&e.FromState, &e.ToState, &at); err != nil {
			continue
		}
		e.At = at.Format(time.RFC3339)
		out = append(out, e)
	}
	if out == nil {
		out = []HistoryEntry{}
	}
	c.JSON(http.StatusOK, out)
}

// --- group handlers ---

func (s *Server) handleGetGroups(c *gin.Context) {
	rows, err := s.db.Query(`SELECT id, name, color, x, y FROM groups`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var groups []ws.Group
	for rows.Next() {
		var g ws.Group
		var x, y sql.NullFloat64
		if err := rows.Scan(&g.ID, &g.Name, &g.Color, &x, &y); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if x.Valid { g.X = &x.Float64 }
		if y.Valid { g.Y = &y.Float64 }
		groups = append(groups, g)
	}
	if groups == nil {
		groups = []ws.Group{}
	}
	c.JSON(http.StatusOK, groups)
}

func (s *Server) handleCreateGroup(c *gin.Context) {
	var body struct {
		Name  string `json:"name"  binding:"required"`
		Color string `json:"color"`
		X     float64 `json:"x"`
		Y     float64 `json:"y"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	color := body.Color
	if color == "" {
		color = "#1e3a5c"
	}
	res, err := s.db.Exec(
		`INSERT INTO groups (name, color, x, y) VALUES (?, ?, ?, ?)`,
		body.Name, color, body.X, body.Y,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, ws.Group{ID: id, Name: body.Name, Color: color, X: &body.X, Y: &body.Y})
}

func (s *Server) handleUpdateGroup(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Name  *string  `json:"name"`
		Color *string  `json:"color"`
		X     *float64 `json:"x"`
		Y     *float64 `json:"y"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Name  != nil { s.db.Exec(`UPDATE groups SET name  = ? WHERE id = ?`, *body.Name,  id) }
	if body.Color != nil { s.db.Exec(`UPDATE groups SET color = ? WHERE id = ?`, *body.Color, id) }
	if body.X     != nil { s.db.Exec(`UPDATE groups SET x     = ? WHERE id = ?`, *body.X,     id) }
	if body.Y     != nil { s.db.Exec(`UPDATE groups SET y     = ? WHERE id = ?`, *body.Y,     id) }
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleDeleteGroup(c *gin.Context) {
	id := c.Param("id")
	s.db.Exec(`UPDATE devices SET group_id = NULL WHERE group_id = ?`, id)
	if _, err := s.db.Exec(`DELETE FROM groups WHERE id = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── Workspace handlers ────────────────────────────────────────────────────────

func (s *Server) handleGetWorkspaces(c *gin.Context) {
	rows, err := s.db.Query(`SELECT id, name, group_id, sort_order FROM workspaces ORDER BY sort_order, id`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var out []ws.Workspace
	for rows.Next() {
		var w ws.Workspace
		var gid sql.NullInt64
		if err := rows.Scan(&w.ID, &w.Name, &gid, &w.SortOrder); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if gid.Valid { w.GroupID = &gid.Int64 }
		out = append(out, w)
	}
	if out == nil { out = []ws.Workspace{} }
	c.JSON(http.StatusOK, out)
}

func (s *Server) handleCreateWorkspace(c *gin.Context) {
	var body struct {
		Name    string `json:"name" binding:"required"`
		GroupID *int64 `json:"group_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var maxOrder int
	s.db.QueryRow(`SELECT COALESCE(MAX(sort_order),0) FROM workspaces`).Scan(&maxOrder) //nolint:errcheck
	res, err := s.db.Exec(
		`INSERT INTO workspaces (name, group_id, sort_order) VALUES (?, ?, ?)`,
		body.Name, body.GroupID, maxOrder+1,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, ws.Workspace{ID: id, Name: body.Name, GroupID: body.GroupID, SortOrder: maxOrder + 1})
}

func (s *Server) handleUpdateWorkspace(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Name    *string `json:"name"`
		GroupID *any    `json:"group_id"` // null or int64
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Name    != nil { s.db.Exec(`UPDATE workspaces SET name     = ? WHERE id = ?`, *body.Name, id) }   //nolint:errcheck
	if body.GroupID != nil { s.db.Exec(`UPDATE workspaces SET group_id = ? WHERE id = ?`, *body.GroupID, id) } //nolint:errcheck
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleDeleteWorkspace(c *gin.Context) {
	id := c.Param("id")
	if id == "1" {
		c.JSON(http.StatusForbidden, gin.H{"error": "cannot delete the Overview workspace"})
		return
	}
	s.db.Exec(`DELETE FROM workspace_positions WHERE workspace_id = ?`, id) //nolint:errcheck
	if _, err := s.db.Exec(`DELETE FROM workspaces WHERE id = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleGetWorkspacePositions(c *gin.Context) {
	id := c.Param("id")
	rows, err := s.db.Query(`SELECT device_mac, x, y FROM workspace_positions WHERE workspace_id = ?`, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := map[string]gin.H{}
	for rows.Next() {
		var mac string
		var x, y float64
		if err := rows.Scan(&mac, &x, &y); err != nil {
			continue
		}
		out[mac] = gin.H{"x": x, "y": y}
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) handleSetWorkspacePosition(c *gin.Context) {
	wsID := c.Param("id")
	mac  := c.Param("mac")
	var body struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_, err := s.db.Exec(
		`INSERT INTO workspace_positions (workspace_id, device_mac, x, y) VALUES (?, ?, ?, ?)
		 ON CONFLICT(workspace_id, device_mac) DO UPDATE SET x = excluded.x, y = excluded.y`,
		wsID, mac, body.X, body.Y,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── License handlers ─────────────────────────────────────────────────────────

func (s *Server) handleGetLicense(c *gin.Context) {
	if s.lic == nil {
		c.JSON(http.StatusOK, gin.H{"tier": "free", "device_limit": 25, "valid": true})
		return
	}
	info := s.lic.Status()
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&count)
	c.JSON(http.StatusOK, gin.H{
		"tier":         info.Tier,
		"tenant_id":    info.TenantID,
		"device_limit": info.DeviceLimit,
		"expires_at":   info.ExpiresAt,
		"valid":        info.Valid,
		"device_count": count,
	})
}

func (s *Server) handleApplyLicense(c *gin.Context) {
	var body struct {
		Key string `json:"key" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if s.lic == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "license manager not available"})
		return
	}
	if err := s.lic.Apply(body.Key); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, s.lic.Status())
}

func (s *Server) handleClearLicense(c *gin.Context) {
	if s.lic != nil {
		_ = s.lic.Clear()
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── Notification settings handlers ───────────────────────────────────────────

func (s *Server) handleGetNotifications(c *gin.Context) {
	webhookURL, _     := dbpkg.Setting(s.db, "webhook_url")
	slackURL, _       := dbpkg.Setting(s.db, "slack_webhook_url")
	c.JSON(http.StatusOK, gin.H{
		"webhook_url":       webhookURL,
		"slack_webhook_url": slackURL,
	})
}

func (s *Server) handleSetNotifications(c *gin.Context) {
	var body struct {
		WebhookURL    string `json:"webhook_url"`
		SlackWebhookURL string `json:"slack_webhook_url"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_ = dbpkg.SetSetting(s.db, "webhook_url",       body.WebhookURL)
	_ = dbpkg.SetSetting(s.db, "slack_webhook_url", body.SlackWebhookURL)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) handleTestNotification(c *gin.Context) {
	webhookURL, hasWebhook := dbpkg.Setting(s.db, "webhook_url")
	slackURL, hasSlack     := dbpkg.Setting(s.db, "slack_webhook_url")
	if !hasWebhook && !hasSlack {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no notification URLs configured"})
		return
	}
	payload := map[string]interface{}{
		"device_mac":   "test:00:00:00:00:00",
		"device_label": "Test Device",
		"from_state":   "up",
		"to_state":     "down",
		"at":           time.Now().UTC().Format(time.RFC3339),
	}
	var errs []string
	if hasWebhook && webhookURL != "" {
		if err := postJSON(webhookURL, payload); err != nil {
			errs = append(errs, "webhook: "+err.Error())
		}
	}
	if hasSlack && slackURL != "" {
		slackMsg := buildSlackMessage("Test Device", "down", time.Now())
		if err := postJSON(slackURL, slackMsg); err != nil {
			errs = append(errs, "slack: "+err.Error())
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusBadGateway, gin.H{"errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func buildSnapshot(db *sql.DB) (ws.Envelope, error) {
	devices, err := queryDevices(db)
	if err != nil {
		return ws.Envelope{}, err
	}
	if devices == nil {
		devices = []ws.Device{}
	}
	return ws.NewEnvelope(ws.TypeSnapshot, devices), nil
}

// postJSON sends a JSON POST request to url with a 8-second timeout.
func postJSON(url string, payload interface{}) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func buildSlackMessage(label, toState string, at time.Time) map[string]string {
	icon := "🟢"
	switch toState {
	case "down":
		icon = "🔴"
	case "degraded":
		icon = "🟡"
	}
	return map[string]string{
		"text": fmt.Sprintf("%s *%s* changed to *%s* at %s",
			icon, label, toState, at.UTC().Format("15:04:05 UTC")),
	}
}
