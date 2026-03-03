-- +goose Up

-- Track last measured round-trip time per device (milliseconds, NULL = not yet measured)
ALTER TABLE devices ADD COLUMN last_latency_ms INTEGER;

-- Free-text notes field for MSP annotations
ALTER TABLE devices ADD COLUMN notes TEXT NOT NULL DEFAULT '';

-- User-visible label on drawn connections
ALTER TABLE custom_edges ADD COLUMN label TEXT NOT NULL DEFAULT '';

-- +goose Down
-- SQLite DROP COLUMN requires v3.35+; omit for broad compatibility
