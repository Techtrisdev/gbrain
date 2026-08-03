#!/usr/bin/env bash
# CI guard: verify that bun --compile binaries can decode HEIC + AVIF.
#
# heic-decode bundles its libheif WASM as base64 inside libheif-bundle.js, which
# bun --compile preserves correctly out of the box. @jsquash/avif loads
# avif_dec.wasm via a path relative to its own JS file, which FAILS inside a
# compiled binary — the workaround is to pre-init the module with bytes loaded
# via `with { type: 'file' }`. This guard ensures both paths actually work in
# the compiled artifact, not just in dev mode.
#
# Mirrors scripts/check-wasm-embedded.sh from v0.19.0 (tree-sitter pattern).
#
# NOT currently wired into any entrypoint. Declared in EXPECTED_UNWIRED in
# scripts/check-checks-wired.sh with the reason: it compiles a throwaway binary
# on every run (too slow for the pre-test gate) and currently fails outside
# Linux CI. Note that line 23 below sends build output to /dev/null, so a build
# failure surfaces as "heic-decode failed in compiled binary" with a wrong
# likely-cause. Establish which it is on Linux before wiring this in.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_BIN="$(mktemp /tmp/gbrain-img-decoders-check.XXXXXX)"
trap 'rm -f "$OUT_BIN"' EXIT

bun build --compile --outfile "$OUT_BIN" scripts/image-decoders-smoketest.ts >/dev/null 2>&1

OUTPUT="$("$OUT_BIN" 2>&1 || true)"

# The smoketest writes a JSON line on stdout. Look for ok=true on each decoder.
if ! echo "$OUTPUT" | grep -q '"heic":{"ok":true'; then
  echo "[check-image-decoders-embedded] FAIL: heic-decode failed in compiled binary." >&2
  echo "[check-image-decoders-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "Likely cause: libheif-bundle.js was upgraded to a non-bundle variant," >&2
  echo "or wasm-bundle.js stopped inlining the WASM as base64. Check the" >&2
  echo "heic-decode + libheif-js versions in package.json." >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"avif":{"ok":true'; then
  echo "[check-image-decoders-embedded] FAIL: @jsquash/avif failed in compiled binary." >&2
  echo "[check-image-decoders-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "Likely cause: the import attribute path for avif_dec.wasm changed in" >&2
  echo "@jsquash/avif, or initAvif() no longer accepts a WebAssembly.Module" >&2
  echo "directly. Check scripts/image-decoders-smoketest.ts for the WASM" >&2
  echo "pre-init pattern, then mirror it in src/core/import-file.ts." >&2
  exit 1
fi

# Final guard: top-level "ok":true.
if ! echo "$OUTPUT" | grep -q '"ok":true}$'; then
  echo "[check-image-decoders-embedded] FAIL: probe returned ok:false." >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-image-decoders-embedded] HEIC + AVIF decoders embed and decode correctly in compiled binary."
