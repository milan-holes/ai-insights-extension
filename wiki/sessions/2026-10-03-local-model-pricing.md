# Session: local and own-key model pricing - 2026-10-03

## What was done

- Chats in VS Code Chat served by local models (Ollama, LM Studio, llama.cpp via the "OpenAI Compatible" endpoint) now cost $0 and are tagged "Local", instead of being priced at the $2/$8 fallback and counted as Copilot spend.
- Chats on the user's own API key are priced at the vendor list rate in the `direct` shape, with no Copilot calibration; $0 (`unpriced`) when the model is not in the table.
- The Copilot provider keeps the `<vendor>/` prefix, rejoins a bare id with `selectedModel.metadata.vendor`, and never falls back to `gpt-5-mini` when a non-Copilot vendor is known.
- The debug-log merge no longer renames a non-Copilot model to the bare id found in the log.
- Pricing-table lookup matches whole names only, longest key first.
- Triggered by GitHub issue #2 ("This works also for local models?").

## Files changed

- `src/core/modelNames.ts` - `modelHosting()`, `modelVendor()`, `stripModelVendor()`, `isLocalModel()`
- `src/core/costEstimation.ts` - hosting-aware `calculateCostBreakdown()` / `resolveInteractionCost()` / `findModelPricingEntry()`; `containsModelKey()` boundary matching
- `src/types.ts` - `PricingSource` (`official` | `fallback` | `local` | `unpriced`)
- `src/providers/copilot.ts` - vendor-aware `getModelFromRequest()`, debug-log merge guard
- `src/webview/pricingView.ts` - "Local" / "Own key" tags, `–` cost cells, model name now HTML-escaped
- `src/webview/sessionsView.ts` - "Local" tag on model chips
- `test/modelHosting.test.ts` - classification, pricing, matching, and Copilot parsing tests

## Decisions made

- Hosting is derived from the model string, not a new `Interaction` field: about ten call sites price by model name alone (budget, replay, prompt history), and all of them get the right answer without changes.
- A local turn reports cost source `billed`: its $0 is exact, and `estimated` would downgrade a fully billed session's provenance label.
- `customoai` counts as local. The session log does not store the endpoint URL, so a hosted endpoint configured that way is counted as local too.
- Unknown own-key models get $0 (`unpriced`), not the fallback rate: a guess at a generic rate would read as a real figure.
- Lookup change measured on 98 names: 2 changed key, both `*-mini-<date>` moving from the full model to the correct mini entry.

## Follow-up / known gaps

- Not checked against a real session from a local model; the `modelId` / `selectedModel.metadata.vendor` layout is assumed from how Copilot models are recorded.
- Own-key spend at list rate is still added to the Copilot provider's monthly cost, which the pricing view reads as AI Credits used.
- `getModelFromRequest()` returns its `fallback` argument before the `toolCallRounds` / `details` heuristics, so those never run for chatSessions (both call sites pass a non-`auto` fallback). This was already the case before this change and is left as is.
