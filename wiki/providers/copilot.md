# CopilotProvider

**File**: [src/providers/copilot.ts](../../src/providers/copilot.ts)  
**Provider ID**: `copilot`

Reads GitHub Copilot session logs from local VS Code/Copilot data directories.


## Log location

Current implementation scans VS Code-family workspace/global storage paths, including WSL Windows-side paths:

| Platform | Path                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | `~/.config/{Code,Code - Insiders,Code - Exploration,VSCodium,Cursor}/User/{workspaceStorage,globalStorage/github.copilot-chat}`                     |
| macOS    | `~/Library/Application Support/{Code,Code - Insiders,Code - Exploration,VSCodium,Cursor}/User/{workspaceStorage,globalStorage/github.copilot-chat}` |
| Windows  | `%USERPROFILE%\AppData\Roaming\{Code,Code - Insiders,Code - Exploration,VSCodium,Cursor}\User\{workspaceStorage,globalStorage/github.copilot-chat}` |
| WSL      | `/mnt/c/Users/*/AppData/Roaming/{Code,...}/User/{workspaceStorage,globalStorage/github.copilot-chat}`                                               |

The provider discovers all relevant log files within these directories, including `transcripts/` (see below).

## Discovery cost and per-scan caches (2026-10-03)

Copilot discovery dominated refresh time: ~90 candidate session directories (5 editor variants x 6
subdirectories, repeated for local, remote-server and WSL Windows-side roots), most of which do not
exist on any given machine. Three patterns were responsible for ~3.5 s of `existsSync` per refresh.

| Pattern | Before | After |
| --- | --- | --- |
| Per-workspace candidate dirs | 13 blind `existsSync` probes per workspace (546 calls, 2 031 ms) | one `readdir` of the workspace root, then only the subdirs it actually lists |
| `findDebugLogPath` | per-file loop over every workspaceStorage root x 4 extension folders (1 950 calls, 1 217 ms) | one-pass `debugLogIndex`: `sessionId -> debug-logs roots`, built once per scan |
| `extractWorkspace` | `workspace.json` re-read per session file (49 reads, 315 ms) | one read per workspace hash dir |
| `getFileFallbackDate` | its own `statSync` per file (95 calls, 666 ms) | reuses the `fs.Stats` the refresh loop passes in |

Total `existsSync` per refresh dropped from 2 566 calls (~3.5 s) to 556 (14 ms), with **identical
discovery and parse output** - verified by diffing file lists and parsed sessions (id, total tokens,
workspace, interaction count) before and after.

These caches live for exactly one scan and are cleared by `beginScan()`:

| Cache | Keyed by | Purpose |
| --- | --- | --- |
| `dirListCache` | directory path | `readdir` results, shared between discovery and the debug-log index so each workspace root is listed once rather than twice |
| `debugLogIndex` | session id | which `debug-logs` roots contain that session |
| `workspaceCache` | workspaceStorage hash dir | resolved workspace label |
| `statCache` | file path | seeded from `parseSessionFile(file, stats)` |
| `dirExistsCache` | directory path | memoized existence probe |

**Note on `existsSync` removal.** Dropping an `existsSync` that precedes a `readdirSync` inside a
`try/catch` is only a win when the directory usually *exists*. For a missing directory the probe is
one cheap `stat`, while the bare `readdirSync` costs a failed syscall plus a thrown exception - and
measuring showed that made discovery slower, not faster. The guards were removed only where the
caller already knows the directory is present (because it was just listed).

## Data availability

Current VS Code chat session files (`chatSessions/*.jsonl`, delta/patch format) **do** carry real `result.metadata.promptTokens` / `outputTokens` per request — `pickTokenCount()` reads these first and only falls back to text-based estimation when absent.

### Quick reference: sessions with vs. without debug logging enabled

Whether a given Copilot session shows measured or calculated cache numbers depends entirely on `github.copilot.chat.agentDebugLog.fileLogging.enabled` — a real, off-by-default VS Code setting — being on **before that session started**:

| | `agentDebugLog.fileLogging.enabled` = **off** (default) | = **on**, session started after enabling |
|---|---|---|
| Input / output tokens | Real, from `result.metadata.promptTokens`/`outputTokens` in the session file itself (independent of the debug-log setting) | Same, plus corroborated by `debug-logs/{sessionId}/main.jsonl` |
| Cache read tokens | **Estimated** via `applyCacheHeuristic()` turn-over-turn diffing — `0` for every session's first turn and for any single-turn session, since there's nothing to diff against | **Real**, from `attrs.cachedTokens` in `debug-logs/{sessionId}/main.jsonl`, incl. `0` on the first turn of a session (a genuine measured zero, not a missing estimate) |
| Cache write tokens | Estimated, as the fresh delta above the estimated cache-read baseline | Not reported here — the VS Code extension's debug-log telemetry is OpenAI-style automatic caching and doesn't bill/report writes separately (see below). **Copilot CLI's own `session.shutdown` telemetry is a different path and does report real cache-write tokens for Claude models** — see the CLI section further down. |
| `cacheTokensEstimated` flag / UI label | `true` → dashboard, session detail, replay, compare, and pricing views all show "(calc.)" / "calculated, not measured" | `false` for matched turns → "measured via Copilot telemetry" |
| `debug-logs/{sessionId}/main.jsonl` content | One-line `session.start` stub only — no `llm_request` events | Full `llm_request` telemetry per LLM call: `{"attrs":{"model":...,"inputTokens":...,"outputTokens":...,"cachedTokens":...}}` |
| Data written to disk | No new files | Full prompt/code content for every LLM call, written locally per session — a real privacy/data-handling tradeoff, not just a number-accuracy one |
| Retroactive? | — | No — only sessions **started after** the setting is flipped get full telemetry; sessions already in progress or predating the change still show the one-line stub |

