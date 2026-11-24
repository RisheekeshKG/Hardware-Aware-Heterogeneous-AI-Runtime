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

# uv installs PyTorch on the user's machine at first launch. Pinned and checksum-verified
# because it ships inside the installer.
UV_VERSION="0.10.11"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) UV_TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) UV_TARGET="x86_64-apple-darwin" ;;
  Linux-x86_64) UV_TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) UV_TARGET="aarch64-unknown-linux-gnu" ;;
  *) echo "No uv build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
UV_URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/uv.tar.gz" "$UV_URL"
curl -fsSL -o "$TMP/uv.tar.gz.sha256" "$UV_URL.sha256"
EXPECTED="$(awk '{print $1}' "$TMP/uv.tar.gz.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/uv.tar.gz" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "uv checksum mismatch: expected $EXPECTED, got $ACTUAL" >&2
  exit 1
fi
tar -xzf "$TMP/uv.tar.gz" -C "$TMP"
rm -rf "$OUT/uv"
mkdir -p "$OUT/uv"
cp "$TMP/uv-$UV_TARGET/uv" "$OUT/uv/uv"
echo "Bundled uv $UV_VERSION: $OUT/uv/uv"
