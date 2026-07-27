#!/usr/bin/env bash
# scripts/check-claude-md-paths.sh — CLAUDE.md must not cite files that do not exist.
#
# WHY THIS EXISTS
# CLAUDE.md is the agent operating contract. Agents read it and act on it
# literally: they open the files it names and run the tests it cites as
# regression pins. A stale path is therefore not a documentation nit — it
# actively misleads every agent that touches this repo.
#
# It is worse than it looks, because of how `bun test` handles a missing path:
#
#   bun test test/ghost.test.ts                 -> exit 1   (correct)
#   bun test test/real.test.ts test/ghost.test.ts -> exit 0  (!!)
#
# With at least one real file present, a nonexistent path is treated as a
# FILTER THAT MATCHES NOTHING and the run exits GREEN. So an agent that reads
# "Pinned by test/foo.test.ts", runs it alongside other files, and sees a pass
# concludes the regression is covered when no such test exists. Fictional
# coverage that reports success is the exact failure mode this guard prevents.
#
# Discovered 2026-07-27: 10 of 539 cited paths were wrong — 3 moved, 7 absent.
#
# USAGE
#   scripts/check-claude-md-paths.sh          # fail on any missing path
#   scripts/check-claude-md-paths.sh --list   # print every cited path, no gate
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

DOC="CLAUDE.md"
[ -f "$DOC" ] || { echo "ERROR: $DOC not found at repo root" >&2; exit 2; }

# KNOWN-MISSING QUARANTINE.
# These are cited in CLAUDE.md as regression pins but do not exist anywhere in
# the repo. They are listed here so this guard can gate NEW drift immediately
# rather than waiting on the archaeology of whether each was renamed, folded
# into another suite, or never written.
#
# THIS LIST MUST ONLY SHRINK. Removing an entry means you either restored the
# test or corrected the citation. Adding one means you shipped a false coverage
# claim -- fix the citation instead.
QUARANTINE=(
  "test/ai/gateway.test.ts"
  "test/eval-cross-modal-batch.test.ts"
  "test/intent.test.ts"
  "test/openai-compat-multimodal.test.ts"
  "test/search/embedding-column.test.ts"
  "test/skillpack-sync-guard.test.ts"
  "test/think-gateway-adapter.test.ts"
)

is_quarantined() {
  local needle="$1"
  for q in "${QUARANTINE[@]}"; do [ "$q" = "$needle" ] && return 0; done
  return 1
}

# Extract backtick-quoted paths under a known source dir that carry a file
# extension. Deliberately conservative: prose like `skills/` or a bare dir is
# not a file claim, and globs are not literal paths.
mapfile -t PATHS < <(
  grep -oE '`(src|test|scripts|skills|docs|admin)/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+`' "$DOC" \
    | tr -d '`' | grep -v '[*?]' | sort -u
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${PATHS[@]}"
  exit 0
fi

missing=(); stale_quarantine=()
for p in "${PATHS[@]}"; do
  [ -e "$p" ] && continue
  if is_quarantined "$p"; then stale_quarantine+=("$p"); else missing+=("$p"); fi
done

# A quarantined entry that now EXISTS is good news -- but the list must be
# pruned, or it silently stops gating that path.
resolved=()
for q in "${QUARANTINE[@]}"; do [ -e "$q" ] && resolved+=("$q"); done

if [ ${#resolved[@]} -gt 0 ]; then
  echo "FAIL: these paths exist now but are still quarantined in $0." >&2
  printf '  %s\n' "${resolved[@]}" >&2
  echo "Remove them from QUARANTINE so the guard covers them again." >&2
  exit 1
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: $DOC cites ${#missing[@]} path(s) that do not exist:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "" >&2
  echo "Correct the citation, or delete it. Do NOT add it to QUARANTINE --" >&2
  echo "that list is for pre-existing debt and must only shrink." >&2
  exit 1
fi

echo "check-claude-md-paths: ${#PATHS[@]} cited paths OK (${#stale_quarantine[@]} known-missing quarantined)"
exit 0