**Practically**: with the setting off (the default for most users), expect most Copilot sessions — especially short or single-turn ones like the "analyze dependencies" example that started this investigation — to show a 0% cache hit rate, because there's no real data and the heuristic has no prior turn to diff against. This is expected behavior, not a bug. Turning the setting on only helps *future* sessions, and only for turns where a matching `llm_request` event actually gets bucketed (see "Cache token estimation" below for edge cases where even an enabled setting still falls back to the heuristic).

### Cache tokens: real data exists — was a discovery bug, not a data gap (corrected 2026-07-03)

An earlier investigation (2026-07-02, see git history for this file) concluded cache token accounting was "not instrumented anywhere we can reach it" and that `debug-logs/main.jsonl` "only ever writes a one-line `session_start` stub." **That conclusion was wrong.** It checked `debug-logs/main.jsonl` directly, but the real layout nests one level deeper: `debug-logs/{sessionId}/main.jsonl`. `addSessionFilesFromDir()` (and the manual check behind the 2026-07-02 finding) only reads files directly inside a directory and never descends into per-session subfolders, so every debug log was silently invisible.

Read correctly, `debug-logs/{sessionId}/main.jsonl` contains `llm_request` telemetry events with **real, measured** token data:

```json
{"ts":1783025622726,"dur":8094,"sid":"2603a5da-...","type":"llm_request","name":"chat:gpt-5.3-codex",
 "attrs":{"model":"gpt-5.3-codex","inputTokens":31703,"outputTokens":304,"cachedTokens":8704,"ttft":1681,...}}
```

`attrs.cachedTokens` is a **subset** of `attrs.inputTokens` (mirrors OpenAI's `usage.prompt_tokens_details.cached_tokens` — Copilot's backend models are OpenAI-style here, e.g. `gpt-5.3-codex`), so there's no separate cache-write/creation count: OpenAI-style automatic prompt caching doesn't bill or report writes separately, unlike Anthropic's explicit cache-creation tokens.

Verified live on this machine (2026-07-03): a real ~2.5-hour agent session showed `inputTokens: 103166` with `cachedTokens: 76288` (74% cache hit) on one turn, `72759`/`45824` (63%) on the next — these numbers now flow straight into `Interaction.cacheReadTokens` with `cacheTokensEstimated: false`, no heuristic involved.

**Requires opt-in: `github.copilot.chat.agentDebugLog.fileLogging.enabled`.** This is a real VS Code setting, off by default — full `llm_request` telemetry only appears in `debug-logs/{sessionId}/main.jsonl` for sessions started *after* it's turned on; sessions predating it just get a one-line `session.start` stub. Confirmed by timeline on this machine: `settings.json` was edited 2026-07-02 22:49-22:59 (this exact setting name is what the 2026-07-02 "confirmed unavailable" investigation above was testing), and the *only* fully-populated debug log among 6 found belongs to a session that started at 22:55:26 that same evening — every other debug log (dated 2026-05-01 through 2026-06-14, all before the setting existed) is a stub.

Corrected finding (2026-07-03, second pass): an earlier version of this doc claimed the detailed telemetry was agent-mode-only, based on the one post-enablement session happening to be agent mode. **That was an overreach from a sample of one that coincided with the setting flip** - it's not yet known whether ask/chat-mode sessions also populate fully once the setting is on; needs a fresh ask-mode session post-enablement to test. What *is* confirmed, reproduced on this machine: the setting is opt-in and off by default, so **most Copilot users get no debug-log telemetry at all** (real or stub) unless they've explicitly enabled it. **The heuristic (`applyCacheHeuristic`) therefore remains required for the overwhelming majority of Copilot users** - real data is a bonus for the minority who opt in, not a general replacement.

### Turning the setting on for users (added 2026-07-03)

Since the gap is purely "most users never enable this setting," not "the data doesn't exist," `extension.ts` now offers to enable it directly rather than just documenting it:

