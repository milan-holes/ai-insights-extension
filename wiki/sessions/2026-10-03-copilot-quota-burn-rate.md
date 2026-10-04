# Session: Copilot quota burn-rate fix - 2026-10-03

## What was done

- Replaced snapshot-pair burn rate with GitHub's cycle-to-date usage / days elapsed in cycle
- "Until exhausted" shown only when exhaustion precedes the reset
- Added `test/copilotQuota.test.ts`

## Files changed

- `src/core/copilotQuota.ts` - new `getQuotaPrediction(quota, resetDateUtc, asOf)`; `buildQuotaView(data)` drops history param
- `src/extension.ts`, `src/electron/views.ts` - updated `buildQuotaView` callers
- `test/copilotQuota.test.ts` - prediction + view tests

## Decisions made

- Local snapshot history crossed a plan change (entitlement 10000 → 4000): `remaining` 8498 → 2076 in 24 h was read as 6 422 requests/day, giving "~2d until exhausted" at 5600/6000 remaining. Cycle-to-date is immune to that and counts usage made while the editor was closed.
- Elapsed time floored at 1 day so a cycle's first hours don't extrapolate.

## Follow-up / known gaps

- `QuotaHistoryStore` still records snapshots but nothing reads them for prediction.
- Cycle start assumes reset is monthly (reset date minus one calendar month).
