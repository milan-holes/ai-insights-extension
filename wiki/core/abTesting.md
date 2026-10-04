# A/B Testing Prompts Across Providers

Lets a user compare how different providers/models respond to the *same* prompt, each in an isolated `git worktree` they can open in a new VS Code window for manual follow-up.

| File | Role |
| --- | --- |
| [src/abtest/types.ts](../../src/abtest/types.ts) | `AbVariant`, `AbTestConfig`, `AbVariantResult`, `AbTestProgress` |
| [src/abtest/worktree.ts](../../src/abtest/worktree.ts) | `isGitRepo`, per-variant worktree setup/teardown, in-repo path + local exclude |
| [src/abtest/runner.ts](../../src/abtest/runner.ts) | `runAbTest` — runs the prompt through each variant's adapter sequentially |
| [src/webview/abTestView.ts](../../src/webview/abTestView.ts) | `AbTestViewProvider` panel — config UI, results, cleanup, orphan detection |
| [src/abtest/copilotAgentAdapter.ts](../../src/abtest/copilotAgentAdapter.ts) | `CopilotAgentAdapter` — Copilot variant with a bounded read/write tool loop scoped to its worktree |
| [src/benchmark/adapters.ts](../../src/benchmark/adapters.ts) | Shared `BenchmarkAdapter` implementations (extended for this feature — see below) |

Command: `aiInsights.showAbTest` ("A/B Test Prompts Across Providers"). Registered in the shared nav bar as the "A/B Test" tab (`navShared.ts`'s `NAV_TABS`/`NAV_COMMANDS`) — the panel renders the same `navTopbarHtml`/`navPagebarHtml`/`navJs` as every other view, so it's reachable from any panel's top nav, not just the Command Palette.

## Flow

1. Panel opens and checks `vscode.workspace.workspaceFolders[0]` + `isGitRepo(root)`. If either is missing, the panel renders a warning below the (still-functional) nav bar instead of the config UI — isolated worktrees require a Git repo, so the feature is unavailable otherwise.
2. User enters one prompt and checks any number of provider/model variants (Claude Code, GitHub Copilot, Codex — Codex also accepts a free-typed custom model id).
3. `runAbTest` iterates variants **sequentially** (not parallel, to avoid concurrent worktree/CLI contention): for each variant it creates a worktree at `<repoRoot>/.ai-abtest/<variantId>` on branch `abtest/<variantId>` from `HEAD` (`setupAbTestWorktree`), then runs the adapter with `cwd` set to that worktree so CLAUDE.md/AGENTS.md/copilot-instructions.md are picked up the same way a real session would.
4. Progress streams back via `onProgress` after every state change (`pending` → `running` → `done`/`error`) so the panel can update result cards live. Each finished card shows three recap stat tiles — Tokens, Code produced, Time (see below).
5. **Worktrees are intentionally not torn down when a run finishes** — that's the whole point, so "Open in New Window" (`vscode.openFolder` with `forceNewWindow: true`) still has something to open afterward. A separate "Clean up worktrees" button in the panel calls `teardownAbTestWorktree` for every variant from the last run.

## Recap stats ("Code produced")

`measureCodeProduced` (`src/abtest/worktree.ts`), called from `runner.ts` right after each variant's adapter call, computes the "Code produced" tile:

- **All three adapters** — CLI adapters (Claude Code, Codex) via their own tools, and Copilot (`CopilotAgentAdapter`) via its `write_file` tool (below) — can now actually modify the worktree. `git add -A` is run first (so brand-new untracked files count, not just edits to already-tracked ones — safe, since the worktree is either thrown away or handed to the user next), then `git diff --cached --numstat HEAD` gives real lines-added/lines-deleted/files-changed. Result is tagged `estimated: false`.
- **Fallback**: if nothing was actually written (e.g. the model just answered inline instead of calling `write_file`, or a run predates that tool), the diff above is empty and `estimateCodeFromResponse` instead counts non-blank lines inside fenced ```` ``` ```` code blocks in the response text. Result is tagged `estimated: true` and the panel labels it "estimated from response" so it isn't confused with a real diff.

Tokens and wall time were already tracked per variant (`AbTokenUsage`, `wallTimeMs` on `AbVariantResult`); the stat-tile layout in `abTestView.ts` just surfaces all three side by side per result card.

## Active editor context ("Attach active editor as context")

`CopilotAdapter` (`src/benchmark/adapters.ts`) is a bare `vscode.lm.sendRequest` call — no tools, no implicit editor/workspace context, unlike real Copilot Chat which auto-attaches the open file. Without this, a prompt like "refactor this function" reaches the model with nothing to act on and it correctly refuses (observed in practice: "I need the code first — I can't access your active VS Code file directly"). The CLI adapters (Claude Code, Codex) don't have this problem in the same way since they have real file tools inside their worktree, but they still don't know what "this" refers to unless told a path.

Fix, in `abTestView.ts`:

- `getActiveFileSnapshot(workspaceRoot)` reads `vscode.window.activeTextEditor` — the selection if non-empty, else the full document (capped at `MAX_ATTACH_CHARS` = 20,000 chars) — and rejects documents outside the workspace or with a non-`file` URI scheme.
- `buildPromptWithContext(prompt, snapshot)` prepends a fenced-code preamble (`Active file: \`<relPath>\`` or `Selected code: \`<relPath>\``, noting truncation) before the user's prompt.
- A sidebar checkbox **"Attach active editor as context"** (default **on**) controls whether this runs; the extension posts an `activeFileInfo` message on panel open and on `onDidChangeActiveTextEditor`/`onDidChangeTextEditorSelection` so the sidebar's status line ("Will attach full file `src/foo.ts` (42 lines)" / "No active file detected") stays live while the user has the panel open.
- The snapshot is taken **at `runAbTest` message-handler time** (not when the panel opened), so the file/selection reflects whatever was last focused right before clicking Run — this is deliberately applied to **all** variants, not just Copilot, so every provider/model sees identical grounding for a fair comparison.