- `maybePromptEnableCopilotDebugLogging()` runs once on activation (gated by `aiInsights.providers.copilot.promptToEnableRealCacheData`, default `true`, and skipped entirely if the GitHub Copilot Chat extension isn't installed). If `github.copilot.chat.agentDebugLog.fileLogging.enabled` is already on, it silently marks the prompt resolved and does nothing further.
- Otherwise it shows a `showInformationMessage` with **Enable / Not now / Don't ask again** - explicitly calling out that enabling the Copilot setting makes Copilot write full prompt/code content to local debug-log files, since that's a real data-handling change, not just a number-accuracy toggle. Never flips the setting without this explicit click.
- **Enable** calls `vscode.workspace.getConfiguration('github.copilot.chat').update('agentDebugLog.fileLogging.enabled', true, vscode.ConfigurationTarget.Global)` and marks the prompt resolved (won't ask again). **Don't ask again** marks it resolved without changing the setting. **Not now** (or dismissing) leaves it unresolved, so the prompt reappears on the next activation.
- The `aiInsights.enableCopilotRealCacheData` command (`AI Insights: Enable GitHub Copilot Real Cache Data` in the Command Palette) re-runs the same prompt with `force: true`, so users who dismissed it, or who want to double check the setting is on, can trigger it any time - `force` mode also surfaces a confirmation message when the setting is already enabled or Copilot Chat isn't installed, instead of silently no-op'ing like the activation path does.
- Resolution state is tracked in `context.globalState` under `aiInsights.copilotDebugLogPromptResolved` - a boolean, not the actual Copilot setting value, so re-disabling the Copilot setting later doesn't bring the prompt back (only the manual command does at that point).

### Dashboard button (added 2026-07-05)

The activation prompt and Command Palette entry are easy to miss, so `dashboard.ts`'s "⚡ GitHub Copilot Cache Efficiency" widget now surfaces the same action directly:

- `DashboardProvider.getHtml()` reads `github.copilot.chat.agentDebugLog.fileLogging.enabled` live (extension-host context, not the sandboxed webview) and computes `copilotHasUsage` from `currentMonthByProvider.copilot`/`lastMonthByProvider.copilot` token totals.
- An **"✅ Enable Real Cache Data"** button renders inside the widget whenever the setting is still off *and* the user has any recent Copilot activity — i.e. it only appears for people it's actually relevant to, not on every install. It's suppressed once the setting is on (that branch already shows the "measured via Copilot telemetry" message instead) and suppressed for users with no Copilot usage at all.
- Clicking it posts `{command: 'enableCopilotRealCacheData'}` to the extension host, which the `onDidReceiveMessage` handler routes to `vscode.commands.executeCommand('aiInsights.enableCopilotRealCacheData')` — the same `force: true` path as the Command Palette entry, so it shows the identical Enable/Not now/Don't ask again confirmation (including the privacy note about full prompt/code content being written locally) rather than silently flipping the setting from a single click.
- The button appears in both the "calculated, not measured" branch (replacing the old plain-text mention of the command name) and the "no cache data available" branch, since either state can be resolved the same way. It was later (2026-07-05) also added to the "measured, not calculated" branch, gated on the *live* setting value rather than the period's aggregate flag - otherwise a user who disabled the setting after some earlier real-data sessions this month would see no acknowledgment or way to re-enable it at all, since the aggregate `cacheTokensEstimated` flag stays `false` (measured) until a new estimated session shows up.

### Persistent dashboard nudge, independent of the one-time popup (added 2026-07-05)

The activation prompt and its Command Palette twin are intentionally one-shot - once `github.copilot.chat.agentDebugLog.fileLogging.enabled` is seen on, or the user picks "Don't ask again", `copilotDebugLogPromptResolved` is set permanently and the dialog never resurfaces, even if the setting is later turned back off. That's by design (no nagging users who deliberately disable it), but it left no ongoing signal that cache numbers are currently estimated.

A new insight rule, `copilot-real-cache-data-available` (see [insightsEngine.md](../core/insightsEngine.md)), fills this gap: it fires on the main dashboard's AI Health card whenever the user has any Copilot usage this month or last, and the *live* setting value is off - independent of the one-time popup's dismissed/resolved state, and independent of whether this period's data happens to read as measured or estimated. Like every other insight it's individually dismissable/snoozable (1 week), so a user who's seen and acknowledged it isn't nagged again for a week even though the underlying condition (setting still off) hasn't changed.

**Button added inline on the main dashboard (added 2026-07-05).** The insight's `<li>` now renders the same `enableRealCacheDataButton` used by the Cache Efficiency widget directly below the tip's message text, when `ins.id === 'copilot-real-cache-data-available'`. Previously the tip was prose-only, and the actual button lived inside the Copilot-only tab's Cache Efficiency widget - requiring a tab switch to act on it. Now the nudge is actionable straight from the default/overview dashboard view.

**Gated on the extension actually being installed (added 2026-07-05).** All three surfaces that suggest enabling the setting - the dashboard/pricing-page button+warning and this insight rule - now also check `vscode.extensions.getExtension('github.copilot-chat')`, matching the activation-prompt command's existing check. Without this, a user with historical Copilot usage but no currently-installed Copilot Chat extension (e.g. uninstalled since) would be told to enable a setting belonging to an extension no longer present. `dashboard.ts`/`pricingView.ts` compute `copilotChatExtensionInstalled` locally (both already have `vscode` in scope); `insightsEngine.ts` receives it as a new `InsightContext.copilotChatExtensionInstalled` field, since that module is a pure function with no `vscode` import of its own - `extension.ts` computes it once and passes it in alongside `copilotDebugLoggingEnabled`.

**`readDebugLogEvents()` + `attachRealCacheData()`** implement this: given any parsed session file's path, they derive the sibling `debug-logs/{sessionId}/main.jsonl` path structurally (`{extFolder}/debug-logs/{sessionId}/main.jsonl`, where `{sessionId}` is the session file's own basename — works for `chatSessions/*.json`, delta `*.jsonl`, and `transcripts/*.jsonl` alike, since all three share the same naming convention under their extension folder). They parse its `llm_request` events and bucket each one into whichever interaction most recently started before it (by timestamp) — there's no shared ID between the debug log and the session content, and a single turn can trigger several LLM calls in agent mode. Matched interactions get real `inputTokens`/`outputTokens`/`cacheReadTokens` and `model` (from `attrs.model`, more reliable than text-based model guessing), and are flagged so `applyCacheHeuristic()` never overwrites them — even when the real cache count happens to be zero.

**When no debug log exists** (debug logging wasn't enabled for that session, or the debug-logs folder has aged out / been cleared), the heuristic estimate below still applies as a fallback, exactly as before.

### Cache token estimation (heuristic fallback, added 2026-07-03)

`applyCacheHeuristic()` in `copilot.ts` estimates `cacheReadTokens`/`cacheWriteTokens` by diffing real per-turn `promptTokens` across consecutive interactions in the same session — now used **only for interactions that have no real debug-log cache data** (see above). Every interaction it touches gets `cacheTokensEstimated: true`, and every UI surface that displays Copilot cache numbers (dashboard's Cache Efficiency widget, session detail view, replay view, session compare, pricing view) shows a "(calc.)" marker or disclaimer when this flag is set — never presented as measured data.

**Method**:
- `cacheRead` for turn *i* = `min(turn i's full prompt tokens, turn (i-1)'s full prompt tokens + turn (i-1)'s output tokens)` — assumes the previous turn's entire context (including its own reply, now part of history) gets reused via caching.
- `cacheWrite` for turn *i* = whatever's left above `cacheRead` (the "fresh delta"). This follows from the cache-read assumption itself: the *next* turn's cache-read estimate only makes sense if this turn's new content actually got cached, so treating the delta as a cache write is the internally consistent choice — not an independent guess. **Lower confidence than cache-read**: real caching may not mark every turn's delta with a cache breakpoint (e.g. a large one-off tool result), which would show as plain input in reality but gets counted as cache-write here.
- Baseline resets (no reuse assumed, i.e. this turn counts as 100% fresh) whenever prompt tokens shrink turn-over-turn or the model changes — both usually indicate compaction, a mode switch, or an unrelated request sharing the same session file, not genuine cache reuse.
- Only applies where `promptTokens` was real (from `result.metadata`), never stacked on top of the text-based estimation fallback.

**Why many sessions - especially older ones - never show an estimate at all (investigated 2026-07-04):** the heuristic needs a *previous turn in the same session* to diff against (`prevFullContext`), so it structurally cannot produce a number for a session's first turn, and produces nothing whatsoever for single-turn sessions. Checked directly against this machine's real Copilot data (via `CopilotProvider.parseSessionFile()` over every discovered session file): the large majority of `chatSessions/*` files parse to exactly **one** `Interaction` (one user message, one reply - even when the underlying delta-JSONL stream has dozens of lines, since that's just the response streaming in over many patch events, not multiple turns). A session with one turn has cache tokens `0` regardless of whether `aiInsights.providers.copilot.cacheEstimation.enabled` is on - there is nothing to estimate against. This is expected behavior, not a bug.

For genuinely multi-turn older sessions, whether cache shows up further depends on whether `hasRealPromptTokens[i]` was true for that turn (`rawInputTokens > 0`, i.e. Copilot itself reported `result.metadata.promptTokens` for that specific request) - if the Copilot version at the time didn't populate that field, or the session is in `transcripts/` format (which never carries per-turn token data of its own - `hasRealPromptTokens` is hardcoded `false` there, see above), the heuristic has nothing real to diff and produces nothing either.

**Fixed 2026-07-04 - real telemetry was being silently discarded on Remote-WSL/Remote-SSH setups (and, less severely, on any single machine).** `readDebugLogEvents()`'s path derivation (`{extFolder}/debug-logs/{sessionId}/main.jsonl`, computed as `dirname(dirname(filePath))` + `debug-logs/{sessionId}/main.jsonl`) assumed the session file and its debug log live under the same `{extFolder}` two directories up. That holds for `transcripts/{sessionId}.jsonl` (`extFolder/transcripts/..` → `extFolder` two levels up, correct) but **not** for the top-level `chatSessions/{sessionId}.jsonl` VS Code writes directly under the workspace root (`workspaceRoot/chatSessions/..` → derived `workspaceRoot` itself as the "extFolder", so it looked for `workspaceRoot/debug-logs/...` - a path that never exists, since the real one is `workspaceRoot/GitHub.copilot-chat/debug-logs/...`). This meant real cache/token telemetry never attached to the (more common) top-level `chatSessions` format at all, on any machine.

On a Remote-WSL machine this was worse than a missed match: `chatSessions/` is written by the **client-side** VS Code process (e.g. `/mnt/c/Users/<user>/AppData/Roaming/Code/User/workspaceStorage/<hash>/chatSessions/`), while `transcripts/` and `debug-logs/` are written by the **remote extension host** (`~/.vscode-server/data/User/workspaceStorage/<hash>/GitHub.copilot-chat/{transcripts,debug-logs}/`) - two entirely different filesystems that happen to share the same workspace-hash folder name. Both roots get discovered independently by `buildSessionPaths()`/`discoverSessionFiles()`, so **the same Copilot conversation gets parsed twice** - once from `chatSessions` and once from `transcripts` - and `dedupeSessions()` in `extension.ts` picks whichever of the two has the larger `totalTokens` for a given `provider:id` key. Verified on this machine across 7 real duplicate pairs before the fix: the `chatSessions` copy (always heuristic/estimated, since its debug-log path could never resolve) had more tokens in 6 of 7 cases, so **it won and the more accurate real-telemetry `transcripts` copy was silently discarded** for most sessions. Concretely, for session `2603a5da-fc20-...`, the winning (`chatSessions`) copy surfaced a heuristic-estimated `182,298` cache-read / `9,906` cache-write, while the discarded `transcripts` copy had real telemetry reporting `158,592` cache-read with no separate write.

**The fix**: `findDebugLogPath(filePath, sessionId)` (new method) first tries the same cheap structural derivation, then - if that path doesn't exist - searches every discovered `workspaceStorage` root (`this.sessionDirs`) for the same workspace-hash folder, trying each `COPILOT_EXTENSION_FOLDERS` candidate's `debug-logs/{sessionId}/main.jsonl`. This fixes correlation for the top-level `chatSessions` format universally (single machine or remote), and the cross-root search transparently also bridges the Remote-WSL/SSH client/remote-host split since `buildSessionPaths()` already discovers both roots. **Verified against this machine's real data after the fix**: session `2603a5da-fc20-...`'s `chatSessions` copy now correctly shows real telemetry (`cacheReadTokens: 76,288` / `45,824` / `36,480` = `158,592` total, matching the `transcripts` copy exactly) for the three turns its debug log covers, with the heuristic still filling in the remaining turns the debug log has no events for - real and estimated data now correctly coexist within one session instead of the real portion being thrown away entirely. `dedupeSessions()` was not changed; now that both duplicate copies attach real data identically wherever it exists, which copy wins matters far less than before.

**Validated against real local sessions** before implementation (see `applyCacheHeuristic` for the current logic): 3 real multi-turn Claude Sonnet 4.6 sessions showed 44–59% of total prompt tokens attributed to cache reuse, with plausible turn-over-turn growth patterns (e.g. ~31k → ~42k → ~52k prompt tokens per turn, consistent with a system prompt + tool defs + growing history being cached while only new tool results/messages are fresh).

**Aggregate flag for UI display (fixed 2026-07-04)**: `Session.cacheTokensEstimated` (set per-session in `copilot.ts`, `interactions.some(i => i.cacheTokensEstimated)`) rolls up into `ProviderMetrics.cacheTokensEstimated` in [sessionAggregator.md](../core/sessionAggregator.md) (`sessions.some(sess => sess.cacheTokensEstimated)`). `dashboard.ts`'s Cache Efficiency widget and `pricingView.ts`'s usage tables read this flag to decide whether to show the "(calc.)" / "calculated, not measured" disclaimer - previously they checked `cacheReadTokens > 0` instead, which mislabeled real telemetry (from `attachRealCacheData`, see above) as an estimate once real data started flowing in. Real-only periods now show a "measured via Copilot telemetry" label instead.

**Settings** (`package.json` → `aiInsights.providers.copilot.cacheEstimation.*`):
- `enabled` (default `true`) — disable to leave Copilot cache tokens at `0` (pre-2026-07-03 behavior).
- `convention` (default `inclusive`) — controls how the estimate is written back, because two existing core formulas disagree on what `inputTokens` means:
  - `inclusive`: `inputTokens` stays as the real total; cache estimates are a subset of it. Matches `costEstimation.ts`'s `inputTokens - cacheReadTokens - cacheWriteTokens` subtraction, so **cost stays accurate**. Recommended, and the default.
  - `exclusive`: `inputTokens` is reduced to whatever's left after both cache estimates (often ~0). Matches Claude Code's native Anthropic-derived convention and `budgetManager.ts`'s `computeCacheMetrics()` (used by the dashboard's Cache Efficiency widget), making that widget's hit-rate % exact — but understates cost when cache tokens exceed fresh tokens, since the cost formula would then subtract the same tokens twice. Claude Code never hits this in practice because its real fresh-`inputTokens` per turn is tiny (~1–3 tokens); Copilot's estimated fresh delta is not, so this tradeoff is real and visible if selected.

This inconsistency between the two core formulas (`costEstimation.ts`/`sessionAggregator.ts` assume inclusive; `budgetManager.ts computeCacheMetrics` assumes exclusive) predates this feature and wasn't fixed — it was invisible before because Claude Code is the only provider with real cache data and its fresh-token count is always negligible. Fixing it properly would mean auditing every provider's convention, out of scope here.

### `transcripts/` — Copilot Chat's current session format (present since at least v0.46.0, added to AI Insights 2026-07-03)

Copilot Chat has moved to a new typed-event session format at `{extFolder}/transcripts/{sessionId}.jsonl`, alongside (not replacing) `chatSessions/`. Discovery previously never scanned this folder at all, meaning **all sessions on current Copilot Chat versions were invisible** — not badly estimated, simply never found.

**Corrected version claim (2026-07-04):** the 2026-07-03 note above originally said "≥ v0.55" based on a single sampled session. That was a sample-of-one guess, not a verified minimum. Checking every `transcripts/{sessionId}.jsonl` file's own `session.start` event (`data.copilotVersion` / `data.vscodeVersion`) on this machine instead gives real evidence:

| First seen | `copilotVersion` | `vscodeVersion` |
|---|---|---|
| 2026-05-01 (earliest file retained on this machine) | `0.46.0` | `1.118.0` |
| 2026-05-08 – 2026-05-11 | `0.46.2` | `1.118.1` |
| 2026-06-14 | `0.52.0` | `1.124.2` |
| 2026-07-02 – 2026-07-04 | `0.55.0` | `1.127.0` |

So `transcripts/` was already the active format at Copilot Chat **0.46.0** / VS Code **1.118.0** in early May 2026 - the true origin version is unknown and could be earlier still, since 2026-05-01 is simply the oldest file that hasn't aged out of local storage yet, not necessarily the first session ever created in this format. Treat "≥ v0.55" anywhere else in this doc's history as superseded by this table.

Event shape (no `kind` delta-patch wrapper, unlike the older JSONL format):
```json
{"type":"session.start","data":{"sessionId":"...","copilotVersion":"0.55.0",...},"id":"...","timestamp":"..."}
{"type":"user.message","data":{"content":"...","attachments":[]},"id":"...","timestamp":"..."}
{"type":"assistant.turn_start","data":{"turnId":"0"},...}
{"type":"assistant.message","data":{"messageId":"...","content":"...","toolRequests":[...],"reasoningText":"..."},...}
{"type":"tool.execution_start","data":{"toolCallId":"...","toolName":"read_file","arguments":{...}},...}
{"type":"tool.execution_complete","data":{"toolCallId":"...","success":true},...}
{"type":"assistant.turn_end","data":{"turnId":"0"},...}
```

Critically, **this file carries no token/usage data at all** — none of the event types above have a token or usage field anywhere. `parseCopilotChatTranscriptSession()` reads it for conversation content only (one `Interaction` per user turn, aggregating every assistant message and tool call until the next `user.message`), and relies entirely on `attachRealCacheData()` pulling real numbers from the sibling `debug-logs/{sessionId}/main.jsonl` (see above) — turn-id values aren't 1:1 with `llm_request` calls, so correlation is done by timestamp bucketing, not by ID. Without a matching debug log, interactions fall back to text-length estimation with no cache split, same limitation as the heuristic fallback elsewhere.

**Fallback-estimate completeness**: `assistant.message.toolRequests[].arguments` is a JSON-*string* of the model's own generated tool call (a full `apply_patch` diff, `create_file` body, `run_in_terminal` command, etc.) — it's assistant **output**, not the tool's result (`tool.execution_complete` carries only `{toolCallId, success}`, no result content at all — tool results genuinely aren't recoverable from this file). This is now counted in the text-estimate fallback; it wasn't initially, and mattered a lot: one real session's fallback-estimated output jumped from 824 to 7,386 tokens once `apply_patch`/`create_file` payloads were included — those calls can dwarf the visible reply text. `user.message.attachments` was also checked for further signal but was empty in every session sampled on this machine; not wired up since there's no confirmed non-empty shape to parse yet.

**Also present, not wired up**: `debug-logs/{sessionId}/models.json` — a full snapshot of GitHub's model catalog (`billing.is_premium`/`multiplier`, `capabilities.limits.max_context_window_tokens`/`max_prompt_tokens`, thinking budget) for whichever models were available at that session's start. This is billing/context-limit *metadata*, not usage data, so it doesn't feed token calculation directly — but could cross-check or replace hardcoded assumptions in `modelPricing.json` / context-health scoring in a future pass. Not implemented; noted here so it isn't rediscovered from scratch.

### VS Code Copilot Chat OpenTelemetry file export (superseded by `debug-logs/{sessionId}/main.jsonl` above for input/output tokens; still the only source for exact per-call timing)

This channel is real, live-verified, and gives **exact** (not estimated) per-request `input_tokens`/`output_tokens`. It requires opt-in and only covers sessions going forward (no retroactive backfill) — `debug-logs/{sessionId}/main.jsonl` gives the same input/output numbers *and* real cache tokens with zero configuration, so this is no longer the recommended path for those two fields, but is documented here since it was the basis of the 2026-07-02 investigation.

**Enable** (VS Code `settings.json` — note: in a Remote-WSL setup the effective settings file is the **local/Windows-side** one, e.g. `%APPDATA%\Code\User\settings.json`; a WSL-side `~/.vscode-server/data/Machine/settings.json` copy did not take effect in testing):
```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "C:\\Users\\<user>\\.copilot\\otel\\copilot-otel.jsonl",
  "github.copilot.chat.otel.captureContent": false
}
```
Requires **Developer: Reload Window** to take effect — not hot-reloaded. The output directory must exist beforehand (VS Code will not create parent directories). Windows paths must use properly-escaped backslashes (`\\`) in JSON — a raw WSL UNC path (`\\wsl.localhost\...`) written with insufficient escaping silently produces a garbage filename instead of failing loudly.

**Verified real output shape** (from a live session, `gpt-5.3-codex`):
```json
{"attributes":{"event.name":"gen_ai.client.inference.operation.details","gen_ai.operation.name":"chat","gen_ai.request.model":"gpt-5.3-codex","gen_ai.response.model":"gpt-5.3-codex","gen_ai.response.id":"ce12b99c-...","gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.input_tokens":31703,"gen_ai.usage.output_tokens":304,"gen_ai.request.temperature":0,"gen_ai.request.max_tokens":128000}}
```
Other event types seen in the same file: `copilot_chat.session.start` (carries `session.id` matching the corresponding `chatSessions/<id>.jsonl` file — usable for correlation), `copilot_chat.agent.turn`, `copilot_chat.tool.call`. No event anywhere in the file includes a cache-related attribute.

**Not built, and now unnecessary**: a parser for this OTel format was never added, and no longer needs to be — `debug-logs/{sessionId}/main.jsonl` gives the same exact `inputTokens`/`outputTokens` (plus real cache tokens) without requiring the user to opt into OTel export or fight the WSL path-escaping issues above.

### Rendered context extraction (key for accuracy)

Each request in a Copilot session JSON may contain the full rendered prompt inside:
- `result.metadata.renderedUserMessage` — user message + system context block (`<reminderInstructions>`, `<context>`, `<editorContext>`, `<userRequest>`)
- `result.metadata.renderedGlobalContext` — workspace environment block (`<environment_info>`, `<workspace_info>`)

These fields hold the **complete text sent to the API**, including system prompt and all injected context. They are stored as typed arrays:
```json
[{"type": 1, "text": "... full rendered prompt ..."}, {"type": 3, "cacheType": "ephemeral"}]
```
Type 1 = text block; type 3 = cache marker (no text). The `extractRenderedText()` helper handles this format. Without it, only the raw user message is counted (2–21 tokens vs. 250–400+ tokens per turn — a ~60–100× undercount for agent-mode sessions).

The `renderedGlobalContext` is present only in the **first request** of a session; subsequent turns omit it (the model already has it cached).

Newer VS Code JSONL files are patch streams (`kind: 0/1/2`); `parseDeltaJsonlSession()` already reconstructs these before token extraction. Copilot CLI sessions under `~/.copilot/session-state/*/events.jsonl` are already read by `parseCopilotCliSession()`, including exact input/output/cache tokens from `session.compaction_complete` events, and — since 2026-07-07 — from `session.shutdown` events too (see below).

### Copilot CLI: `session.shutdown` carries real per-model cache-write data (fixed 2026-07-07)

`parseCopilotCliSession()` previously ignored `session.shutdown` entirely, so every `assistant.message`-derived interaction kept a text-length input estimate and hardcoded `cacheReadTokens`/`cacheWriteTokens: 0` — even though the CLI's own session-state format reports real, model-attributed cache usage the VS Code extension's `debug-logs/main.jsonl` never does. Confirmed live: a real Claude Sonnet 4.6 CLI session (`~/.copilot/session-state/{id}/events.jsonl`) has

```json
"session.shutdown": {"data": {"modelMetrics": {"claude-sonnet-4.6": {"usage": {
  "inputTokens": 42372, "outputTokens": 136, "cacheReadTokens": 21105, "cacheWriteTokens": 21263
}}}}}
```

i.e. a genuine, billed `cacheWriteTokens` figure — the "OpenAI-style, cache-writes aren't reported" assumption baked into `attachRealCacheData()`'s doc comment only ever held for the VS Code extension's debug-log path, not this one. Two bugs compounded the miss:

1. **`currentModel` was never initialized from `session.start.data.selectedModel`** — only `session.model_change` updated it — so every interaction in a session that never explicitly switched models fell back to the `'gpt-5-mini'` default, silently mispricing Claude/Gemini/GPT CLI sessions.
2. **`session.shutdown` was unhandled** — its `data.modelMetrics[model].usage` is the real total for every API call since the previous `session.start`/`session.shutdown` (one shutdown per "segment"; `session.resume` starts a new one, confirmed by a two-segment file with two independent shutdown blocks).

Fix: `session.start`/`session.resume`'s `selectedModel` now seeds `currentModel`, and a new `reconcileCliSegmentUsage()` runs on each `session.shutdown`, distributing that segment's real `inputTokens`/`cacheReadTokens`/`cacheWriteTokens` across the segment's interactions in proportion to each one's already-real `outputTokens` (even split if all are zero). Verified against the live session above: reconciled totals sum back to the shutdown's real numbers exactly (35,717 cache-read / 28,064 cache-write across two segments), and estimated cost rose from $0.0041 → $0.1188 for that session once the real model + cache-write cost were both counted. Compaction interactions (already real, from `session.compaction_complete`) are excluded from redistribution.

### Design note: why the cache heuristic stays (added 2026-07-05)

The opt-in `debug-logs/{sessionId}/main.jsonl` → `attrs.cachedTokens` source documented
above is the *only* real cache-token source that exists for Copilot Chat. There is no
second source to fall back on, so for the majority of users who never flip the setting
the choice is between `0` and an estimate.

`applyCacheHeuristic()` estimates, but conservatively: it assumes reuse **only** where
prompt tokens actually grew turn-over-turn, and resets on shrink or model change. The
looser alternative - setting `cacheRead = estimated input` outright whenever there is no
`session.shutdown` event with real usage - effectively assumes ~100% cache reuse and was
rejected for that reason. Net effect: our Copilot cache-hit-rate shows non-zero more
often than a no-estimate parser would on the same raw data, which is the intended
trade-off, and every such value is labelled estimated rather than real.

## Other Copilot IDE providers

Copilot sessions outside VS Code are handled by separate providers:

| Provider | Local source | Token-count convention |
| --- | --- | --- |
| [GitHub Copilot for JetBrains](jetbrainsAI.md) | `~/.copilot/jb/{conversationId}/partition-{n}.jsonl` | Estimated from rendered prompt, assistant text, thinking text, and tool result text |
| [Visual Studio Copilot Chat](visualStudio.md) | `.vs/**/copilot-chat/**/sessions/*` and `%LOCALAPPDATA%\Microsoft\VisualStudio\*\VSGitHubCopilot\...` MessagePack session files | Estimated from request/content/context text; no exact API token counts |

Those formats do **not** expose Copilot debug-log cache/input/output telemetry like VS Code's `debug-logs/{sessionId}/main.jsonl`, so cache read/write tokens stay `0` and token totals are estimates.

### GitHub REST API — why it can't replace local scanning

GitHub exposes Copilot usage via REST API, but the data is not useful for per-session tracking:

| Endpoint | Who can call it | What it returns |
|---|---|---|
| `GET /users/{user}/settings/billing/usage` | User (personal plan only) | Monthly premium-request quota consumed — no session detail |
| `GET /orgs/{org}/copilot/metrics/reports/users-1-day` | Org owners / billing managers only | Aggregated daily counts (suggestions, chat turns, lines accepted) — no per-session data |

Individual chat session content, per-session token counts, and conversation history are **not exposed by any GitHub API**. If a user's Copilot license is org-managed, even the personal billing endpoint returns nothing. The local file approach is the only way to get session-level detail.

## Supported models & pricing (as of 2026-06-10)

Pricing sourced from [GitHub Copilot Models & Pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). All prices per 1M tokens.

| Model | Provider | Input | Cached | Output |
|-------|----------|-------|--------|--------|
| GPT-5 mini | OpenAI | $0.25 | $0.025 | $2.00 |
| GPT-5.4 | OpenAI | $2.50 | $0.25 | $15.00 |
| GPT-5.4 (Long context) | OpenAI | $5.00 | $0.50 | $22.50 |
| GPT-5.4 mini | OpenAI | $0.75 | $0.075 | $4.50 |
| GPT-5.4 nano | OpenAI | $0.20 | $0.02 | $1.25 |
| GPT-5.3 Codex | OpenAI | $1.75 | $0.175 | $14.00 |
| GPT-5.5 | OpenAI | $5.00 | $0.50 | $30.00 |
| GPT-5.5 (Long context) | OpenAI | $10.00 | $1.00 | $45.00 |
| Claude Haiku 4.5 | Anthropic | $1.00 | $0.10 | $5.00 |
| Claude Sonnet 4/4.5/4.6 | Anthropic | $3.00 | $0.30 | $15.00 |
| Claude Opus 4.5–4.8 | Anthropic | $5.00 | $0.50 | $25.00 |
| Claude Fable 5 | Anthropic | $10.00 | $1.00 | $50.00 |
| Gemini 2.5 Pro | Google | $1.25 | $0.125 | $10.00 |
| Gemini 3 Flash | Google | $0.50 | $0.05 | $3.00 |
| Gemini 3.1 Pro | Google | $2.00 | $0.20 | $12.00 |
| Gemini 3.1 Pro (Long context) | Google | $4.00 | $0.40 | $18.00 |
| Gemini 3.5 Flash | Google | $1.50 | $0.15 | $9.00 |
| Raptor mini | GitHub | $0.25 | $0.025 | $2.00 |
| MAI-Code-1-Flash | Microsoft | $0.75 | $0.075 | $4.50 |

Anthropic models also have a cache write cost (1.25× input rate). Code completions and next-edit suggestions are not billed per-token.

## Model tracking

Copilot may use multiple underlying models - the provider resolves the actual model via this priority order:

1. `request.modelId` / `request.resolvedModel` / `request.model` - direct fields (skipped if value is `"auto"`)
2. `request.selectedModel.identifier` / `.metadata.id`
3. `request.result.metadata.modelId` - explicit resolved ID in metadata
4. **`request.result.metadata.resolvedModel`** - actual backend model for "auto" mode (e.g. `gpt-5.3-codex`)
5. Most-common `phaseModelId` across `result.metadata.toolCallRounds` - per-round model for agentic sessions

When users select **auto** mode in Copilot, `modelId` is `copilot/auto` but `result.metadata.resolvedModel` stores the actual model GitHub's backend picked (e.g. `gpt-5.3-codex`). This is now surfaced so the dashboard uses real pricing instead of "fallback".

### Local and own-key models (added 2026-10-03)

VS Code Chat also runs non-Copilot models: Ollama, a llama.cpp server behind the
"OpenAI Compatible" endpoint, or the user's own API key. Those chats are written to the
same `chatSessions` files, so they are scanned like any other session.

| Step | Behaviour |
| --- | --- |
| Model id | Only `copilot/` / `github-copilot/` is stripped; any other vendor prefix is kept (`ollama/qwen3-coder:30b`) |
| Vendor stored separately | A bare id plus a non-Copilot `selectedModel.metadata.vendor` becomes `<vendor>/<id>` |
| No id at all, vendor known | `<vendor>/unknown`, never the `gpt-5-mini` fallback |
| Debug-log merge | Tokens are taken, but a non-Copilot model keeps its own name (the log stores the bare id, which could match a hosted model of the same name) |
| Cost | Priced by hosting - see [costEstimation.md](../core/costEstimation.md#model-hosting): local $0, own key at vendor list rate |
| UI | Pricing view tags the model "Local" / "Own key" and shows `–` for its cost columns; Sessions view tags local models "Local" |

Not yet verified against a real session from a local model: the exact field VS Code
uses for the vendor. The `modelId` = `<vendor>/<id>` form is the one Copilot models use
(`copilot/gpt-4.1`).
