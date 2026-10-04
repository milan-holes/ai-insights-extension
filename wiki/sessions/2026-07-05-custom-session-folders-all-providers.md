# Session: Custom session folders for every provider - 2026-07-05

## What was done

- Generalized the "extra folders to scan for sessions" capability that previously only existed for Claude Code (`aiInsights.providers.claudeCode.additionalSessionPaths`) to all six providers: GitHub Copilot, Antigravity, Codex, GitHub Copilot for JetBrains, and Visual Studio each get their own `aiInsights.providers.<id>.additionalSessionPaths` array setting.
- Added a shared `expandHome(p)` helper on `BaseProvider` (leading `~` → `os.homedir()`) and switched `ClaudeCodeProvider` to use it instead of its own inline `.replace(/^~/, os.homedir())`, so all six providers expand `~` the same way.
- Wired each new setting through `getEnabledProviders()` in `src/extension.ts` into the matching provider's constructor.
- Because the settings panel (`src/webview/diagnostics.ts`, renamed to "Settings" earlier today) reads its settings list dynamically from `package.json`'s configuration schema rather than a hand-written list, all 5 new settings show up there automatically with an editable JSON-array control - no changes needed in that panel.

## Files changed

- `package.json` - 5 new `additionalSessionPaths` array settings (copilot, antigravity, codex, jetbrainsAI, visualStudio).
- `src/providers/base.ts` - new `protected expandHome(p)` helper.
- `src/providers/claudeCode.ts` - use the shared helper instead of its own inline expansion.
- `src/providers/codex.ts` - constructor takes `additionalPaths`; extra dirs walked the same way as `$CODEX_HOME/sessions` (recursive, matching `rollout-*.jsonl`).
- `src/providers/jetbrainsAI.ts` - constructor takes `additionalPaths`; extra roots merged straight into the existing `sessionRoots` set (each root already scanned generically for `partition-N.jsonl`).
- `src/providers/visualStudio.ts` - constructor takes `additionalPaths`; extra roots appended to `buildScanRoots()`'s output (already scanned generically for `.vs/**/copilot-chat/**/sessions/*`).
- `src/providers/copilot.ts` - constructor takes a 4th `additionalPaths` param; extra dirs added to `sessionDirs`, which fall into the existing generic recursive-scan branch in `discoverSessionFiles()` (the branch used for anything that isn't a recognized `workspaceStorage`/`.copilot/session-state` layout).
- `src/providers/antigravity.ts` - the one non-trivial case; see below.
- `README.md` - added a `additionalSessionPaths` row to the Settings table.
- `wiki/providers/base.md` - new "Custom session-folder paths" section with a per-provider table of what an "additional path" means for that provider.
- `wiki/providers/antigravity.md` - new section documenting the multi-root refactor.

## Decisions made

- **Antigravity needed a real refactor, not just appending to a directory list.** Its default layout is two *correlated* directories - `~/.gemini/antigravity/brain/<id>/...` and `~/.gemini/antigravity/conversations/<id>.pb` - not one flat folder, so an "additional path" for this provider means an extra *home-style root* that itself contains both `brain/` and `conversations/` subfolders, not a single directory of loose files. `AntigravityProvider` now holds `roots: {brainDir, conversationsDir}[]` (`[default, ...additional]`) and runs the existing two-phase discovery scan once per root.
- **Found and fixed a latent cross-root correlation bug while doing that refactor**: `parsePbSession()`, `extractWorkspaceFromBrain()`, and `extractTitleFromBrain()` all read `this.brainDir` directly (a single fixed field). With multiple roots, a `.pb` file discovered under an *additional* root would incorrectly look for its metadata under the *default* root's `brain/` directory (since conversation IDs aren't guaranteed unique across roots), silently producing the wrong workspace/title or falling back to none at all. Fixed by deriving the correct `brainDir` per file from the `.pb` file's own path (`<root>/conversations/<id>.pb` → sibling `<root>/brain`) instead of trusting instance state. `parseOverviewSession()` already derived its root this way (`path.resolve(filePath, '..','..','..')`) and needed no change - only the `.pb`-without-`overview.txt` fallback path had the bug.
- Verified the fix with a standalone smoke test (`tsc`-compiled `antigravity.js` run directly under Node with a fake `HOME` for the default root plus a second fixture directory passed as `additionalPaths`): both roots' sessions were discovered, and each resolved its own root's `task.md.metadata.json` title correctly instead of one root shadowing the other.
- Did not add a dedicated list-editor UI for these array settings in the Settings panel (they use the existing generic JSON-text-input control, same as `claudeCode.additionalSessionPaths` before this change) - out of scope, tracked as a known gap on that panel already.

## Follow-up / known gaps

- No validation in the Settings panel or providers that an antigravity additional path actually contains `brain/`/`conversations/` subfolders - a wrong path is just silently empty (consistent with how every provider already handles a missing/wrong directory).
