// Package notify sends webhook and Slack notifications when device state changes.
// It is called from the state-change event loop in main.go.
package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// StateChangePayload is POSTed to the configured webhook URL on every state
// transition. The shape is documented in the API reference.
type StateChangePayload struct {
	DeviceMAC   string `json:"device_mac"`
	DeviceLabel string `json:"device_label"`
	FromState   string `json:"from_state"`
	ToState     string `json:"to_state"`
	At          string `json:"at"`
}

// Config holds the notification URLs loaded from settings.
type Config struct {
	WebhookURL      string
	SlackWebhookURL string
}

// Notifier sends state-change events to configured endpoints.
type Notifier struct {
	client http.Client
}

// New creates a Notifier with a sensible HTTP timeout.
func New() *Notifier {
	return &Notifier{
		client: http.Client{Timeout: 8 * time.Second},
	}
}

// Send fires webhook and/or Slack notifications for a state change.
// Errors are logged but never returned — a notification failure must never
// interrupt the main state machine loop.
func (n *Notifier) Send(cfg Config, mac, label, fromState, toState string, at time.Time) {
	payload := StateChangePayload{
		DeviceMAC:   mac,
		DeviceLabel: label,
		FromState:   fromState,
		ToState:     toState,
		At:          at.UTC().Format(time.RFC3339),
	}

	if cfg.WebhookURL != "" {
		if err := n.postJSON(cfg.WebhookURL, payload); err != nil {
			fmt.Printf("notify: webhook error: %v\n", err)
		}
	}
	if cfg.SlackWebhookURL != "" {
		msg := buildSlackMessage(label, toState, at)
		if err := n.postJSON(cfg.SlackWebhookURL, msg); err != nil {
			fmt.Printf("notify: slack error: %v\n", err)
		}
	}
}

func (n *Notifier) postJSON(url string, payload interface{}) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := n.client.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	return nil
}

// slackBlock is the minimal Slack incoming-webhook message shape.
type slackBlock struct {
	Text string `json:"text"`
}

func buildSlackMessage(label, toState string, at time.Time) slackBlock {
	icon := "🟢"
	switch toState {
	case "down":
		icon = "🔴"
	case "degraded":
		icon = "🟡"
	}
	return slackBlock{
		Text: fmt.Sprintf("%s *%s* changed to *%s* at %s",
			icon, label, toState, at.UTC().Format("15:04:05 UTC")),
	}
}
