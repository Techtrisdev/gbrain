#!/usr/bin/env bash
# CI guard: every scripts/check-*.sh must be reachable from an entrypoint.
#
# WHY THIS EXISTS
# ---------------
# Three check scripts were found referenced by nothing at all. Two of them
# asserted the opposite in their own headers:
#
#   check-pg-url-redaction.sh:13      "Wired into bun run check:all and bun run verify."
#   check-image-decoders-embedded.sh:13  "Wired into `bun run verify`"
#
# Both claims were false. check-pg-url-redaction.sh is a credential-leak guard
# forbidding postgresql://user:pass@host from reaching a logging surface — it
# had never run.
#
# The failure mode is invisible by construction: a guard that nothing invokes
# produces no output, and no output is indistinguishable from passing. Every
# other check here verifies a property of the code; this one verifies a
# property of the check system itself.
#
# An unwired check is a keep-or-kill decision, not a lint error to suppress.
# Wire it, or delete it.
#
# KNOWN LIMITATION: reachability is checked at the file-reference level — a
# script named in package.json counts as wired even if the npm script naming it
# is never itself invoked. Transitive reachability is a stricter bar and a
# separate piece of work.
#
# Exit codes: 0 = every check reaches an entrypoint, 1 = at least one does not.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Checks that intentionally do not run from an entrypoint. Each entry needs a
# stated reason. Adding one is a decision, not a workaround.
EXPECTED_UNWIRED=(
  # Compiles a throwaway binary via `bun build --compile` on every invocation,
  # which is too slow for the pre-test gate. It also currently fails outside
  # Linux CI, and its own line 23 sends build output to /dev/null — so a build
  # failure is reported as "heic-decode failed in compiled binary" with a
  # confidently wrong likely-cause. Needs a Linux run to establish whether that
  # is environmental or a real decoder regression before it can be wired.
  "check-image-decoders-embedded.sh"
)

is_expected() {
  local name="$1"
  local entry
  for entry in "${EXPECTED_UNWIRED[@]}"; do
    [ "$entry" = "$name" ] && return 0
  done
  return 1
}

# Files that count as invoking a check.
ENTRYPOINTS=("package.json")
[ -f "scripts/ci-local.sh" ] && ENTRYPOINTS+=("scripts/ci-local.sh")
while IFS= read -r workflow; do
  ENTRYPOINTS+=("$workflow")
done < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort)

UNWIRED=()
SKIPPED=()
TOTAL=0

for path in scripts/check-*.sh; do
  [ -e "$path" ] || continue
  TOTAL=$((TOTAL + 1))
  name="$(basename "$path")"

  found=0
  for entrypoint in "${ENTRYPOINTS[@]}"; do
    if grep -qF -- "$name" "$entrypoint" 2>/dev/null; then
      found=1
      break
    fi
  done

  if [ "$found" -eq 0 ]; then
    if is_expected "$name"; then
      SKIPPED+=("$name")
    else
      UNWIRED+=("$name")
    fi
  fi
done

for name in "${SKIPPED[@]}"; do
  echo "[checks-wired] not wired by design: $name"
done

if [ ${#UNWIRED[@]} -gt 0 ]; then
  echo "" >&2
  echo "[checks-wired] FAIL: ${#UNWIRED[@]} check script(s) are referenced by no entrypoint:" >&2
  for name in "${UNWIRED[@]}"; do
    echo "  - scripts/$name" >&2
  done
  echo "" >&2
  echo "A check nothing runs cannot fail, and a check that cannot fail is not a guard." >&2
  echo "Wire each into package.json's verify chain, or delete it. If one genuinely" >&2
  echo "cannot run in the pre-test gate, add it to EXPECTED_UNWIRED in" >&2
  echo "scripts/check-checks-wired.sh with a reason." >&2
  exit 1
fi

echo "[checks-wired] all $TOTAL check scripts reach an entrypoint (${#SKIPPED[@]} unwired by design)."
