-- +goose Up

-- Flag for manually-created devices (not discovered by the scanner)
ALTER TABLE devices ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;

-- +goose Down
-- SQLite cannot drop columns; is_custom remains but is unused
