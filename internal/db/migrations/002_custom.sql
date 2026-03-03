-- +goose Up

-- Custom display label set by the user (overrides hostname in map/list)
ALTER TABLE devices ADD COLUMN label  TEXT    NOT NULL DEFAULT '';

-- Whether this device is hidden from the map (still monitored)
ALTER TABLE devices ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- Visual group a device belongs to (NULL = ungrouped)
ALTER TABLE devices ADD COLUMN group_id INTEGER;

-- Named visual groups the user creates to organise the map
CREATE TABLE IF NOT EXISTS groups (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL,
    color TEXT    NOT NULL DEFAULT '#1e3a5c',
    x     REAL,
    y     REAL
);

-- Manual edges drawn by the user between any two devices
CREATE TABLE IF NOT EXISTS custom_edges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source_mac TEXT    NOT NULL,
    target_mac TEXT    NOT NULL,
    UNIQUE(source_mac, target_mac)
);

-- +goose Down
DROP TABLE IF EXISTS custom_edges;
DROP TABLE IF EXISTS groups;
-- SQLite cannot drop columns; label/hidden/group_id columns remain but are unused
