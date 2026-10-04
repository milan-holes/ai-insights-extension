# Session: configurable context window (GitHub issue #1) - 2026-10-03

## What was done

- Evaluated [issue #1](https://github.com/milan-holes/ai-insights-extension/issues/1) ("Shouldn't `CONTEXT_LIMIT_TOKENS` be configurable?") and found the hardcoded `200_000` in **three** places, not one — two of which affect every provider, not just Claude Code.
- Added `contextWindowTokens` to all 64 models in `modelPricing.json` that have a published window; 5 models with no published figure deliberately omit it.
- Added `src/core/contextWindow.ts` as the single resolver: override → model table → 128K default.
- Added the `aiInsights.context.limitTokens` setting (default `0` = resolve from the model).
- Replaced every hardcoded limit in `contextRot.ts` and `liveContextTracker.ts`, and converted the absolute 160K/80K context-pressure thresholds to fractions of the resolved window.
- Fixed the replay panel's context fill bar, which normalized to the session's own peak and so always ended at 100%.
- Retired the token calculator's private `CONTEXT_WINDOWS` map, which had drifted a generation behind (Opus 4.6/4.7 and Sonnet 4.6 listed at 200K; no Opus 5 / Sonnet 5 entry at all).
- Two adjacent bugs found and fixed while wiring it: `liveContextTracker` omitted `cacheWriteTokens` from the live figure, and `normalizeModelName()` never matched dash-versioned API model ids.
- Added `test/contextWindow.test.ts` (6 resolver cases + 4 metric cases).

## Files changed

- `src/core/contextWindow.ts` - **new**; resolver, override state, `contextFillPct`
- `src/data/modelPricing.json` - `contextWindowTokens` per model + `metadata.contextWindowNotes`
- `src/core/costEstimation.ts` - exported `findModelPricingEntry` and `normalizeModelName`; normalization now strips date snapshots and maps `claude-opus-4-8` → `claude-opus-4.8`
- `src/core/contextRot.ts` - window threaded through runway, lost-in-the-middle, score and `large_static_context`; `CTX_PRESSURE_HIGH/MEDIUM` and `LOST_IN_MIDDLE_ONSET_TOKENS` constants
- `src/core/liveContextTracker.ts` - resolved limit + `contextLimitSource`; uses `effectiveContextTokens`
- `src/types.ts` - `contextWindowTokens` / `contextWindowSource` on `ContextRotAnalysis`
- `src/extension.ts` - applies the setting on activation and on config change; tooltip shows the limit's source
- `src/webview/replayView.ts` - fill bar uses the model window; `Peak Context` card now reads "of N window"
- `src/webview/tokenCalculator.ts`, `media/tokenCalculator.js` - windows come from the shared table via `window.TC_CONTEXT`
- `src/webview/sessionsView.ts` - score tooltip describes window-relative pressure
- `package.json` - `aiInsights.context.limitTokens`
- `test/contextWindow.test.ts` - **new**

## Decisions made

- **Model table *and* a setting, not just a setting.** The 1M window on Claude Sonnet/Opus is a gated opt-in and nothing in the JSONL records it (`message.context_management` exists in the schema but is null in practice), so model ID alone would over-report headroom. The table gets the common case right without configuration; the setting covers what the table cannot know.
- **Context windows live in `modelPricing.json`, not a second table.** It already carries one row per model with source URLs and an update skill, and the key-order-sensitive lookup is already written. A separate file would drift exactly the way `media/tokenCalculator.js` did.
- **Pressure thresholds became proportional; the lost-in-the-middle onset stayed absolute.** Window fill is inherently relative, but attention degradation on mid-context content is an empirical property of the model, not a fraction of however large the window is — so LiM keeps its absolute 60K onset and only its ramp scales to the window.
- **Session window resolves from the most recent turn's model**, not the widest used. In a session that switched models, "how much room is left" is a question about the model you are on now.
- **Override is module state, not a `vscode` read.** `contextRot.ts` is pure and UI-free; `extension.ts` pushes the setting in via `setContextWindowOverride()`.
- **The limit's provenance is shown in the status-bar tooltip** (`(setting)` / `(default - model unknown)`), so a wrong denominator is visible rather than silently baked in.

## Follow-up / known gaps

- **OpenAI and xAI windows are Copilot *billing thresholds*, not vendor context-window figures** - Copilot's pricing page documents where long-context billing starts (272K for most GPT-5.4+/6.x, 200K for GPT-5.6 Luna and Grok 4.x), which is the right order of magnitude but not the published maximum. Worth re-verifying against OpenAI's and xAI's own API docs.
- No window published for `raptor-mini`, `mai-code-1-flash`, `mai-code-1.1-flash`, `kimi-k3`, `goldeneye` - these fall back to 128K.
- `contextRunway` now returns large values on 1M-window models (~900 turns on a typical Opus 5 session). Honest, but "~903 turns left" is not a useful chip - consider capping the display at e.g. 99+.
- `aiInsights.context.limitTokens` is global. A per-provider or per-model override would be better for users who run Haiku and Opus side by side, but nothing in the issue asks for it yet.
- `npm run lint` fails for an unrelated pre-existing reason: no ESLint config file exists in the repo.
