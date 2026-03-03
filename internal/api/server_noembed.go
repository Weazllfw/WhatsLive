//go:build !embedui

package api

import "embed"

// uiFS is empty in dev builds. The server falls back to a placeholder HTML page.
var uiFS embed.FS
