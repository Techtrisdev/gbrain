#!/usr/bin/env bash
# CI guard: every scripts/check-*.sh must be accounted for.
#
# WHY THIS EXISTS
# ---------------
# Three check scripts were found referenced by nothing. Two asserted the
# opposite in their own headers:
#
#   check-pg-url-redaction.sh:13         "Wired into bun run check:all and bun run verify."
#   check-image-decoders-embedded.sh:13  "Wired into `bun run verify`"
#
# Both claims were false. check-pg-url-redaction.sh is a credential-leak guard
# forbidding a postgresql:// URL with userinfo from reaching a logging surface
# — it had never run.
#
# The failure mode is invisible by construction: a guard nothing invokes
# produces no output, and no output is indistinguishable from passing. Every
# other check here verifies a property of the code; this one verifies a
# property of the check system itself.
#
# THREE CATEGORIES, NOT TWO
# -------------------------
# A first version of this script counted a check as "wired" whenever its
# filename appeared anywhere in package.json. That was too weak: it reported
# check-no-legacy-getconnection.sh and check-exports-count.sh as wired when
# both are reachable only through `check:all`, which no workflow, no
# ci-local.sh, and no other script ever invokes. Reporting those green was the
# same defect this guard exists to catch.
#
# So reachability is resolved transitively from real automated entrypoints
# (.github/workflows/*, scripts/ci-local.sh) through package.json's script
# graph, and every check lands in exactly one bucket:
#
#   ci          reachable from a CI entrypoint — a GitHub Actions workflow, or
#               scripts/ci-local.sh. Note ci-local.sh is operator-run rather
#               than triggered, so a small number of checks (currently
#               check-trailing-newline.sh and its siblings) arrive only by that
#               path and do not run on a push.
#   opt_in      referenced in package.json but only via a script no automation
#               calls (today: `check:all`, a deliberate manual sweep — see
#               .claude/docs/architecture.md:137, CONTRIBUTING.md:85). Must be
#               declared in OPT_IN_ONLY with a reason.
#   unreferenced  named nowhere. Must be declared in EXPECTED_UNWIRED.
#
# An undeclared opt_in or unreferenced check fails the build. That is the
# point: it forces a keep / wire / kill decision instead of letting a check
# quietly stop mattering.
#
# Declarations are themselves verified — a stale or misspelled entry that
# matches no real script in that category fails too, so the exception lists
# cannot become the new hiding place.
#
# Exit codes: 0 = every check accounted for, 1 = at least one is not.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Declarations -----------------------------------------------------------

# Reachable only via a manual sweep, never from automation. Each needs a reason.
OPT_IN_ONLY=(
  # Historical-sweep checks deliberately kept out of the pre-test gate. The
  # split is intentional and documented: .claude/docs/architecture.md:137
  # ("a green verify does not mean every gate in the repo passes") and
  # CONTRIBUTING.md:85. Listed here so the choice stays visible rather than
  # being mistaken for CI coverage.
  "check-no-legacy-getconnection.sh"
  "check-exports-count.sh"
)

# Referenced by nothing at all. Each needs a reason.
EXPECTED_UNWIRED=(
  # Empty, and that is the goal state. check-image-decoders-embedded.sh was
  # listed here on the belief that it "fails outside Linux CI". That diagnosis
  # was wrong: bun appends .exe to --outfile on Windows, the script executed the
  # un-suffixed path (mktemp's zero-byte placeholder), got empty output, and
  # blamed the decoder. With the artifact resolved correctly it passes, so it is
  # now wired into verify rather than excused. Keeping the array declared, since
  # a genuinely unwireable check should be declared here rather than deleted
  # silently.
)

# --- Reachability -----------------------------------------------------------

# npm scripts invoked directly by automation, plus check scripts named there.
# Comments and echo/printf payloads are stripped before scanning: a help string
# telling a human what to type is not an invocation. scripts/ci-local.sh:97
# ("run with: ... bun run ci:local") is a live example — reading it as an
# invocation would promote a script to CI-reachable with no automated path
# behind it, which is this guard's own disease one layer down.
#
# The stripping is deliberately blunt and errs toward dropping a real
# invocation rather than inventing one. A missed invocation makes a check look
# LESS reachable, which fails loudly; a false one would pass silently.
ENTRYPOINT_TEXT="$(cat .github/workflows/*.yml .github/workflows/*.yaml scripts/ci-local.sh 2>/dev/null \
  | sed -e 's/#.*//' -e 's/\(echo\|printf\)[[:space:]].*//' || true)"

SEED_SCRIPTS="$(printf '%s\n' "$ENTRYPOINT_TEXT" \
  | grep -oE '(bun|npm) run [a-z0-9:_-]+' | awk '{print $3}' | sort -u || true)"

DIRECT_SH="$(printf '%s\n' "$ENTRYPOINT_TEXT" \
  | grep -oE 'check-[a-z0-9-]+\.sh' | sort -u || true)"

