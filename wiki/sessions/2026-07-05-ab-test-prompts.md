# Session: A/B Test Prompts across providers - 2026-07-05

## What was done

- Added a new "A/B Test Prompts Across Providers" feature: a user picks one prompt plus any number of provider/model variants (Claude Code, GitHub Copilot, Codex), each variant runs the prompt headlessly in its own throwaway `git worktree`, and the panel then offers to open any worktree in a new VS Code window for manual follow-up comparison.
- Reused the existing Technique Benchmark's `BenchmarkAdapter` interface (`src/benchmark/adapters.ts`) instead of duplicating CLI/API plumbing.
- Extended `ClaudeCodeCliAdapter` with an optional `model` constructor param (`--model` flag).
- Added a new `CodexCliAdapter` (`codex exec --json`, best-effort JSONL parsing, estimated-token fallback) — no Codex CLI was available locally to verify the exact JSONL event schema, so this is a best-effort implementation with graceful degradation, same pattern as the existing Claude Code adapter's fallback.

## Files changed

- `src/abtest/types.ts` - new: `AbVariant`, `AbTestConfig`, `AbVariantResult`, `AbTestProgress`
- `src/abtest/worktree.ts` - new: `isGitRepo`, `setupAbTestWorktree`, `teardownAbTestWorktree`
- `src/abtest/runner.ts` - new: `runAbTest` — sequential per-variant execution + progress callback
- `src/webview/abTestView.ts` - new: `AbTestViewProvider` panel (config UI, git-repo warning, result cards, open-in-new-window, cleanup)
- `src/benchmark/adapters.ts` - `ClaudeCodeCliAdapter` takes optional `model`; added `CodexCliAdapter`
- `src/extension.ts` - registered `aiInsights.showAbTest` command
- `package.json` - added command entry
- `CHANGELOG.md` - entry under `[Unreleased]`

## Decisions made

- **Automated execution, not purely manual**: the extension runs the prompt via each provider's adapter automatically and shows results in-panel, in addition to (not instead of) letting the user open worktrees in new windows for further manual inspection — confirmed with the user before implementing, since "open each worktree in a new VS Code window" alone was ambiguous between manual-only and automated-plus-manual.
- **Single prompt per run**, not a multi-prompt suite (also confirmed with the user) — keeps the UI to one textarea instead of a saved prompt-list manager.
- **New standalone panel/command** (`aiInsights.showAbTest`) rather than folding into the existing Benchmark panel, since the two features have different goals (technique/context-loading benchmarking with LLM-judge scoring vs. raw provider/model comparison with manual follow-up) and the Benchmark tab is already hidden from nav (see `2026-07-01-nav-reorg-and-heatmap-lookback.md`).
- **Worktrees survive the run** — unlike the Technique Benchmark's `runner.ts`, which tears down each worktree immediately in a `finally` block, `runAbTest` deliberately leaves worktrees in place after a run so "Open in New Window" still has a target; a separate "Clean up worktrees" button in the panel calls `teardownAbTestWorktree` per variant.
- **Sequential, not parallel, variant execution** — avoids concurrent `git worktree add`/CLI contention in the same repo; a run's wall time scales with variant count.
- **Reused `src/benchmark/adapters.ts` rather than forking it** — its `BenchmarkAdapter` interface already abstracted Claude Code CLI, Copilot `vscode.lm`, and Anthropic API calls; only needed a `model` param on the Claude adapter and a new Codex adapter. Deliberately did *not* touch `AdapterId`/`ADAPTER_DEFS`/`buildAdapter`, since those are a closed union tied to Technique Benchmark's specific model list — A/B testing needed a free-typed Codex model id and Claude Code model aliases that don't fit that closed set, so `src/abtest/runner.ts` has its own small `buildAbTestAdapter` factory instead.

## Follow-up / known gaps

