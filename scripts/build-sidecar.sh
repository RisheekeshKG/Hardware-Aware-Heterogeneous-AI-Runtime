#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="$(rustc -vV | awk '/^host:/ { print $2 }')"
OUT="$ROOT/web/src-tauri/runtime"
mkdir -p "$OUT"

python3 -m PyInstaller --clean --noconfirm har-runtime-server.spec

rm -rf "$OUT/har-runtime-server"
cp -R "dist/har-runtime-server" "$OUT/har-runtime-server"
echo "Built runtime bundle: $OUT/har-runtime-server"