## Copilot's structural file-access limitation, and the tool-loop fix

Confirmed from a real report: a whole-project "find dead code" prompt with several **GitHub Copilot** model variants selected (Claude Sonnet 4.6, Gemini 3 Flash, GPT-5.3 Codex — all via `vscode.lm`, no Claude Code/Codex CLI variants involved) got the same "no source file provided"-style refusal from every one of them. This wasn't a bug — the plain `vscode.lm.sendRequest` call has *no* file/tool access beyond whatever the "attach active editor" snapshot provides (see above), and a repo-wide question with no specific file open has nothing to attach. Claude Code/Codex CLI don't have this limitation since they run with real autonomous file tools inside their worktree — they can (and will) explore the whole repo themselves, though that can take much longer than a single chat call (a real repo-wide analysis prompt took over 2 minutes and was still working when a smoke test's timeout cut it off).

Two things came out of that report:

1. **`CopilotAgentAdapter`** (`src/abtest/copilotAgentAdapter.ts`) replaces the plain `CopilotAdapter` for A/B Test's `'copilot'` variant only. It advertises five ad-hoc `vscode.lm` tools — `read_file`, `list_directory`, `search_files` (plain-text/regex grep across source files), `write_file` (create/fully replace a file), and `edit_file` (targeted snippet replace within an existing file) — all sandboxed via `resolveSafePath` so a path can never resolve outside the worktree root, and runs the standard tool-call loop: send request with `{ tools }` → collect any `LanguageModelToolCallPart`s from the stream → execute them locally against the worktree → append an `Assistant` message (the tool calls) and a `User` message (`LanguageModelToolResultPart`s) → repeat, capped at `MAX_TOOL_ITERATIONS` (50) to bound a confused model. Token usage is summed across every round-trip in the loop.

   **Follow-up fix — empty responses**: the loop originally only kept the *last* turn's text, so if the decisive turn (zero further tool calls, or the forced final iteration) happened to contain only a tool call and no text, `responseText` stayed `''` with no error — the run genuinely completed ("Done", 0 output tokens) with nothing to show. Now: text is accumulated across every turn as a fallback (`allText`); if the tool-call budget runs out while the model still wants to call tools, one more request is made with `tools` omitted entirely so the model *must* answer in plain text; and if the response is still empty after all of that, the adapter throws (`"<model> returned an empty response... — try a different model or rephrase the prompt"`) so the result card shows a real error instead of a misleadingly blank "Done".

   **Follow-up feature — `write_file`**: the adapter was initially read-only on purpose (see decision #2 below), which meant a prompt asking it to save/create something could only reply with something like "I cannot write files in this environment, but here is the content to save" instead of actually saving it — reported directly by a user hitting exactly that. `write_file` (`{ path, content }`, creates parent directories as needed, capped at `MAX_WRITE_CHARS` = 200,000 chars) closes that gap, still sandboxed through the same `resolveSafePath` check as the read-only tools. Verified live: a nested `docs/dead_code.md` written via the tool showed up correctly in `git diff --numstat` (so the "Code produced" stat is now real for Copilot too, whenever it uses this tool), and a `../../etc/evil` escape attempt was rejected.

   **Follow-up fix — budget exhausted before writing, even at 16 iterations**: a real whole-repo "dead code" scan hit "tool calls are exhausted" again after the first bump (8 → 16) — a task that legitimately needs to read many files before it can write has no fixed cap that's always enough, so instead of just raising the number again, three changes were made together: `MAX_TOOL_ITERATIONS` raised once more (16 → 24); a new `buildFileTree()` lists every file in the worktree (capped at `MAX_TREE_ENTRIES` = 300) and is included directly in the initial prompt, so the model doesn't burn early iterations on `list_directory` calls just to learn the project's shape; and when `WARNING_REMAINING_THRESHOLD` (3) calls remain, a message is injected telling the model to stop exploring and use its remaining calls to finish — explicitly naming `write_file` if one was planned — instead of continuing to explore until the budget silently runs out.

   **Follow-up feature — `edit_file`, and a bigger budget, for whole-feature generation**: the user's stated goal is generating whole features with A/B Test, not just small edits/reports — a materially bigger use case than what the adapter had been tuned for. Two gaps for that: `write_file` requires reproducing a file's *entire* content even to change a few lines, which is expensive and error-prone for edits to existing (possibly large) files; and `MAX_TOOL_ITERATIONS` (24 at the time) could still run out on a multi-file build. Added `edit_file` (`{ path, old_text, new_text }`) — replaces one exact snippet of an existing file's current content, rejecting with a clear error if `old_text` isn't found or occurs more than once (asking for more surrounding context to disambiguate), mirroring the same "must match exactly, must be unique" contract used by CLI coding agents' own edit tools, which the model is likely already well-trained on. Raised `MAX_TOOL_ITERATIONS` again, 24 → 50. Verified live: a unique-snippet edit succeeded, an ambiguous (repeated) snippet was correctly rejected, a non-existent snippet was correctly rejected, and a path-escape attempt was still rejected.
2. **Deliberately not applied to Technique Benchmark's `CopilotAdapter`** — that feature exists specifically to measure how different *injected*-context strategies (readme-only, wiki-all, types-only, etc.) perform in isolation; giving that adapter autonomous file access would let the model bypass the context-starvation experiment entirely by just reading whatever it wants. `resolveCopilotModel`/`estimateTokens` were exported from `src/benchmark/adapters.ts` so the new adapter could reuse them without duplicating model-resolution logic, while `CopilotAdapter` itself is untouched.

Made visible directly in the UI too, not just fixed silently: each provider group in the sidebar (`PROVIDER_NOTES` in `abTestView.ts`'s client script) shows a one-line note — Copilot: "can read, list, search, and write files scoped to its own worktree via a bounded tool loop — not the full Copilot Chat product, but can now explore and actually save/create files instead of just printing content"; Claude Code/Codex: "full autonomous file access, but can take much longer to respond."

## Orphaned worktree detection

"Clean up worktrees" only ever tracked the *last* run's variants in memory (`AbTestViewProvider.lastResults`), so anything not cleaned up before the panel closed or VS Code reloaded was silently stranded — confirmed in practice: investigating the report above turned up 5 real orphaned `abtest/*` worktrees/branches from an earlier session. `listOrphanedAbTestWorktrees(repoRoot)` (`src/abtest/worktree.ts`) now runs `git worktree list --porcelain` and matches entries whose branch is `refs/heads/abtest/<variantId>`, independent of any in-memory state — this works regardless of where the worktree physically lives (see below). `AbTestViewProvider.createPanel` calls it on open and shows a "Found N leftover worktree(s) from a previous session — Clean up now" banner (`cleanupOrphaned` message) when it finds any.

## Worktree location: inside the repo, not the OS temp dir

Originally worktrees lived at `os.tmpdir()/ai-abtest/<repoName>/<variantId>`. Per explicit request, they now live at `<repoRoot>/.ai-abtest/<variantId>` instead — visible/co-located with the project, and immune to any environment where the OS temp dir is restricted or on a different filesystem/mount than the repo (e.g. some WSL2 or locked-down corporate setups, which was the suspected motivation behind the request).

Verified this doesn't pollute the main repo before shipping it:

- `git status` in the main repo **never shows `.ai-abtest/` at all**, not even as untracked — git detects the nested worktree's own `.git` file and treats it as a repository boundary it won't descend into or report on. Confirmed with a live test worktree in this repo.
- `setupAbTestWorktree` additionally calls `ensureLocalExclude(repoRoot)`, which appends `/.ai-abtest/` to `.git/info/exclude` (resolved via `git rev-parse --git-dir`, so it also works correctly from linked worktrees whose git-dir isn't `.git/` directly) — this is local-only and never touches the tracked `.gitignore`, and covers the moment before any worktree exists yet (an empty `.ai-abtest/` parent directory would otherwise show as untracked).
- **Known gap**: VS Code's own Explorer/Search don't share git's nested-repo detection, so they may still show these folders and their contents while a run is in progress (until "Clean up worktrees"/orphan cleanup removes them). Only `git status`/`git add`-based tooling is covered by the exclude fix.

## Adapters

Reuses `src/benchmark/adapters.ts`'s `BenchmarkAdapter` interface (built for the Technique Benchmark feature — see [architecture.md](../architecture.md)) rather than duplicating CLI/API plumbing:

- **Claude Code** — `ClaudeCodeCliAdapter` now takes an optional `model` constructor arg and passes `--model <model>` to `claude -p` when set (was previously always default-model-only).
- **GitHub Copilot** — `CopilotAgentAdapter` (not the plain `CopilotAdapter` Technique Benchmark uses), via `vscode.lm.selectChatModels` plus a bounded read/write tool loop scoped to the worktree (see below).
- **Codex** — new `CodexCliAdapter`. Runs `codex exec --json [-m <model>] <prompt>` in the worktree (`codex exec` is Codex's non-interactive/scripted mode, sandboxed and non-approval-blocking, mirroring `claude -p`). Token usage and response text are parsed best-effort from the JSONL event stream (`parseCodexJsonlOutput`); if the schema doesn't match (unverified across Codex CLI versions — no Codex CLI was available in the dev environment to confirm the exact event shape), it falls back to raw stdout as the response with char-count-estimated tokens, same graceful-degradation pattern as `ClaudeCodeCliAdapter`'s JSONL token read.

This module's `buildAbTestAdapter` (`src/abtest/runner.ts`) is a separate, open-ended factory from `src/benchmark/adapters.ts`'s `buildAdapter`/`AdapterId`/`ADAPTER_DEFS`, which is a closed union tied to Technique Benchmark's specific model list — A/B testing needed arbitrary Claude Code model aliases and free-typed Codex model ids that don't fit that closed set.

## Known gaps

- Variants run sequentially, not in parallel — a run with N variants takes roughly N× a single call's wall time.
- No LLM-judge scoring (unlike Technique Benchmark) — comparison is manual, by reading each result card and/or opening worktrees.
- Codex CLI JSONL event schema is unverified (see above) — flag if real-world Codex output doesn't parse as expected.
