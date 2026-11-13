#!/usr/bin/env bash
# Starts an isolated backend for the Playwright suite. The data directory is
# recreated on every run so tests never touch real notes.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PORT="${E2E_PORT:-18080}"
DATA_DIR="${E2E_DATA_DIR:-.e2e-data}"

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

exec go run -tags "sqlite_fts5 sqlite_omit_load_extension" ./backend \
    --port "$PORT" \
    --data-dir "$DATA_DIR"
