#!/usr/bin/env bash
# Build the client half (src/client/index.ts → lib/client.js) with tsdown.
#
# tsdown resolution order:
#   1) local node_modules/.bin/tsdown   (npm install — the supported path)
#   2) $DSH_CHECKOUT/node_modules/.bin/tsdown (checkout mode)
#   3) tsdown on PATH
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_tsdown() {
  local cand
  for cand in "node_modules/.bin/tsdown" "node_modules/.bin/tsdown.cmd"; do
    if [ -f "$cand" ]; then echo "$cand"; return 0; fi
  done

  local checkout="${DSH_CHECKOUT:-}"
  if [ -z "$checkout" ]; then
    for candidate in \
      "$ROOT/../../../dsh/deepseek-harness" \
      "$HOME/dsh-harness" \
      "$HOME/dsh" \
      "$HOME/.dsh/dsh-harness"
    do
      if [ -d "$candidate/packages" ]; then checkout="$candidate"; break; fi
    done
  fi
  if [ -n "$checkout" ]; then
    for cand in "$checkout/node_modules/.bin/tsdown" "$checkout/node_modules/.bin/tsdown.cmd"; do
      if [ -f "$cand" ]; then echo "$cand"; return 0; fi
    done
  fi

  if command -v tsdown >/dev/null 2>&1; then command -v tsdown; return 0; fi
  return 1
}

TSDOWN="$(find_tsdown || true)"
if [ -z "$TSDOWN" ]; then
  echo "build-client: tsdown not found — run \`npm install\` (devDependency tsdown) or set DSH_CHECKOUT" >&2
  exit 1
fi

echo "=== Building client bundle (tsdown: $TSDOWN) ==="
"$TSDOWN"
echo "=== Client build complete: lib/client.js ==="