- Codex CLI's `--json` event schema is unverified against a real installation — flag if real-world Codex output doesn't parse (`parseCodexJsonlOutput` in `src/benchmark/adapters.ts` falls back to raw stdout + estimated tokens if nothing parses as JSON).
- No LLM-judge scoring (unlike Technique Benchmark) — by design, since comparison here is meant to be manual/qualitative.
- Variants run sequentially; a "run in parallel" mode could be added later if wall time becomes a complaint.

## Follow-up session (same day): nav bar entry + code-produced/tokens/time recap stats

### What was done

- Added "A/B Test" to the shared cross-panel nav bar (was only reachable via Command Palette before).
- Added a third recap stat per result card, "Code produced" (alongside the existing tokens and wall time), measured via real `git diff` for CLI adapters and estimated from response code blocks for Copilot.

### Files changed

- `src/webview/navShared.ts` - added `'abTest'` to the `NavTab` union, an active (uncommented) `NAV_TABS` entry, and `showAbTest` to `NAV_COMMANDS`
- `src/webview/abTestView.ts` - now renders `navTopbarHtml`/`navPagebarHtml`/`navJs` like every other panel instead of a bespoke `<h1>` header; handles `NAV_COMMANDS` messages so its own nav clicks route to other panels; result cards render a `.stat-tiles` row (Tokens / Code produced / Time) instead of a plain text meta line
- `src/abtest/types.ts` - new `AbCodeStats` (`linesAdded`, `linesDeleted`, `filesChanged`, `estimated`), added as `AbVariantResult.codeStats`
- `src/abtest/worktree.ts` - new `measureCodeProduced(worktreePath, responseText)` + private `estimateCodeFromResponse`
- `src/abtest/runner.ts` - calls `measureCodeProduced` right after a variant's adapter call succeeds, non-fatal (`.catch(() => undefined)`)
- `CHANGELOG.md` - two more `[Unreleased]` entries

### Decisions made

- **"Code produced" is real for CLI adapters, estimated for Copilot — by construction, not a shortcut.** Claude Code CLI and Codex CLI run with real file/tool access inside their worktree (they can actually create/edit files), so `git add -A` (to catch brand-new untracked files, not just edits) + `git diff --cached --numstat HEAD` gives a real, verifiable line count. GitHub Copilot's variant only ever calls `vscode.lm.sendRequest` — it has no file access and never touches the worktree — so its diff is always empty by design, and the fallback (counting non-blank lines inside fenced code blocks in the chat response) is the only signal available. Both paths return the same `AbCodeStats` shape with an `estimated` flag so the UI can label the Copilot numbers "estimated from response" rather than implying a real diff.
- **Staging (`git add -A`) is safe here** because these worktrees are always either handed to the user next (as a review-ready diff in Source Control) or torn down by "Clean up worktrees" — never merged back automatically.
- Verified both code paths (real git-diff and text-fallback) and worktree cleanup end-to-end against this repo before considering it done (see prior smoke test in this same session).

### Follow-up / known gaps

- `git add -A` respects `.gitignore`, so build artifacts an agent's tool calls might generate (e.g. `npm install` writing `node_modules/`) won't inflate the diff — but anything *not* gitignored that the agent happens to touch (e.g. lockfiles) will count as "code produced" too, which can be misleading for large auto-formatted or dependency-lock changes. Not addressed yet.

## Follow-up fix (same day): attach active editor as context

### What was done

