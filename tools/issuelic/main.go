// issuelic — manual license key issuer for WhatsLive Pro.
//
// Usage:
//
//	issuelic -priv license_private.pem -tenant acme -tier pro -days 365
//	issuelic -priv license_private.pem -tenant acme -tier pro -days 365 -limit -1
//
// The output is a JWT that the customer pastes into Settings → License.
package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	privPath := flag.String("priv", "license_private.pem", "path to RSA private key PEM")
	tenant := flag.String("tenant", "", "tenant ID (required)")
	tier := flag.String("tier", "pro", "tier: pro")
	days := flag.Int("days", 365, "validity in days")
	limit := flag.Int("limit", -1, "device limit (-1 = unlimited)")
	flag.Parse()

	if *tenant == "" {
		fmt.Fprintln(os.Stderr, "error: -tenant is required")
		os.Exit(1)
	}

	privPEM, err := os.ReadFile(*privPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read private key: %v\n", err)
		os.Exit(1)
	}
	block, _ := pem.Decode(privPEM)
	if block == nil {
		fmt.Fprintln(os.Stderr, "error: failed to decode PEM block")
		os.Exit(1)
	}
	privKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse private key: %v\n", err)
		os.Exit(1)
	}

	now := time.Now()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]interface{}{
		"tid":    *tenant,
		"tier":   *tier,
		"dlimit": *limit,
		"iat":    now.Unix(),
		"exp":    now.Add(time.Duration(*days) * 24 * time.Hour).Unix(),
	}

	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)

	headerEnc := base64.RawURLEncoding.EncodeToString(headerJSON)
	claimsEnc := base64.RawURLEncoding.EncodeToString(claimsJSON)
	message := headerEnc + "." + claimsEnc

	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, privKey, crypto.SHA256, digest[:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "sign: %v\n", err)
		os.Exit(1)
	}
	sigEnc := base64.RawURLEncoding.EncodeToString(sig)

	token := message + "." + sigEnc
	fmt.Println(token)
}
