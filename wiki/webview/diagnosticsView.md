# Settings / Diagnostics panel

[src/webview/diagnostics.ts](../../src/webview/diagnostics.ts) — `DiagnosticsProvider`. Command: `aiInsights.showDiagnostics`. Nav tab id stays `diagnostics` (internal), label is **"Settings"** and it is the last tab in the shared nav bar (see [core nav ordering](../../src/webview/navShared.ts)).

## Layout (top to bottom)

| Section | Content |
| --- | --- |
| Tiles (`.info` grid, top) | Extension version, VS Code version, platform, Node version |
| ⚙️ All Extension Settings | Every key under `contributes.configuration.properties` in `package.json`, with an editable control and its description |
| 📊 Aggregated Stats | Total sessions, total tokens, cache entries, report timestamp |
| 📦 Providers (bottom) | Per-provider enabled state, session files found, session directories |

The old "📋 Full Report (JSON)" dump/copy-to-clipboard section was removed.

## Settings table

`DiagnosticsProvider.buildSettingsList(context)` reads `context.extension.packageJSON.contributes.configuration.properties` — the schema is not hand-duplicated, so any new setting added to `package.json` shows up automatically. For each key it reads the live value via `vscode.workspace.getConfiguration().get(key, schema.default)` and renders a control based on the schema's `type`/`enum`:

- `boolean` → checkbox
- `enum` present → `<select>`
- `number` → number input
- `array` / `object` → text input holding JSON (parsed client-side on change; invalid JSON turns the border red and does not submit)
- everything else → plain text input

Rows whose live value differs from the schema default get a "modified" badge.

Changing a control fires a `change` event in the webview script, which posts `{ command: 'updateSetting', key, value }`. The panel's `onDidReceiveMessage` handler calls `vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global)`, then re-runs `aiInsights.showDiagnostics` to regenerate the report and refresh the panel. The existing global `onDidChangeConfiguration` listener in `extension.ts` (unrelated to this panel) independently picks up `aiInsights.*` changes and re-runs `refresh()`, so provider-enable toggles etc. take effect without any extra wiring here.

## Extension version bug fix (2026-07-05)

`generateReport()` previously hardcoded `extensionVersion: '0.1.0'` regardless of the actual installed version (`package.json` was already at `0.1.12`+). It now reads `context.extension.packageJSON.version`, so both `generateReport` and `createPanel` require an `ExtensionContext` argument — `showDiagnostics()` in `extension.ts` passes its own `context` through instead of discarding it.

## Panel lifecycle

`DiagnosticsProvider` now follows the same singleton-panel pattern as `UsageAnalysisProvider`: a static `currentPanel` is reused/revealed instead of opening a new `WebviewPanel` every time `aiInsights.showDiagnostics` runs, and the panel wires up `NAV_COMMANDS` + a `refresh` message alongside `updateSetting`.
