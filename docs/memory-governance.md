# Memory Governance

Nuggets is best treated as a small, fast working-memory cache. Durable memory needs additional checks before a fact is allowed to shape future agent behavior.

## State Model

```text
S(t)    = current nugget state: facts, hits, recall scores, freshness, conflicts
S_eq(t) = governed durable context: facts safe enough to promote
Delta S = uncertainty, contradiction, staleness, saturation, or missing provenance
```

The runtime should reduce `Delta S` by abstaining on weak recall, blocking stale or contradicted facts, and only promoting facts that pass quality gates.

## Recall Gates

`Nugget.recall()` returns the legacy fields plus diagnostic fields:

```text
answer
confidence
margin
found
key
abstained
reason
raw_score
entropy
capacity_pressure
top_k
```

Recall can abstain when confidence is low, margin is low, entropy is high under capacity pressure, or the memory is overloaded.

## Promotion Gates

Promotion is no longer only `hits >= 3`. `buildPromotionLedger()` evaluates each fact and records a decision.

A fact can be blocked for:

```text
insufficient_hits
low_confidence
low_margin
contradiction
quarantined
missing_source
expired
```

`promoteFacts()` writes `nuggets-promotion-ledger.json` next to `MEMORY.md`, then promotes only decisions with `state = "promoted"`.

## Capacity Measurement

Run:

```bash
npm run bench:capacity
```

The benchmark reports accuracy, abstention rate, wrong-decode rate, confidence, margin, entropy, and capacity pressure across vector dimensions.
