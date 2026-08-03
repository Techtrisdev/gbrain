#!/usr/bin/env bash
# CI guard: every scripts/check-*.sh must be reachable from a CI entrypoint.
#
# WHY THIS EXISTS
# ---------------
# Five check scripts were found that CI never ran. Two asserted the opposite in
# their own headers:
#
#   check-pg-url-redaction.sh:13         "Wired into bun run check:all and bun run verify."
#   check-image-decoders-embedded.sh:13  "Wired into `bun run verify`"
#
# Both claims were false. check-pg-url-redaction.sh is a credential-leak guard
# forbidding a postgresql:// URL with userinfo from reaching a logging surface —
# it had never run. Two more (check-no-legacy-getconnection.sh,
# check-exports-count.sh) were reachable only through `check:all`, an npm script
# no workflow, no ci-local.sh, and no other script ever invoked.
#
# The failure mode is invisible by construction: a guard nothing invokes
# produces no output, and no output is indistinguishable from passing. Every
# other check here verifies a property of the code; this one verifies a
# property of the check system itself.
#
# ONE RULE, NO EXCEPTIONS
# -----------------------
# A check is in CI or it does not exist.
#
# This script deliberately has no allowlist, no EXPECTED_UNWIRED, and no
# opt-in tier. Earlier versions had two such escape hatches and both were
# actively misleading: `check:all` was documented as a "manual sweep", which
# made two dead guards look like a deliberate choice, and an EXPECTED_UNWIRED
# entry excused a third on a diagnosis that turned out to be wrong (the check
# worked fine; a .exe path bug was breaking it). A declared corpse is still a
# corpse — it produces neither a true green nor a delivered red.
#
# So there is nowhere to put a check that does not run. Wire it, or delete it.
# Deleting a check that has stopped earning its place is a valid, encouraged
# outcome — quieter than a guard everyone has learned to ignore.
#
# Reachability is resolved TRANSITIVELY: seeded from the npm scripts that
# .github/workflows/* and scripts/ci-local.sh actually invoke, then walked
# through package.json's script graph. A plain string match on package.json is
# not enough — that is precisely what let `check:all` hide two dead guards.
#
# Exit codes: 0 = every check reaches CI, 1 = at least one does not.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ONLY .github/workflows/* counts as an entrypoint.
#
# scripts/ci-local.sh was counted here previously and that was wrong. Nothing
# triggers it — no workflow references it, there is no git hook, and the
# docker-compose file it drives is referenced by no workflow. It is a
# 100%-manual operator script. Counting it meant check-trailing-newline.sh,
# which appears only inside ci-local.sh, was reported "reachable" while running
# on no push and no PR. This guard gave a false green for a check that never
# ran — its own disease, one level down, in the commit that claimed to cure it.
#
# If ci-local.sh ever gains a real trigger, add it back here deliberately.
#
# Comments and echo/printf payloads are stripped first: a help string telling a
# human what to type is not an invocation. The stripping is deliberately blunt
# and errs toward dropping a real invocation rather than inventing one — a
# missed invocation makes a check look LESS reachable, which fails loudly,
# whereas a false one passes silently.
ENTRYPOINT_TEXT="$(cat .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null \
  | sed -e 's/#.*//' -e 's/\(echo\|printf\)[[:space:]].*//' || true)"

SEED_SCRIPTS="$(printf '%s\n' "$ENTRYPOINT_TEXT" \
  | grep -oE '(bun|npm) run [a-z0-9:_-]+' | awk '{print $3}' | sort -u || true)"

DIRECT_SH="$(printf '%s\n' "$ENTRYPOINT_TEXT" \
  | grep -oE 'check-[a-z0-9-]+\.sh' | sort -u || true)"

# Walk package.json's script graph from the seeds and collect every check-*.sh
# reachable through it. bun is already required to reach this script at all
# (verify invokes it via `bun run`), so its absence is not a real path; if it
# were missing, `set -e` would abort at this command substitution rather than
# reaching the per-check reporting below. Either way the failure is loud, never
# a silent pass.
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

UNREACHABLE=()
TOTAL=0

for path in scripts/check-*.sh; do
  [ -e "$path" ] || continue
  TOTAL=$((TOTAL + 1))
  name="$(basename "$path")"
  printf '%s\n' "$CI_REACHABLE" | grep -qxF -- "$name" || UNREACHABLE+=("$name")
done

if [ ${#UNREACHABLE[@]} -gt 0 ]; then
  echo "" >&2
  echo "[checks-wired] FAIL: ${#UNREACHABLE[@]} check script(s) are not reachable from CI:" >&2
  for name in ${UNREACHABLE+"${UNREACHABLE[@]}"}; do
    echo "  - scripts/$name" >&2
  done
  echo "" >&2
  echo "A check nothing runs cannot fail, and a check that cannot fail is not a guard." >&2
  echo "" >&2
  echo "Wire it into package.json's verify chain, or delete it. There is deliberately" >&2
  echo "no allowlist here — a check that does not run has nowhere to hide, and" >&2
  echo "deleting one that has stopped earning its place is a valid outcome." >&2
  echo "" >&2
  echo "Note that being named in package.json is NOT sufficient: reachability is" >&2
  echo "resolved from the npm scripts CI actually invokes. A script referenced only" >&2
  echo "by an npm script nothing calls is unreachable, which is exactly how" >&2
  echo "check:all hid two dead guards." >&2
  exit 1
fi

echo "[checks-wired] all $TOTAL check scripts are reachable from CI."
