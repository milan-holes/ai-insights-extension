# Standalone Electron Host

## Purpose

The Electron host lets AI Insights run outside the editor extension while reusing the same provider parsers, cache, snapshots, and aggregation logic.

It is additive: the extension remains the full editor-integrated host, and Electron has a separate build output under `dist/electron/`.

## Entry Points

| File | Role |
| --- | --- |
| [../src/electron/main.ts](../src/electron/main.ts) | Electron main process, window creation, IPC handlers |
| [../src/electron/preload.ts](../src/electron/preload.ts) | Context-isolated API bridge |
| [../src/electron/renderer.ts](../src/electron/renderer.ts) | Initial loading screen using the shared design tokens |
| [../src/electron/views.ts](../src/electron/views.ts) | Routes shared view controllers and desktop commands |
| [../src/electron/viewHost.ts](../src/electron/viewHost.ts) | Desktop implementation of the view controllers' host operations |
| [../src/electron/index.html](../src/electron/index.html) | Static shell copied to `dist/electron/index.html` |
| [../src/standalone/service.ts](../src/standalone/service.ts) | Host-neutral provider refresh, cache, snapshots, aggregation |
| [../src/standalone/config.ts](../src/standalone/config.ts) | Standalone config defaults, persistence, provider list |

## Data Flow

```text
Shared extension view HTML
  -> acquireVsCodeApi-compatible preload bridge
  -> view:command IPC
  -> DesktopViews + desktop viewHost
  -> StandaloneInsightsService / repository / CLI / API services
  -> same HTML renderers and chart assets as the extension
```

## Provider Coverage

The standalone service constructs every provider currently supported by AI Insights:

| Provider id | Provider class |
| --- | --- |
| `copilot` | `CopilotProvider` |
| `antigravity` | `AntigravityProvider` |
| `claudeCode` | `ClaudeCodeProvider` |
| `codex` | `CodexProvider` |
| `jetbrainsAI` | `JetBrainsAIProvider` |
| `visualStudio` | `VisualStudioProvider` |

Provider settings mirror the extension's local scanning settings: enabled/disabled toggles and additional session paths. Copilot also keeps standalone equivalents for input multiplier, cache-estimation mode, and max snapshots.

## Build

```bash
npm run electron:compile
npm run electron:test
npm run electron:start
npm run electron:package
npm run electron:build:win
```

The extension build is unchanged:

```bash
npm run compile
npm run package
```

`tsconfig.json` excludes `src/electron` so the extension typecheck does not depend on Electron. `tsconfig.electron.json` typechecks the Electron and standalone host with DOM types.

`src/electron/package.cjs` generates a minimal desktop manifest in
`dist/electron/`, then uses electron-builder's Windows x64 portable target to
produce `app/ai_insights_win.exe`. The runtime is bundled; the extension
manifest and dependencies are excluded. Output is unsigned and Git-ignored.
Linux/WSL builds download the Windows runtime and NSIS tools on first use.

The window icon and Windows packaging icon both use `assets/logo.png`.
Keep Windows resource editing enabled so the executable receives the app icon;
use `signExecutable: false` for unsigned builds rather than disabling resource editing.

## Launch Diagnostics

`npm run electron:dev` builds only the Electron bundles and launches through
`src/electron/launch.cjs`. The launcher clears `ELECTRON_RUN_AS_NODE`. In WSL,
when `/mnt/wslg/runtime-dir/wayland-0` exists, it uses that runtime directory and
`--ozone-platform=wayland` rather than inherited remote-shell display settings.
Set `AI_INSIGHTS_ELECTRON_USE_SYSTEM_DISPLAY=1` to keep a custom display setup.
The existing WSL sandbox opt-in is `AI_INSIGHTS_ELECTRON_SANDBOX=1`.

Successful window loading prints `[electron] AI Insights window ready`.
Process spawn, app initialization, and page-loading failures print terminal errors.
Agents should verify that readiness message: a running process alone does not
prove that a window was created. Run GUI verification outside command sandboxes.

## Storage

Standalone storage is resolved by `standaloneStorageDir()`:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%/ai-insights` |
| macOS | `~/Library/Application Support/ai-insights` |
| Linux | `$XDG_CONFIG_HOME/ai-insights` or `~/.config/ai-insights` |

Files:

- `standalone-config.json`
- `session-parse-cache.json`
- `copilot-session-snapshots.json`
- `desktop-state.json` (repository selection, session tags, plans, dismissed insights,
  quota history, and OS-encrypted API keys)
- `desktop-view.html` (current rendered view)

## View Parity

Electron bundles the existing `src/webview/*` controllers. Only its main build
aliases their `vscode` dependency to `src/electron/viewHost.ts`; the extension
still resolves the real editor API. This adapter implements the limited API
surface the views need, not a general editor emulator. Shared design tokens,
HTML, Chart.js, Mermaid, logo, and calculator assets are reused verbatim.

The desktop toolbar adds repository selection and a Tools menu for views that
are not in the shared navigation. It is also available in calculator and replay.

| Feature | Desktop behavior |
| --- | --- |
| Dashboard, periods, charts, health and insights | Shared renderer and calculations; five-minute refresh |
| Sessions | Shared filters, sorting, pagination, exports, analysis overlay, tags, comparison, replay |
| Prompt history, pricing, budget planner, workspaces | Shared views and persisted planner settings |
| Calculator | Text and files from the selected repository; editor-tab input unavailable |
| Repository structure, module graph, handoff | Selected directory; native file opening; API enrichment with an OS-encrypted key |
| Benchmark | Existing CLI/direct API engines, worktrees and exports; editor-only model adapters unavailable |
| Settings, A/B Test, Share | Excluded from Electron controls and command routing; unchanged in the extension |
| GitHub quota | Explicit Connect uses `gh auth token` after `gh auth login`; no token is persisted |
| Claude quota | Enable `providers.claudeCode.readLiveQuota` in `standalone-config.json` and restart; same credential reader and quota fetcher, throttled to five minutes |

Status bar, selection highlighting, editor model access, inline acceptance/diff
events, and active editor attachments cannot be observed by this desktop host.
Do not present missing editor telemetry as measured data. API keys require an
OS keyring; plaintext fallback is rejected.

## Host Boundary Rules

- `src/electron/*` may import Electron and the standalone service.
- `src/standalone/*` must stay free of `vscode` and Electron imports.
- `src/providers/*` must stay host-neutral.
- Editor-only features stay in the extension until a standalone replacement exists.
- Reuse existing views and `designTokensCss()` rather than creating an Electron palette.
- Keep the `vscode` alias confined to the Electron main bundle. Never apply it to extension builds.
- Keep desktop exclusions in `src/electron/viewPolicy.ts`. Hide their shared-view controls in the preload and reject their commands before controller dispatch. Settings, A/B Test, and Share must not be reintroduced in Electron navigation.