# Walk package.json's script graph from the seeds and collect every check-*.sh
# reachable through it. bun is already required to run anything here.
GRAPH_SH="$(SEEDS="$SEED_SCRIPTS" bun -e '
  const fs = require("fs");
  const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts || {};
  const queue = (process.env.SEEDS || "").split("\n").filter(Boolean);
  const seen = new Set();
  const found = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const body = scripts[name];
    if (!body) continue;
    for (const m of body.matchAll(/check-[a-z0-9-]+\.sh/g)) found.add(m[0]);
    for (const m of body.matchAll(/(?:bun|npm) run ([a-z0-9:_-]+)/g)) queue.push(m[1]);
  }
  console.log([...found].join("\n"));
' 2>/dev/null || true)"

CI_REACHABLE="$(printf '%s\n%s\n' "$DIRECT_SH" "$GRAPH_SH" | grep -v '^$' | sort -u || true)"

# Every check-*.sh named anywhere in package.json, reachable or not.
PKG_REFERENCED="$(grep -oE 'check-[a-z0-9-]+\.sh' package.json | sort -u || true)"

in_list() { printf '%s\n' "$2" | grep -qxF -- "$1"; }

in_array() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

# --- Classify ---------------------------------------------------------------

UNDECLARED_OPT_IN=()
UNDECLARED_UNREFERENCED=()
SEEN_OPT_IN=()
SEEN_UNREFERENCED=()
TOTAL=0
CI_COUNT=0

for path in scripts/check-*.sh; do
  [ -e "$path" ] || continue
  TOTAL=$((TOTAL + 1))
  name="$(basename "$path")"

  if in_list "$name" "$CI_REACHABLE"; then
    CI_COUNT=$((CI_COUNT + 1))
  elif in_list "$name" "$PKG_REFERENCED"; then
    SEEN_OPT_IN+=("$name")
    in_array "$name" ${OPT_IN_ONLY+"${OPT_IN_ONLY[@]}"} || UNDECLARED_OPT_IN+=("$name")
  else
    SEEN_UNREFERENCED+=("$name")
    in_array "$name" ${EXPECTED_UNWIRED+"${EXPECTED_UNWIRED[@]}"} || UNDECLARED_UNREFERENCED+=("$name")
  fi
done

# --- Verify the declarations themselves -------------------------------------

STALE=()
for entry in ${OPT_IN_ONLY+"${OPT_IN_ONLY[@]}"}; do
  in_array "$entry" ${SEEN_OPT_IN+"${SEEN_OPT_IN[@]}"} \
    || STALE+=("OPT_IN_ONLY: $entry is not an opt-in-only check (missing, or now CI-reachable)")
done
for entry in ${EXPECTED_UNWIRED+"${EXPECTED_UNWIRED[@]}"}; do
  in_array "$entry" ${SEEN_UNREFERENCED+"${SEEN_UNREFERENCED[@]}"} \
    || STALE+=("EXPECTED_UNWIRED: $entry is not an unreferenced check (missing, or now referenced)")
done

# --- Report -----------------------------------------------------------------

for name in ${SEEN_OPT_IN+"${SEEN_OPT_IN[@]}"}; do
  echo "[checks-wired] opt-in only, not run by automation: $name"
done
for name in ${SEEN_UNREFERENCED+"${SEEN_UNREFERENCED[@]}"}; do
  echo "[checks-wired] unreferenced by design: $name"
done

FAILED=0

if [ ${#UNDECLARED_UNREFERENCED[@]} -gt 0 ] || [ ${#UNDECLARED_OPT_IN[@]} -gt 0 ]; then
  FAILED=1
  echo "" >&2
  echo "[checks-wired] FAIL: check script(s) are not accounted for." >&2
  for name in ${UNDECLARED_UNREFERENCED+"${UNDECLARED_UNREFERENCED[@]}"}; do
    echo "  - scripts/$name — referenced by nothing" >&2
  done
  for name in ${UNDECLARED_OPT_IN+"${UNDECLARED_OPT_IN[@]}"}; do
    echo "  - scripts/$name — referenced only via a script no automation invokes" >&2
  done
  echo "" >&2
  echo "A check nothing runs cannot fail, and a check that cannot fail is not a guard." >&2
  echo "Wire it into an automated entrypoint, delete it, or declare it in" >&2
  echo "OPT_IN_ONLY / EXPECTED_UNWIRED in scripts/check-checks-wired.sh with a reason." >&2
fi

if [ ${#STALE[@]} -gt 0 ]; then
  FAILED=1
  echo "" >&2
  echo "[checks-wired] FAIL: stale declaration(s) — the exception lists must not drift." >&2
  for msg in ${STALE+"${STALE[@]}"}; do
    echo "  - $msg" >&2
  done
fi

[ "$FAILED" -eq 0 ] || exit 1

echo "[checks-wired] $TOTAL check scripts accounted for: $CI_COUNT CI-reachable, ${#SEEN_OPT_IN[@]} opt-in only, ${#SEEN_UNREFERENCED[@]} unreferenced by design."