User reported the Copilot variant returning something like *"I need the code first — I can't access your active VS Code file directly"* for a prompt that assumed ambient context. Root cause: `CopilotAdapter` is a bare `vscode.lm.sendRequest` call with no tools and no implicit editor context — unlike real Copilot Chat (which auto-attaches the open file), it only ever received the raw prompt string. Fixed by snapshotting the active editor (selection, or full document if nothing's selected) and prepending it to the prompt for **every** variant, not just Copilot.

### Files changed

- `src/webview/abTestView.ts` - added `getActiveFileSnapshot(workspaceRoot)`, `buildPromptWithContext(prompt, snapshot)`, a sidebar "Attach active editor as context" checkbox (default on) + live status line, an `activeFileInfo` message posted on panel open and on `onDidChangeActiveTextEditor`/`onDidChangeTextEditorSelection`, and disposal of both listeners in `onDidDispose`
- `CHANGELOG.md` - one more `[Unreleased]` entry

### Decisions made

- **Applied to all three variants, not just Copilot** — even though Claude Code CLI and Codex CLI could in principle read a named file themselves via tools, giving every variant identical explicit grounding is the more correct experimental design for an A/B comparison (apples-to-apples input), not just a Copilot-specific patch.
- **Snapshot taken at `runAbTest` message-handler time**, not at panel-open time — `vscode.window.activeTextEditor` is queried fresh when the user clicks Run, so it reflects whichever editor/selection was last focused, even though focus has since moved into the webview (VS Code keeps returning the last real text editor rather than `undefined` once a non-editor part of the UI has focus).
- **Default-on with a visible toggle + live status label**, not silently forced — the sidebar shows "Will attach full file `<path>` (N lines)" / "Will attach selection in `<path>`" / "No active file detected" so the user always knows what's about to be sent, and can turn it off to test a context-free prompt deliberately.
- Capped attached content at 20,000 chars (`MAX_ATTACH_CHARS`) to avoid an unbounded prompt/cost blowup from very large files; truncation is flagged in the prepended note.

## Follow-up investigation (same day): "still see the same refusal" report

### What was done

User reported still seeing an identical refusal-style response ("Cannot analyze dead code yet because no source file was provided") after the fix above, for a whole-project "find dead code" prompt. Investigated by reproducing the exact CLI adapter invocation against a real worktree of this repo (`claude -p` with a dead-code prompt, cwd = worktree) — it did *not* refuse; it started actively working and was still going (real tool calls, not a fast bail-out) when a 2-minute smoke-test timeout cut it off, showing CLI tool access itself works fine and whole-repo analysis is just a genuinely slow agentic task.

Checked `git worktree list` for real state left over from the user's session and found the actual explanation: **5 orphaned worktrees, all named `copilot-*`** (`copilot-claude-sonnet-4.6-*`, `copilot-gemini-3-flash-*`, `copilot-gpt-5.3-codex-*` ×2) — no Claude Code or Codex CLI worktrees existed at all. The user's comparison only included GitHub Copilot model variants, and a repo-wide prompt with no active file open gives the Copilot adapter (no file/tool access at all — see `getActiveFileSnapshot`/`buildPromptWithContext` above) genuinely nothing to work with. Every model correctly declining identically isn't a bug; it's the expected behavior of asking several backends that share the same zero-file-access code path an unanswerable question. This just wasn't visible/obvious from the panel, so it read as a bug.

### Files changed

- `src/abtest/worktree.ts` - new `listOrphanedAbTestWorktrees(repoRoot)` (`git worktree list --porcelain`, matched against `refs/heads/abtest/<variantId>`)
- `src/webview/abTestView.ts` - calls it on panel open; `orphanBanner` UI + `cleanupOrphaned` message handler; `PROVIDER_NOTES` — a one-line capability note under each provider group in the sidebar (Copilot: no file/tool access beyond attached context; Claude Code/Codex: full access but slower)
- `CHANGELOG.md` - one more `[Unreleased]` entry

### Decisions made

- **Made the Copilot capability gap visible in the UI rather than just documenting it in the wiki** — the whole point of the report was that the limitation wasn't discoverable in the moment; a wiki note doesn't help someone mid-comparison in the panel.
- **Orphan detection reads real git state (`git worktree list --porcelain`), not in-memory tracking** — `AbTestViewProvider.lastResults` is only ever populated by the panel's own last run and is lost on reload/crash/window-close-without-cleanup, which is exactly how the 5 real orphans in this session were created. Reading from git directly is the only way to find worktrees the panel itself has forgotten about.
- Did not attempt to give Copilot's variant real file/tool access (e.g. registering `vscode.lm` tools, or auto-attaching a repo file listing) — that's a materially bigger feature (a lightweight RAG/tool-loop for a one-shot chat API) and out of scope for this fix; the honest, low-effort answer for now is transparency about the limitation plus steering users toward the CLI variants for whole-project prompts.

### Follow-up / known gaps

- No timeout on `adapter.run()` in `runAbTest` — a broad prompt on a CLI variant can run for many minutes with only the "Running…" status visible; no cap and no elapsed-time indicator yet. Worth adding if this becomes a complaint.
- Copilot variant is still fundamentally single-file/selection-scoped; no path exists yet to let it reason about the whole repo the way the CLI variants can.

## Follow-up feature (same day): give Copilot a bounded tool loop instead of leaving it single-file-scoped

### What was done

User asked, after the orphan/limitation investigation above, whether "opening new Copilot sessions per worktree" (i.e. driving the real Copilot Chat UI programmatically) was possible. Answered no — there's no public API to script Copilot Chat's own UI/agent-mode conversation or read its output back, and each opened window is a separate extension-host process the original panel can't reach into. What *is* possible: VS Code's Language Model API lets any extension pass ad-hoc tool definitions into a single `sendRequest` call and run the tool-call loop itself. Confirmed the installed `@types/vscode` (1.116.0, despite `package.json`'s `engines.vscode` still declaring `^1.85.0`) has full support for `LanguageModelChatTool`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, and the `tools` option — so built it: `CopilotAgentAdapter` with `read_file`/`list_directory`/`search_files` tools scoped and sandboxed to the variant's worktree.

### Files changed

- `src/abtest/copilotAgentAdapter.ts` - new: `CopilotAgentAdapter` (tool-call loop, max 8 iterations), `resolveSafePath` (sandboxing), `executeWorktreeTool`, `grepWorktree`
- `src/benchmark/adapters.ts` - exported `resolveCopilotModel` and `estimateTokens` (were private) so the new adapter could reuse them; `CopilotAdapter` itself is untouched
- `src/abtest/runner.ts` - `buildAbTestAdapter`'s `'copilot'` case now returns `CopilotAgentAdapter` instead of `CopilotAdapter`
- `src/webview/abTestView.ts` - updated the Copilot `PROVIDER_NOTES` entry to describe the new tool access instead of the old "no file access" caveat
- `CHANGELOG.md` - one more `[Unreleased]` entry

### Decisions made

- **Only for A/B Test's Copilot variant, not Technique Benchmark's** — Technique Benchmark's whole premise is measuring how different *injected*-context strategies perform in isolation (readme-only, wiki-all, types-only, etc.); an autonomously-exploring Copilot would let the model just read whatever it wants and route around the experiment. Kept `CopilotAdapter` (benchmark) and `CopilotAgentAdapter` (A/B Test) as separate classes rather than adding a "tools on/off" flag to one shared class, so the benchmark's behavior can never accidentally regress if someone edits the A/B Test path later.
- **Read-only tools only (no write/edit tool)** — gives Copilot the same *exploration* capability as Claude Code/Codex CLI, not their *file-editing* capability. Deliberately narrower scope than full parity: a write tool driven by tool-call JSON from a chat completion is a meaningfully bigger trust/safety surface than read-only browsing, and wasn't needed to fix the reported problem (Copilot being blind, not Copilot being unable to edit).
- **Bounded to `MAX_TOOL_ITERATIONS` (8) round-trips** — without a cap, a model that keeps requesting tools (e.g. stuck re-reading the same file, or trying to enumerate a huge tree file-by-file) could loop indefinitely, unlike the CLI adapters which have their own internal stopping logic.
- **Sandboxed every path** (`resolveSafePath`) so a tool call can never read outside the worktree root, even via `../` traversal or an absolute path — verified with a smoke test (`../../../etc/passwd` and `/etc/passwd` both correctly rejected).
- Verified `read_file`, `list_directory`, and `search_files` (regex grep) all work correctly against a real worktree of this repo, and that path-escape attempts are blocked, before considering this done.

### Follow-up / known gaps

- No write/edit tool — if users want Copilot to actually modify files (matching Claude Code/Codex's "code produced" stat instead of falling back to the response-code-block estimate), that would need a deliberate, separate decision given the larger trust surface.
- Tool-call token usage is summed across iterations from each `sendRequest`'s `usage` field when present; if a given Copilot model never reports `usage`, the whole run still falls back to a single char-count estimate over the initial prompt and final response text (round-trip tool payloads aren't counted in the estimate).

## Follow-up fixes (same day): worktree location + empty Copilot responses

### What was done

Two real problems reported after trying the tool-loop fix above, both with screenshots showing "Done" result cards with `57 in / 0 out (estimated)` tokens and `+0/-0, 0 files, estimated from response`:

1. **Worktrees still under `/tmp`, not the project folder.** User had asked earlier in the conversation about creating worktrees inside the repo (in the context of whether it would fix the Copilot blindness — it wouldn't, and was answered as such at the time), but now gave a direct instruction to actually do it, independent of that earlier question. Verified nesting is safe before implementing: created a live test worktree at `<repoRoot>/.ai-abtest/test/` in this repo and confirmed `git status --short` in the main repo doesn't list it at all (git treats a nested worktree's own `.git` file as a repository boundary and doesn't descend into or report on it).
2. **Copilot variant finishing "Done" with a completely empty response.** Traced to a real logic bug in `CopilotAgentAdapter`'s tool loop: it only ever kept the *last* turn's `turnText`, so if the decisive turn (the one with `toolCalls.length === 0`, or the forced-cap iteration) happened to contain only a tool call and no text — plausible, since many models emit tool-call-only turns with no accompanying prose — `responseText` stayed `''`. No exception was thrown (the loop completed normally), so the UI showed a deceptively blank "Done" card instead of any indication something went wrong.

### Files changed

- `src/abtest/worktree.ts` - `abTestWorktreePath` now returns `<repoRoot>/.ai-abtest/<variantId>` instead of `os.tmpdir()/ai-abtest/<repoName>/<variantId>`; new `ensureLocalExclude(repoRoot)` appends `/.ai-abtest/` to `.git/info/exclude` (resolved via `git rev-parse --git-dir`), called from `setupAbTestWorktree`
- `src/abtest/copilotAgentAdapter.ts` - loop rewritten: `runTurn(withTools)` helper, text accumulated across all iterations (`allText`) as a fallback, a forced final no-tools request if the iteration budget runs out without a text-only turn, and an explicit thrown error if the response is still empty after all of that
- `CHANGELOG.md` - two more `[Unreleased]` entries; also corrected the original A/B Test entry's "under the OS temp dir" phrase, now stale

### Decisions made

- **Verified nesting empirically before changing the default**, rather than assuming git's nested-worktree behavior — this repo already has other real nested/sibling worktrees in play (`.ai-insightrs-test`, `worktrees/add-dashboard-widget-tooltips`), so a live test against the actual repo was cheap and removed any doubt.
- **`.git/info/exclude`, not `.gitignore`** — keeps the fix local to this machine/checkout and never touches a tracked, committed file; also correctly resolves the real git-dir via `git rev-parse --git-dir` rather than assuming `.git/` directly, so it still works if this repo itself is ever accessed from a linked worktree.
- **Force a final no-tools request rather than just accepting empty text** — simply falling back to `allText` (concatenated text from all turns) would have papered over cases where the model never produced any prose at all (pure tool-call turns throughout); explicitly asking it to answer with no tools available gives it one guaranteed chance to produce real text before giving up.
- **Throw on genuinely empty response rather than silently returning `''`** — a thrown error surfaces as a real "Error" status with a message in the result card (via `runner.ts`'s existing `catch` block), which is a strictly more honest UI state than "Done" + all-zero stats. This was the core complaint: "nothing happened" was actually "something happened, but you couldn't tell."
- Verified the worktree-location change with a live create/status-check/teardown cycle, and cleaned up the two stray `/tmp`-based worktrees visible in the user's screenshots.

### Follow-up / known gaps

- VS Code's own Explorer/Search don't share git's nested-worktree detection the way `git status` does, so `.ai-abtest/` and its contents may still be visible in the file tree while a run is in progress — only git-based tooling is covered by the exclude fix.
- The empty-response fix hasn't been verified against a live Copilot model in this session (can't run `vscode.lm` outside actual VS Code) — the logic was reasoned through and the loop restructuring is straightforward, but worth re-confirming against the real backend if the "Done + empty" symptom recurs.

## Follow-up feature (same day, confirmed live): Copilot variant can now write files

### What was done

Confirmed live in the real extension (the two worktree fixes above were already being tested in the user's actual VS Code window — visible as real `copilot-gemini-3-flash-*`/`copilot-gpt-5.3-codex-*` worktrees under the new in-repo `.ai-abtest/` path during this session). User asked the Copilot variant to do something requiring a file write and got back "I cannot write files in this environment (read-only), but here is the `dead_code.md` content to save" — exactly the deliberate limitation flagged as a known gap in the tool-loop feature (read-only by design, no write/edit tool). Since the user explicitly wants that capability, added a fourth tool, `write_file`, rather than just re-explaining the limitation.

### Files changed

- `src/abtest/copilotAgentAdapter.ts` - added `write_file` tool definition (`{ path, content }`, `MAX_WRITE_CHARS` = 200,000), handled in `executeWorktreeTool` (creates parent dirs via `fs.mkdirSync(..., { recursive: true })`, writes via `fs.writeFileSync`, same `resolveSafePath` sandboxing as the read tools); updated `TOOL_USAGE_HINT` and the class doc comment to describe the tool set as read *and* write instead of read-only
- `src/webview/abTestView.ts` - updated the Copilot `PROVIDER_NOTES` entry to mention write capability
- `src/abtest/worktree.ts` - updated `measureCodeProduced`'s doc comment: the real-git-diff path is now the common case for all three adapters (previously only true for the CLI adapters), the response-code-block estimate is now explicitly described as the fallback for when nothing was actually written
- `CHANGELOG.md` - one more `[Unreleased]` entry; removed the now-stale "Read-only by design" sentence from the original tool-loop entry

### Decisions made

- **Added the write tool rather than just documenting the limitation** — this was flagged as a deliberate, narrower-scope decision in the original tool-loop feature ("would need a deliberate, separate decision given the larger trust surface"), and the user's direct ask ("why thats just read only... I wanted to do there something") is exactly that separate decision being made.
- **Same sandboxing as the read tools, no new trust boundary invented** — `write_file` reuses `resolveSafePath`, so it's exactly as contained as `read_file`/`list_directory` already were (can't escape the worktree root); the only new capability is *within* that already-established boundary.
- **Size-capped** (`MAX_WRITE_CHARS` = 200,000) as a basic guard against a pathological single write, mirroring `MAX_TOOL_OUTPUT_CHARS`'s read-side cap.
- Verified live with a smoke test: wrote a nested `docs/dead_code.md` (parent directory auto-created), confirmed `git diff --cached --numstat` picked it up correctly (`3 0 docs/dead_code.md`), and confirmed a `../../etc/evil` escape attempt was still rejected — the new tool doesn't weaken the existing sandbox.
- Deliberately left the two worktrees the user had already created via their own live testing (`copilot-gemini-3-flash-*`, `copilot-gpt-5.3-codex-*` under `.ai-abtest/`) untouched rather than cleaning them up automatically — those belong to an active session, not leftover test artifacts, and the panel's own "Clean up worktrees" button is the right way to remove them.

### Follow-up / known gaps

- Still no delete/rename tool — `write_file` only creates or overwrites; a model can't remove a file it decides was a mistake, only overwrite it with different (e.g. empty) content.
- Not yet verified against a live Copilot model actually calling `write_file` successfully end-to-end from within a real `vscode.lm` tool-call loop (the smoke test exercised the tool's file-system logic directly, not the full model round-trip) — worth confirming next real run.

## Follow-up fix (same day, confirmed live): raised the tool-iteration cap

### What was done

The `write_file` tool above got exercised live and hit exactly the concern flagged in its own "known gaps": the model reported back "Unable to write `dead.md` in this turn because tool calls are exhausted" — a real, live confirmation that `MAX_TOOL_ITERATIONS = 8` is too low for a realistic "explore several files, then write" task, especially since Copilot models via this API tend to make one tool call per turn rather than batching. This wasn't a bug in the empty-response-fix sense (the model correctly and honestly explained what happened, exactly as that fix intended) — it's a budget that was simply too tight. Raised `MAX_TOOL_ITERATIONS` from 8 to 16.

### Files changed

- `src/abtest/copilotAgentAdapter.ts` - `MAX_TOOL_ITERATIONS` constant: `8` → `16`
- `wiki/core/abTesting.md` - updated the two references to the old cap of 8
- `CHANGELOG.md` - one more `[Unreleased]` entry

### Decisions made

- **Simple constant bump, not a redesign** — no smarter budget-allocation logic (e.g. reserving iterations for a detected pending write, warning the model as the budget runs low) was added; doubling the cap directly addresses the observed failure mode (running out of turns during exploration) without adding complexity that hasn't been shown to be necessary yet.
- Picked 16 (not an arbitrarily larger number) as a reasonable middle ground — enough for a multi-file explore-then-write task without letting a truly confused model spin for very long before the forced-final-answer fallback kicks in.

### Follow-up / known gaps

- If explore-then-write tasks still exhaust 16 iterations in practice, worth reconsidering a smarter approach rather than continuing to just raise the number (e.g. nudging the model to wrap up as the budget runs low, or reserving the last 1-2 iterations specifically for a write if one was hinted at).

## Follow-up fix (same day, confirmed live again): the 16-iteration cap still wasn't enough

### What was done

Exactly the predicted failure mode from the "known gaps" above: user hit "Unable to write `dead.md` because tool calls are exhausted" again, this time at the doubled cap of 16 — for a real whole-repo "dead code" scan, which inherently needs to read many files before it has enough information to write anything, no fixed cap chosen by guessing is reliably enough. Rather than raise the number a third time and call it done, implemented the smarter approach flagged as the alternative in the previous entry's known-gaps note.

### Files changed

- `src/abtest/copilotAgentAdapter.ts` - three changes together:
  - `MAX_TOOL_ITERATIONS`: `16` → `24`
  - new `buildFileTree(worktreePath)` (capped at new `MAX_TREE_ENTRIES` = 300) — recursively lists relative file paths, included directly in the initial prompt via a new `treeBlock` so the model has the project's shape upfront instead of needing `list_directory` calls just to discover it
  - new `WARNING_REMAINING_THRESHOLD` (3) — inside the main loop, when exactly 3 tool-call iterations remain, a `User` message is pushed telling the model to stop exploring and use its remaining calls to finish, explicitly calling out `write_file` if one was planned
- `wiki/core/abTesting.md` - updated the tool-loop section with a third "Follow-up fix" paragraph and the new cap of 24
- `CHANGELOG.md` - one more `[Unreleased]` entry

### Decisions made

- **Addressed the root cause (wasted exploration turns) instead of only the symptom (budget too low)** — the file-tree-upfront change specifically targets *why* iterations were being consumed (rediscovering structure via `list_directory`) rather than just giving more total iterations to burn the same way. Smoke-tested against this repo: 86 files, ~2100 chars / ~531 estimated tokens for the tree block — cheap enough to include unconditionally.
- **Warning nudge fires exactly once**, keyed off `remaining === WARNING_REMAINING_THRESHOLD` (not `<=`), so it doesn't repeat every iteration after the threshold — one clear "wrap up now" message is enough signal without cluttering the transcript.
- **Still raised the hard cap too (16 → 24), not either/or** — the file-tree and warning changes reduce *wasted* iterations, but a genuinely large, thorough dead-code scan can still legitimately need more real investigation turns than 16; 24 gives headroom without being unbounded.
- Deliberately did not attempt to make the cap adaptive/unbounded (e.g. "keep going until done") — a hard ceiling is still needed so a confused model can't loop indefinitely; the goal was making the *fixed* budget work harder, not removing the cap.

### Follow-up / known gaps

- Still no verification against a live Copilot model actually completing an explore-then-write task within the new budget end-to-end (only the file-tree helper and the escape-sandboxing were smoke-tested directly; the full `vscode.lm` tool-call loop can't be driven outside real VS Code from this environment).
- If this specific failure mode (budget exhausted on a large repo-wide task) recurs a third time, the next lever is likely encouraging `search_files`-first workflows (targeted pattern search across many files in one call) over reading whole files one at a time, rather than continuing to raise the iteration cap.

## Follow-up feature (same day): whole-feature generation support — edit_file + bigger budget

### What was done

User stated a broader goal: using A/B Test to generate whole features, not just small edits or reports — "so there can be big code generation within testing." This reframed the previous fixes (all reactive, to specific failures) into a forward-looking design question: what does the Copilot variant need to handle *that* class of task well? Two gaps identified and confirmed with the user via `AskUserQuestion` before building: `write_file`'s full-overwrite-only requirement (expensive/risky for editing existing files - the model has to reproduce the whole file just to change a few lines) and the 24-call budget (still tight for a multi-file feature build, on top of everything already explored). Both confirmed: add a targeted edit tool, and raise the budget substantially (50+).

### Files changed

- `src/abtest/copilotAgentAdapter.ts`:
  - New `edit_file` tool (`{ path, old_text, new_text }`) — `TOOLS` array entry, handled in `executeWorktreeTool`: reads the file, counts occurrences of `old_text` via `content.split(oldText).length - 1`, rejects with a clear message if zero (not found) or more than one (ambiguous, asks for more context), otherwise does a single `content.replace(oldText, newText)` and writes back
  - `write_file`'s tool description updated to point at `edit_file` for partial edits of existing files
  - `MAX_TOOL_ITERATIONS`: `24` → `50`
  - `TOOL_USAGE_HINT` and the budget-warning message updated to mention `edit_file`
  - Class doc comment updated: "including multi-file feature-generation-sized tasks, not just single-file edits"
- `src/webview/abTestView.ts` - Copilot `PROVIDER_NOTES` updated to mention edit + the 50-call budget
- `wiki/core/abTesting.md`, `CHANGELOG.md` - documented

### Decisions made

- **`edit_file`'s uniqueness contract mirrors CLI coding agents' own edit tools** (exact match required, must occur exactly once, ask for more surrounding context to disambiguate) rather than inventing a new scheme (e.g. line numbers, fuzzy matching) — the model has almost certainly seen this exact pattern before from other agentic coding tools, so it should need little to no extra guidance to use it correctly.
- **Rejects ambiguous matches rather than replacing all occurrences or guessing the first one** — a silent wrong-occurrence replace in a bigger feature build (more files, more repeated patterns like `return 1;`-style boilerplate) is a much worse failure mode than an explicit "not unique, add more context" error the model can react to.
- **50, not unbounded** — still a hard ceiling, consistent with the "make the fixed budget work harder, don't remove the cap" principle from the previous fix; a genuinely confused model still can't loop forever.
- Confirmed both changes with the user via targeted yes/no questions before implementing, since "add an edit tool" involves a real design choice (search/replace vs. diff-based vs. line-range) and "raise the budget" has a latency/cost tradeoff — not something to decide unilaterally.
- Verified live: unique-snippet edit succeeded and produced the expected file content; a repeated snippet (`return 1;` appearing twice) was correctly rejected as ambiguous; a non-existent snippet was correctly rejected; a path-escape attempt was still rejected — the new tool doesn't weaken the existing sandbox.

### Follow-up / known gaps

- Still no delete/rename tool — a model building a feature that requires removing or renaming a file can only overwrite content, not remove/rename the file itself.
- No verification yet against a live model actually choosing `edit_file` over `write_file` appropriately, or successfully completing a genuinely multi-file feature build end-to-end within the 50-call budget — worth confirming on the next real "build a feature" run.
