// Package license validates and manages WhatsLive Pro license keys.
//
// License keys are RS256-signed JWTs. The private key is held by the
// WhatsLive-Cloud billing service; the public key is embedded here.
// Validation is fully offline after the key is downloaded once.
package license

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Tier constants.
const (
	TierFree = "free"
	TierPro  = "pro"

	// FreePlanDeviceLimit is the maximum number of monitored devices on the
	// free plan. Custom (manually-added) devices count toward this total.
	FreePlanDeviceLimit = 25
)

// embeddedPublicKeyPEM is the RSA-2048 public key used to verify license JWTs.
// The matching private key lives in the WhatsLive-Cloud billing service.
const embeddedPublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAptF42pRJ7lrbGGGY+FrS
5mRcXo3QuhsNa3C1OXzDIkzBR4GPOlqmAY54nnpzaDasCQfTWHPXspPTs/YwNvl2
27b2HQhtsfYn+MEpL6aFPgrSTL0YJ2z8Ryim+EsCmy0FnEYJWXxIwh6odkNM3U8q
oHj15/3o82iahto/JH0YFhaZbyPHV1hn+dqH8t1KhtGfruU5/iiFVN2ixQqfUMvK
NjDw6duIUJFUkbYAKk3zqGJHLk7mLSUyqCClwYbjUoUe4EQ1DYnK4HyRChFHEKRX
I2bW50fxUdhCeaFh+0j2jLt0xIQkTzqBfiaZo89OwgqIonICpqqTWaNkfFFFFo70
3wIDAQAB
-----END PUBLIC KEY-----`

// Claims holds the decoded payload from a license JWT.
type Claims struct {
	TenantID    string `json:"tid"`
	Tier        string `json:"tier"`
	DeviceLimit int    `json:"dlimit"` // -1 = unlimited
	IssuedAt    int64  `json:"iat"`
	ExpiresAt   int64  `json:"exp"`
}

// StatusInfo is the JSON-serialisable view returned by GET /api/license.
type StatusInfo struct {
	Tier        string `json:"tier"`
	TenantID    string `json:"tenant_id,omitempty"`
	DeviceLimit int    `json:"device_limit"` // -1 = unlimited
	ExpiresAt   string `json:"expires_at,omitempty"`
	Valid        bool   `json:"valid"`
}

// Manager holds the current license state and the embedded public key.
type Manager struct {
	mu     sync.RWMutex
	claims *Claims // nil = no valid license (free tier applies)
	raw    string  // original JWT string
	pub    *rsa.PublicKey
	db     *sql.DB
}

// New parses the embedded public key and loads any previously-saved license
// from the database settings table.
func New(db *sql.DB) (*Manager, error) {
	block, _ := pem.Decode([]byte(embeddedPublicKeyPEM))
	if block == nil {
		return nil, errors.New("license: failed to decode embedded public key PEM")
	}
	iface, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("license: parse public key: %w", err)
	}
	rsaPub, ok := iface.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("license: embedded key is not an RSA public key")
	}

	m := &Manager{pub: rsaPub, db: db}

	// Load any previously saved key from the database.
	if key, ok := settingGet(db, "license_key"); ok && key != "" {
		if claims, err := m.parseAndVerify(key); err == nil {
			m.claims = claims
			m.raw = key
		}
	}
	return m, nil
}

// Apply validates the key and, if valid, persists it and activates Pro.
func (m *Manager) Apply(key string) error {
	claims, err := m.parseAndVerify(key)
	if err != nil {
		return err
	}
	if err := settingSet(m.db, "license_key", key); err != nil {
		return fmt.Errorf("license: save key to db: %w", err)
	}
	m.mu.Lock()
	m.claims = claims
	m.raw = key
	m.mu.Unlock()
	return nil
}

// Clear removes the license key and reverts to the free tier.
func (m *Manager) Clear() error {
	if err := settingSet(m.db, "license_key", ""); err != nil {
		return err
	}
	m.mu.Lock()
	m.claims = nil
	m.raw = ""
	m.mu.Unlock()
	return nil
}

// Tier returns "pro" when a valid Pro license is loaded, otherwise "free".
func (m *Manager) Tier() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.claims == nil {
		return TierFree
	}
	return m.claims.Tier
}

// DeviceLimit returns the maximum number of monitored devices allowed.
// Returns -1 (unlimited) for Pro with no explicit cap. Returns FreePlanDeviceLimit
// when no valid license is present.
func (m *Manager) DeviceLimit() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.claims == nil {
		return FreePlanDeviceLimit
	}
	return m.claims.DeviceLimit
}

// Status returns a snapshot of the current license state for the API.
func (m *Manager) Status() StatusInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.claims == nil {
		return StatusInfo{
			Tier:        TierFree,
			DeviceLimit: FreePlanDeviceLimit,
			Valid:        true,
		}
	}
	exp := time.Unix(m.claims.ExpiresAt, 0)
	return StatusInfo{
		Tier:        m.claims.Tier,
		TenantID:    m.claims.TenantID,
		DeviceLimit: m.claims.DeviceLimit,
		ExpiresAt:   exp.Format(time.RFC3339),
		Valid:        time.Now().Before(exp),
	}
}

// parseAndVerify decodes a JWT, verifies the RS256 signature, and checks expiry.
// It does NOT require any external dependencies — only the Go standard library.
func (m *Manager) parseAndVerify(tokenString string) (*Claims, error) {
	parts := strings.Split(strings.TrimSpace(tokenString), ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid token: expected 3 dot-separated parts")
	}

	// RS256: verify PKCS1v15 SHA-256 signature over "header.payload"
	message := parts[0] + "." + parts[1]
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}
	digest := sha256.Sum256([]byte(message))
	if err := rsa.VerifyPKCS1v15(m.pub, crypto.SHA256, digest[:], sigBytes); err != nil {
		return nil, fmt.Errorf("signature invalid: %w", err)
	}

	// Decode payload.
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	var claims Claims
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}

	if claims.ExpiresAt > 0 && time.Now().Unix() > claims.ExpiresAt {
		return nil, errors.New("license key has expired")
	}
	return &claims, nil
}

// settingGet / settingSet are thin wrappers so the license package does not
// import the db package (which would create a cycle).
func settingGet(db *sql.DB, key string) (string, bool) {
	var val sql.NullString
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val); err != nil || !val.Valid {
		return "", false
	}
	return val.String, true
}

func settingSet(db *sql.DB, key, value string) error {
	_, err := db.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}
