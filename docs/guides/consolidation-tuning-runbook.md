# Consolidation tuning runbook

How the Memory Consolidation Engine decides what reaches a human, and how to
tune it. The design goal (per *The Design of Everyday Things*): the system
absorbs ambiguity; the human sees only a few confident, one-action proposals;
nothing accumulates.

## The disposition pipeline

Every connector capture is classified ADD / UPDATE / NOOP / NEEDS_REVIEW, then
mapped to a candidate-row status:

| Verdict | Status | Surfaces to human? | TTL |
|---|---|---|---|
| ADD / UPDATE, confidence ≥ surface floor | `pending` | **yes** (the review queue) | 30 days |
| ADD / UPDATE, confidence < surface floor | `rejected` / `low_confidence` | no (logged only) | 7 days |
| NEEDS_REVIEW | `rejected` / `NEEDS_REVIEW` | no (logged only) | 7 days |
| NOOP | `rejected` / `NOOP` | no | 7 days |

`gbrain connector review` shows only the `pending` ADD/UPDATE. The
`consolidation_decisions` table always records the TRUE verdict (audit +
calibration), regardless of the surfaced status. Expired non-`accepted` rows are
hard-deleted by the sweep on each poll; `accepted` rows are never swept.

## The three knobs (all global config keys)

```bash
# Cosine ≥ this → treat as a duplicate → NOOP, no LLM call. Default 0.95.
gbrain config set connectors.consolidation_noop_cosine 0.95

# Cosine ≤ this → fast-path ADD, no LLM call. Default NULL = always escalate.
# DO NOT set this without a calibration measurement (see below) — see finding.
gbrain config set connectors.consolidation_add_cosine_floor <value>

# LLM confidence < this → an ADD/UPDATE is held back (not surfaced). Default 0.70.
gbrain config set connectors.consolidation_surface_min_confidence 0.70
```

## Calibration finding (2026-06-28, Granola meeting captures)

We measured the Tier-1 embedding cosine against the LLM's final verdict on the
first 45 real decisions:

| Verdict | n | cosine min–max | mean |
|---|---|---|---|
| ADD | 9 | 0.592–0.757 | 0.672 |
| UPDATE | 4 | 0.648–0.695 | 0.668 |
| NEEDS_REVIEW | 32 | 0.591–0.808 | 0.678 |

**The cosine does NOT predict the verdict** — the three bands overlap almost
completely (all ~0.67 mean). For meeting-style captures (which are multi-topic
by nature), a low cosine does not mean "novel" and a mid cosine does not mean
"ambiguous." Consequences:

- **Keep `consolidation_add_cosine_floor = NULL`.** Setting a floor in the
  observed band would auto-ADD captures the LLM actually flagged NEEDS_REVIEW —
  false positives into durable truth.
- **The LLM confidence IS separating** (ADD ≈ 0.93, strong UPDATE 0.87–0.97,
  weak/ambiguous ≈ 0.50–0.60). So `consolidation_surface_min_confidence` (0.70)
  is the working lever, not the cosine floor. The default cleanly surfaces the
  0.87–0.97 proposals and holds back the 0.50 ones.
- A high NEEDS_REVIEW rate on meeting notes is **structural**, not a defect — you
  cannot make the engine escalate less here. The fix is that escalations never
  burden the human (they're held back + self-expiring), not that they stop.

Re-measure before touching any floor:

```sql
SELECT classification, count(*) AS n,
       round(min(tier1_cosine)::numeric,3) AS min_cos,
       round(avg(tier1_cosine)::numeric,3) AS avg_cos,
       round(max(tier1_cosine)::numeric,3) AS max_cos
FROM consolidation_decisions
GROUP BY classification ORDER BY avg_cos;
```

Set an ADD floor only if a low-cosine band emerges where the LLM verdict is
overwhelmingly ADD (no NEEDS_REVIEW/NOOP overlap). Until then, escalate.
