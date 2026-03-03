package api

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/weazllfw/whatslive/internal/ws"
)

// client wraps a single WebSocket connection.
type client struct {
	conn *websocket.Conn
	send chan []byte
}

// Hub manages all connected WebSocket clients and fans out messages.
type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
}

// NewHub creates an idle Hub. Call Run to start processing.
func NewHub() *Hub {
	return &Hub{clients: make(map[*client]struct{})}
}

// Register adds a client and sends it the opening snapshot.
func (h *Hub) Register(conn *websocket.Conn, snapshot ws.Envelope) {
	c := &client{conn: conn, send: make(chan []byte, 64)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	// Send snapshot immediately.
	if data, err := json.Marshal(snapshot); err == nil {
		c.send <- data
	}

	// Writer goroutine — drains c.send and writes to the WS connection.
	go func() {
		defer func() {
			conn.Close()
			h.mu.Lock()
			delete(h.clients, c)
			h.mu.Unlock()
		}()
		for data := range c.send {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		}
	}()

	// Reader goroutine — keeps the connection alive and detects close.
	go func() {
		defer close(c.send)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

// Broadcast sends an envelope to all connected clients.
func (h *Hub) Broadcast(env ws.Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		log.Printf("hub: marshal error: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- data:
		default:
			// Slow client — drop the message rather than block.
		}
	}
}
