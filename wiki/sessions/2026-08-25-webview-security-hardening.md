# Session: webview security hardening - 2026-08-25

Follow-up to a full-tree security review. Implemented the first four steps of
that review's remediation order (SEC-01 through SEC-04); SEC-05 onward remain
open.

## What was done

- **Settings scope (SEC-01).** Added `"scope": "machine"` to the ten settings
  that decide where credentials are sent or which files are read, so a
  repository's `.vscode/settings.json` can no longer override them.
- **Output escaping (SEC-02, SEC-03).** Added shared `escapeHtml`/`escJs`
  helpers and applied them to every session-derived sink found in `dashboard.ts`
  (six, not the three originally reported); rebuilt `sessionCompareView.ts`'s
  `esc()`, whose `textContent`->`innerHTML` round-trip did not escape quotes.
- **CSP (SEC-02).** Added `default-src 'none'` + per-render script nonce to the
  nine panels that had none, and converted ~40 inline event-handler attributes
  to delegated `data-*` listeners so they still work under the policy.
- **Vendored libraries (SEC-04).** Chart.js and Mermaid now ship in
  `assets/vendor/` instead of loading from `cdn.jsdelivr.net`.
- **Bonus (found while fixing).** `diagnostics.ts`'s `updateSetting` handler
  relayed an arbitrary *global* VS Code settings write from webview content —
  which would have bypassed the SEC-01 fix entirely. Now allowlisted to this
  extension's own contributed keys with a schema type check.

## Files changed

- `package.json` - `"scope": "machine"` on 10 settings; `vendor:assets` script; mermaid devDependency
- `scripts/vendor-assets.sh` - new; copies chart.js + mermaid out of node_modules
- `assets/vendor/{chart.umd.min.js,mermaid.min.js}` - new; vendored libraries
- `src/webview/navShared.ts` - new `escapeHtml`, `escJs`, `cspMeta`, `cspNonce`, `webviewAssets`
- `src/webview/dashboard.ts` - escaped repo label, MCP tool/server names, sharing error; CSP; nonces; delegated handlers
- `src/webview/sessionCompareView.ts` - `esc()` rewritten; CSP; nonces
- `src/webview/sessionsView.ts` - CSP; nonces; 20 inline handlers converted
- `src/webview/{promptHistoryView,replayView,pricingView,charts,usageAnalysis,diagnostics}.ts` - CSP; nonces; handlers converted
- `src/webview/repoAnalysisView.ts` - mermaid served locally; CDN origin dropped from its CSP
- `wiki/webview/security.md` - new; the rules above, written down

## Decisions made

- **One shared escaper, not per-file.** Three different `esc()` implementations
  already existed and one of them was wrong. `navShared.ts` now owns both the
  TypeScript and the injected-JS version so they cannot drift.
- **`esc()` keeps `String(s||'')`.** The rewritten client-side escaper preserves
  the old falsy handling (`0` renders as empty) so the fix stays security-only
  and does not change any displayed value.
- **Mermaid as a devDependency, vendored file committed.** Only the built
  browser bundle ships; the dependency exists so `vendor:assets` can refresh it.
  Costs ~3.3 MB in the package - accepted over auto-executing an unpinned
  `mermaid@10` release in a privileged webview.
- **`style-src 'unsafe-inline'` retained.** The views are built almost entirely
  from inline `style=` attributes; rewriting that is a large refactor with no
  security gain, since inline styles cannot execute script.
- **`connect-src https://api.anthropic.com` left in `repoAnalysisView`'s CSP.**
  The Anthropic call is host-side, so the allowance looks stale, but removing it
  was outside this change and carries a small regression risk.

## Verification

- `npm run compile` (tsc + esbuild) clean.
- Rendered `sessionCompareView.buildHtml` against a stubbed `vscode` module with
  a malicious session title (`sess" onmouseover="alert(1)`) and shell command
  (`git commit -m "x" onmouseover="alert(2)`): CSP present, zero script tags
  without a nonce, no remote script `src`, and both payloads escaped to
  `&quot;` so neither closes the `title` attribute.
- Static sweeps: no `jsdelivr`/`unpkg`/`cdnjs` references remain in `src/`, no
  panel lacks a CSP, no inline handler attributes remain.
- `npm audit --omit=dev`: 0 vulnerabilities (the 10 dev-tree advisories come
  from `@vscode/vsce`, `eslint` and `esbuild` and predate this work).
- `npm run lint` could not run - the repo has no ESLint config file. Pre-existing.

## Follow-up / known gaps

- SEC-05..SEC-15 from the review are untouched. The next three by value:
  validate the `openExternal` URI scheme (`extension.ts:368`); restrict
  `openFile`/`openSession` to known session directories; validate `msg.variants`
  host-side before variant ids reach `git worktree add -b ${branch}`.
- The team-server upload still sends a raw GitHub OAuth token with no `https:`
  requirement and no prompt naming the destination host. Machine scope stops a
  *workspace* from redirecting it; it does not make the transport safe.
- The webview panels were verified by rendering their HTML, not by driving the
  real UI in VS Code. The delegated-listener conversions (~40 controls) would
  benefit from a manual click-through of each panel.
