# Session: Standalone Electron Host - 2026-10-03

## What was done

- Added a separate Windows x64 portable build using electron-builder, with output `app/ai_insights_win.exe` and a generated standalone package manifest.

- Excluded Settings, A/B Test, and Share from Electron navigation and desktop routing at the user's request. Removed desktop controllers for those views and the desktop share-server lifecycle; extension features remain intact.

- Replaced the custom desktop dashboard with shared extension views and the canonical design system. Added native view-host operations, desktop routing, repository selection, session tools, persisted settings/tags, sharing, CLI/API workflows, and quota access.
- Added six focused host regression tests and GUI checks for rendering/navigation; corrected repository graph script newline escaping.

- Fixed WSL startup hanging on inherited display settings by routing Electron to WSLg's Wayland socket. Verified a real GUI launch reached `AI Insights window ready`; added terminal errors for startup and load failures.

- Added a standalone host service that constructs all providers, scans local logs, uses the persistent parse cache, preserves Copilot snapshots, aggregates metrics, and computes rule-based insights.
- Added an Electron app shell with dashboard, sessions, provider diagnostics, settings, directory picker, and source-file reveal actions.
- Added separate Electron build scripts and output under `dist/electron/`, leaving the extension build output unchanged.
- Documented standalone usage and agent guardrails.

## Files changed

- `src/standalone/config.ts` - standalone defaults, config load/save, provider ids, storage path resolution.
- `src/standalone/service.ts` - host-neutral refresh loop for standalone local analytics.
- `src/electron/main.ts` - Electron main process and IPC handlers.
- `src/electron/preload.ts` - context-isolated renderer bridge.
- `src/electron/renderer.ts` - initial loading screen; final views use shared extension renderers.
- `src/electron/views.ts` - desktop commands, quota access, persistence and shared view routing.
- `src/electron/viewHost.ts` - native implementation of view-controller host operations.
- `src/electron/index.html` - static Electron app document.
- `esbuild.js` - separate Electron bundle mode.
- `tsconfig.electron.json` - Electron host typecheck config.
- `docs/electron-standalone.md` - user-facing standalone build/run docs.
- `docs/agent-instructions.md` - host-boundary instructions for agents.

## Decisions made

- The extension refresh loop was not replaced in this pass. The standalone service is new and additive, which avoids changing extension behavior while enabling a second host.
- Electron uses its own config and storage directory rather than VS Code global storage.
- Editor-only features remain extension-only until they receive dedicated standalone replacements.

## Follow-up / known gaps

- Consider signed installer distribution alongside the unsigned Windows portable executable.
- Consider migrating the extension refresh loop to the shared service after parity testing.
- Consider additional desktop authentication options beyond GitHub CLI and existing Claude login credentials.
