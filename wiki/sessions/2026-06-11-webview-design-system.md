# Session: Unified webview design system - 2026-06-11

## What was done

- Created a shared design-token module so every webview uses the same background and color scheme. The Replay view's blue-slate palette (`#0f1218` / `#161b22` / `#1c2230`) was chosen as the canonical theme.
- Replaced the per-view `:root` blocks (4+ divergent palettes: flat-black `#0e0e0e`, neutral `#161616`, two blue-slate variants) in all 13 webviews with `designTokensCss()`.
- Migrated `media/tokenCalculator.css` off `--vscode-*` theme variables onto the design tokens (tokens injected from TS via a nonce'd `<style>` tag; CSP updated to allow it).
- Aligned the token calculator's context-fill color ramp with Replay's (`--primary` → `--stage-3` → `--stage-2` → `--stage-1`).
- Documented the system in `wiki/webview/designSystem.md` so future agents follow it.

## Files changed

- `src/webview/designSystem.ts` - **new**: `designTokensCss()` (canonical `:root`) + `baseResetCss()`
- `src/webview/{replayView,sessionsView,sessionCompareView,promptHistoryView,dashboard,charts,pricingView,usageAnalysis,benchmarkView,claudeAccountView,diagnostics,repoAnalysisView,tokenCalculator}.ts` - local `:root` replaced with shared tokens; dashboard loading screen + charts pie borderColor hexes updated to new palette
- `media/tokenCalculator.css` - all `--vscode-*` vars → design tokens; status hexes → semantic tokens
- `media/tokenCalculator.js` - context bar fill colors → token-based ramp
- `wiki/webview/designSystem.md` - **new**: token table + usage rules

## Decisions made

- Token set is a **superset** of every variable any view referenced (`--primary-glow`, `--green`, `--success/--warning/--danger`, `--font-mono` alias), so no view CSS broke when its local `:root` was removed.
- Severity colors unified on Replay's soft heat ramp (`--stage-1..4`); dashboard's old maturity-stage colors (red/pink/blue/green) now follow the same ramp.
- Claude account view keeps its Claude-orange `--primary: #e8621a` as an explicit additive override after the shared block (brand accent), incl. matching `--primary-hover`/`--primary-glow`.
- Token calculator no longer follows the user's VS Code theme — it now matches the extension's own dark theme like every other panel.

## Follow-up / known gaps

- Google-font `@import`s (Inter/JetBrains Mono/Space Grotesk) still present in dashboard/pricing/usageAnalysis/diagnostics/charts but unused since fonts now come from the system stack — could be removed to drop the network request.
- Scattered non-palette inline hexes (e.g. chart series colors) were left as-is; only palette hexes were tokenized.
