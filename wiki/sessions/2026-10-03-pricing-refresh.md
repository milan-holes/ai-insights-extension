# Session: model pricing refresh (GPT-6 / Claude x.5 / Kimi K3) - 2026-10-03

## What was done

- Re-verified every `modelPricing.json` entry against the two canonical sources (GitHub Copilot models & pricing, Anthropic pricing).
- Corrected one real price change: **GPT-5.6 Sol** $2.00/$10.00 -> $4.00/$20.00 per 1M in/out (long-context $4.00/$15.00 -> $8.00/$30.00). No other existing rate moved.
- Added 19 models: `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-astra` (+ long-context each), `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-fable-5.1`, `claude-mythos-5.1`, `claude-opus-5-fast`, `claude-opus-5.5-fast`, `gemini-3.8-flash`, `grok-4.7` (+ long-context), `kimi-k3`.
- Marked 10 models `copilotOfficial: false` after confirming (second targeted fetch of the same page) they are no longer in Copilot's catalog: `claude-sonnet-4.5`, `claude-opus-4.5/4.6/4.7`, `gemini-3.1-pro` (+ long-context), `gemini-3.5-flash`, `gemini-3.6-flash`, `mai-code-1-flash`, `raptor-mini`. Rates kept so historical sessions still cost out.
- Added `moonshot` as a rendered provider in the Pricing panel.
- 51 -> 69 model entries. `lastUpdated` 2026-08-25 -> 2026-10-03.

## Files changed

- `src/data/modelPricing.json` - rates, new entries, `copilotOfficial` flips, key reordering.
- `src/webview/pricingView.ts` - `moonshot` added to `PROVIDER_LABELS` and `providerOrder`.
- `wiki/core/costEstimation.md` - new "Key order is load-bearing" and "Supported `provider` values" sections.
- `CHANGELOG.md` - 0.1.17 section.

## Decisions made

- **Key order**: new `.5`/`.1` keys are inserted *before* their shorter siblings, because `findModelPricing()`'s substring strategy returns the first key contained in the model id - `claude-opus-5` would otherwise shadow `claude-opus-5.5` for datestamped ids. Verified no remaining same-price-differing shadowing pairs beyond the pre-existing `*-long-context` / `*-fast` ones (which resolve via exact match).
- **Non-Anthropic cache-write rates omitted**: GitHub now publishes a cache-write column for the GPT-5.6/GPT-6 families (e.g. GPT-6 Sol $2.50/1M), but the schema convention keeps `cacheCreationCostPerMillion` Anthropic-only, so `calculateCost()` still bills non-Anthropic cache writes at the full input rate. Left as-is deliberately; see gap below.
- **Delisted models keep their rates** and only lose the `copilotOfficial` badge - deleting them would break cost estimation for sessions already recorded against them.
- **`moonshot` wired in, `github`/`microsoft` not** - only enough UI change to make the newly added `kimi-k3` row visible (0.1.16 had skipped Kimi K3 for exactly this reason). The pre-existing `github`/`microsoft` display gap is untouched.
- **Fast mode**: added the two entries Anthropic's fast-mode table lists that were missing (`claude-opus-5-fast` $10/$50, `claude-opus-5.5-fast` $8/$40). Marked `copilotOfficial: false` - Copilot's catalog lists only Opus 4.8 fast mode.

## Follow-up / known gaps

- Non-Anthropic cache writes are billed at input rate (see above). Adding `cacheCreationCostPerMillion` to the OpenAI entries would make GPT-5.6/GPT-6 estimates ~25% more accurate on cache-write tokens; needs a schema-convention decision first.
- `providerOrder` in `pricingView.ts` still excludes `github`/`microsoft`, so `raptor-mini` and `mai-code-*` never render. One-line fix when wanted.
- Category/tier values for delisted models were left at their last-known Copilot tier (e.g. `gemini-3.1-pro` stays `Powerful`), unlike earlier delistings which were moved to `Legacy`. The file is inconsistent on this; no rule exists yet.
- Claude 4.7+ models use a tokenizer producing ~30% more tokens for the same text. Per-token rates are unaffected, but any cross-model token *count* comparison in the extension's charts is not apples-to-apples. Not modelled anywhere.
