-- +goose Up

-- Persist user-chosen edge colour to the database.
-- Previously stored in browser localStorage (lost on cache clear / different browser).
ALTER TABLE custom_edges ADD COLUMN color TEXT NOT NULL DEFAULT '#7c3aed';

-- +goose Down
-- SQLite DROP COLUMN requires v3.35+; omit for broad compatibility
