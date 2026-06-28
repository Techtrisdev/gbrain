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
- **Superseded by fan-out (see "Multi-topic fan-out" below).** This 32/45
  NEEDS_REVIEW share was measured under the **single-target** engine, where any
  capture touching more than one page was *forced* to NEEDS_REVIEW — so the high
  rate was mostly the single-target rule firing on ordinary multi-topic meetings,
  not genuine conflict. With fan-out, each page gets its own targeted verdict and
  NEEDS_REVIEW reverts to its real meaning (per-partition contradiction /
  unplaceable). Re-measure on fan-out output before drawing tuning conclusions; the
  cosine-bands finding above (cosine does not predict the verdict) still stands.

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

## Multi-topic fan-out (one capture → one proposal per page)

A real meeting note is almost always **multi-topic** (a client status change *and*
an integration change *and* a new project). Earlier the classifier emitted a
**single** verdict and any capture touching more than one page was forced to
NEEDS_REVIEW — so the majority of real captures became review chores. That rule
is **gone**. The classifier now **partitions the facts by page and emits one
targeted ADD/UPDATE/NOOP/NEEDS_REVIEW verdict PER page** (a JSON array). One
meeting about Acme (Series B) and Olo (webhook change) produces an UPDATE to
`clients/acme` **and** an UPDATE to `integrations/olo` — two clean, independently
promotable proposals.

### What NEEDS_REVIEW means now

NEEDS_REVIEW is no longer "this capture touched more than one page." It fires
**per partition**, only when that partition:

- **contradicts** a page's compiled truth in a way the model can't safely merge, or
- **can't be confidently placed** on any page (and isn't clearly a clean new page).

A partial fan-out is normal and fine: one partition can be NEEDS_REVIEW while its
siblings proceed as ADD/UPDATE. So a high NEEDS_REVIEW *share* is now a real
signal worth reading, not structural noise — expect it to drop toward the
genuine-conflict rate (single digits).

### Per-target keying (and why it needs no receiver change)

Each fanned-out verdict becomes its own candidate row keyed
`source_record_id = "<captureId>::<target>"` (the page slug for a placed verdict;
the partition index for a placeless ADD). A single-topic capture keeps today's
**bare** `captureId` (byte-identical to before). This one key makes the
`(source_id, source_record_id, version)` unique constraint, the decision-log
tuple, AND the techtris-brain receiver's branch name
`promote/<provider>-<sha256("<source_id>|<source_record_id>")[:12]>` all **distinct
per target** — so N verdicts from one capture become N ordinary, independent
promotions. **The receiver is unchanged.** The `::` separator never occurs in a
real provider record id or a path-like Brain slug.

### Re-poll idempotency

The trailing-window re-poll pre-check recognizes an already-consolidated capture
by **either** the bare-id row **or** any `"<captureId>::"`-prefixed row, so a
fanned-out capture is **never re-consolidated** — zero LLM calls on re-poll. (It
is an indexed-friendly prefix `LIKE` with the captureId's LIKE metacharacters
escaped; no migration, no `capture_id` column. Revisit only if it shows cost at
scale.)

### The recall knob

A capture dominated by one topic must still carry a *second* topic's page into the
candidate set, or that page can never be the UPDATE target. The Tier-1 candidate
count `DEFAULT_TOP_K` was raised **5 → 10** (cap 12) for this. If a dominant-topic
capture still misses a second page in practice, the deferred refinement is
per-fact (per-cluster) embedding + search — measure top-K first.
