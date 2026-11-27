#!/usr/bin/env bash
# Compile src/ → lib/ (host half) and src/client → lib/client.js (client half).
#
# Two build modes, picked automatically:
#
#   1. checkout mode — a DeepSeek Harness source checkout provides the peer
#      packages (cordis / schemastery / @deepseek-ai/dsh-tools) and its tsc.
#      Set DSH_CHECKOUT=<path> to point at it explicitly.
#   2. npm mode — plain `npm install` in this repo; devDependencies provide tsc
#      and tsdown. This is what CI and outside contributors use.
#
# Both modes delegate dependency wiring to scripts/link-deps.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 1. Locate a DSH source checkout (optional) ──────────────────────────────
is_checkout() {
  [ -n "${1:-}" ] && [ -d "$1/packages" ] && [ -d "$1/vendor/cordis" ]
}

CHECKOUT=""
if is_checkout "${DSH_CHECKOUT:-}"; then
  CHECKOUT="$DSH_CHECKOUT"
else
  for candidate in \
    "$ROOT/../../../dsh/deepseek-harness" \
    "$HOME/dsh-harness" \
    "$HOME/dsh" \
    "$HOME/.dsh/dsh-harness"
  do
    if is_checkout "$candidate"; then CHECKOUT="$candidate"; break; fi
  done
fi

pick_tsc() {
  local base="$1"
  if [ -x "$base/node_modules/.bin/tsc" ]; then echo "$base/node_modules/.bin/tsc"; return 0; fi
  if [ -f "$base/node_modules/.bin/tsc.cmd" ]; then echo "$base/node_modules/.bin/tsc.cmd"; return 0; fi
  return 1
}

TSC=""
if [ -n "$CHECKOUT" ]; then
  echo "=== Build mode: DSH checkout ($CHECKOUT) ==="
  node scripts/link-deps.mjs --checkout "$CHECKOUT"
  TSC="$(pick_tsc "$CHECKOUT" || true)"
  if [ -z "$TSC" ]; then
    echo "build: tsc not found under $CHECKOUT/node_modules/.bin" >&2
    exit 1
  fi
else
  echo "=== Build mode: npm packages (no DSH checkout found) ==="
  if [ ! -d node_modules ]; then
    echo "build: node_modules is missing — run \`npm install\` first (or set DSH_CHECKOUT)" >&2
    exit 1
  fi
  node scripts/link-deps.mjs --npm
  TSC="$(pick_tsc "$ROOT" || true)"
  if [ -z "$TSC" ]; then
    echo "build: tsc not found — run \`npm install\` first" >&2
    exit 1
  fi
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json

echo "=== Compiling client half → lib/client.js ==="
bash scripts/build-client.sh

echo "=== Build complete ==="
