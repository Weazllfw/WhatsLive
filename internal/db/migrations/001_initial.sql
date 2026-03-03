-- +goose Up

CREATE TABLE IF NOT EXISTS devices (
    mac         TEXT PRIMARY KEY,
    ip          TEXT NOT NULL,
    hostname    TEXT NOT NULL DEFAULT '',
    vendor      TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT 'generic',
    state       TEXT NOT NULL DEFAULT 'unknown',
    first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS check_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_mac  TEXT NOT NULL,
    check_type  TEXT NOT NULL,
    success     INTEGER NOT NULL DEFAULT 0,
    latency_ms  INTEGER,
    checked_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_mac) REFERENCES devices(mac)
);

CREATE TABLE IF NOT EXISTS state_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_mac      TEXT NOT NULL,
    from_state      TEXT NOT NULL,
    to_state        TEXT NOT NULL,
    transitioned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_mac) REFERENCES devices(mac)
);

CREATE TABLE IF NOT EXISTS node_positions (
    device_mac  TEXT PRIMARY KEY,
    x           REAL NOT NULL DEFAULT 0,
    y           REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (device_mac) REFERENCES devices(mac)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('subnet',               NULL),
    ('discovery_interval_s', '300'),
    ('heartbeat_interval_s', '30'),
    ('bind_addr',            '0.0.0.0:8080');

-- +goose Down

DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS node_positions;
DROP TABLE IF EXISTS state_history;
DROP TABLE IF EXISTS check_results;
DROP TABLE IF EXISTS devices;
