# Webview Design System

Single source of truth for the look of all webviews: [src/webview/designSystem.ts](../../src/webview/designSystem.ts).

The palette is the Replay view's blue-slate dark theme, adopted as the default for every panel. **Do not define `:root` CSS variables inside a view** — include the shared block instead.

## Usage (mandatory for new/edited webviews)

```ts
import { designTokensCss, baseResetCss } from './designSystem';

// inside the view's <style> block (template literal):
`<style>
${designTokensCss()}   /* :root tokens — always first */
${baseResetCss()}      /* optional: universal reset + body base */
${navCss()}            /* nav system (navShared.ts) consumes the same tokens */
/* view-specific rules — reference var(--…) only, no hardcoded palette hexes */
</style>`
```

For webviews with external CSS (e.g. `media/tokenCalculator.css`), inject `designTokensCss()` via a nonce'd `<style>` tag before the `<link>` — the .css file then only consumes `var(--…)`.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg-base` | `#0f1218` | page background |
| `--bg-surface` | `#161b22` | cards, panels |
| `--bg-surface-high` | `#1c2230` | inputs, buttons, nested surfaces |
| `--border` | `rgba(255,255,255,.08)` | all borders |
| `--text-primary` | `#e5e2e1` | headings, values |
| `--text-secondary` | `rgba(193,198,215,.55)` | labels, captions |
| `--primary` | `#007AFF` | accent, links, active fills |
| `--primary-hover` | `#005ecc` | hover state of primary buttons |
| `--primary-glow` | `rgba(0,122,255,.2)` | glows/shadows around primary |
| `--stage-1` … `--stage-4` | `#f38ba8`, `#fab387`, `#f9e2af`, `#39FF14` | heat ramp, 1 = worst → 4 = best |
| `--danger` / `--warning` / `--success` / `--green` | aliases of stage 1 / 3 / 4 / 4 | semantic status colors |
| `--font-primary` | system sans stack | UI text |
| `--font-data` (alias `--font-mono`) | `'SF Mono','Fira Code','Consolas',monospace` | numbers, code, data |

## Rules

1. New webviews include `designTokensCss()` — never a forked `:root`.
2. View CSS references tokens (`var(--bg-surface)`), not raw hexes from the palette.
3. Brand-accent overrides are allowed only as an *additive* `:root { --primary: …; }` after the shared block. Existing case: Claude account view overrides `--primary` to Claude orange `#e8621a` ([claudeAccountView.ts](../../src/webview/claudeAccountView.ts)).
4. Context-pressure color ramp (shared by Replay and Token Calculator): `<50%` → `--primary`, `<75%` → `--stage-3`, `<90%` → `--stage-2`, else `--stage-1`.
5. JS that sets inline colors should also emit `var(--…)` strings (works in inline styles and gradients).

## Consumers

All webviews: dashboard, charts, sessionsView, sessionCompareView, promptHistoryView, replayView, pricingView, usageAnalysis, benchmarkView, claudeAccountView, diagnostics, repoAnalysisView, tokenCalculator (`media/tokenCalculator.css` + `.js`). [navShared.ts](../../src/webview/navShared.ts) consumes the same tokens.
