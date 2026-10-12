#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="$(rustc -vV | awk '/^host:/ { print $2 }')"
OUT="$ROOT/web/src-tauri/binaries"
mkdir -p "$OUT"

python3 -m PyInstaller --clean --noconfirm --onefile \
  --name har-runtime-server \
  --paths src \
  src/har_runtime/desktop_entry.py

cp "dist/har-runtime-server" "$OUT/har-runtime-server-$TARGET"
echo "Built sidecar: $OUT/har-runtime-server-$TARGET"
