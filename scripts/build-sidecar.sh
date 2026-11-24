#!/usr/bin/env bash
# Builds the PyInstaller runtime and puts it where the desktop app bundles it from.
# Set PYTHON to pick the interpreter (it needs `pip install -e "./har[desktop]"`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/desktop/src-tauri/runtime"
PYTHON="${PYTHON:-python3}"

cd "$ROOT/har"
"$PYTHON" -m PyInstaller --clean --noconfirm har-runtime-server.spec

mkdir -p "$OUT"
rm -rf "$OUT/har-runtime-server"
cp -R dist/har-runtime-server "$OUT/har-runtime-server"
echo "Built runtime bundle: $OUT/har-runtime-server ($(du -sh "$OUT/har-runtime-server" | cut -f1))"
