-- +goose Up

CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    group_id   INTEGER,          -- NULL = all devices (Overview)
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- The Overview workspace is permanent and cannot be deleted
INSERT INTO workspaces (id, name, group_id, sort_order) VALUES (1, 'Overview', NULL, 0);

-- Per-workspace node positions; override global node_positions for a specific view
CREATE TABLE IF NOT EXISTS workspace_positions (
    workspace_id INTEGER NOT NULL,
    device_mac   TEXT    NOT NULL,
    x            REAL    NOT NULL,
    y            REAL    NOT NULL,
    PRIMARY KEY (workspace_id, device_mac)
);

-- +goose Down
DROP TABLE IF EXISTS workspace_positions;
DROP TABLE IF EXISTS workspaces;
