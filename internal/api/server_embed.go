//go:build embedui

package api

import "embed"

// ui_static/ is populated by `npm run build` in /ui (outDir set to this package).
//
//go:embed all:ui_static
var uiFS embed.FS
