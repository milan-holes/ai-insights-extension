# Session: Copilot cache investigation + Remote-WSL data-loss fix - 2026-07-04

## What was done

User asked two questions and wanted the answers documented:
1. Why don't older Copilot sessions show estimated cache values?
2. What Copilot/VS Code version started using the `transcripts/` folder (where cache-adjacent data lives)?

Investigated by compiling `copilot.ts` (`npx tsc -p .` to `out/`) and running `CopilotProvider.discoverSessionFiles()` / `parseSessionFile()` directly against this machine's real local Copilot data (`~/.vscode-server/data/User/workspaceStorage/**` on the WSL side, `/mnt/c/Users/*/AppData/Roaming/Code/User/workspaceStorage/**` on the Windows side) - no synthetic fixtures, real session/debug-log files. This surfaced a genuine correctness bug beyond the two original questions, which the user then asked to have fixed in the same session.

## Findings

1. **Single-turn sessions can't get a cache estimate, ever** - `applyCacheHeuristic()` needs a previous turn in the same session to diff against. Directly checked: the large majority of `chatSessions/*` files on this machine parse to exactly one `Interaction`, even when the underlying delta-JSONL has dozens of lines (that's just the reply streaming in, not multiple turns). Nothing to fix - documented as expected behavior.
2. **The wiki's "`transcripts/` format ≥ v0.55" claim was a sample-of-one guess and wrong.** Checked every `transcripts/{sessionId}.jsonl` file's own `session.start.data.copilotVersion`/`vscodeVersion` fields on this machine: the format was already active at Copilot Chat `0.46.0` / VS Code `1.118.0` on 2026-05-01 (earliest file retained locally - true origin version unknown, could be earlier). Corrected in `wiki/providers/copilot.md` and the `copilot.ts` doc comment.
3. **Bug found and fixed: real Copilot telemetry was silently discarded, worst on Remote-WSL/SSH setups.** `readDebugLogEvents()` derived the debug-log path as two directories up from the session file (`dirname(dirname(filePath))`), which is only correct when the session file lives under `{extFolder}/transcripts/...`. The top-level `chatSessions/{sessionId}.jsonl` (VS Code's own chat storage, one directory *above* the extension folder - not the extension-nested variant) never matched, on any machine. On Remote-WSL specifically, `chatSessions` (client side) and `transcripts`/`debug-logs` (remote extension host side) are also on two different filesystems entirely (sharing only the workspace-hash folder name), so **the same conversation was parsed twice**, and `dedupeSessions()` in `extension.ts` picks whichever duplicate has more `totalTokens` - verified across 7 real duplicate ID pairs on this machine before the fix, the `chatSessions`-based (always-heuristic, since its debug-log path could never resolve) version won 6 of 7 times, discarding the more accurate `transcripts`-based real-telemetry version. Concrete example: session `2603a5da-fc20-...` had real debug-log telemetry reporting `cacheReadTokens: 158,592`, but the surfaced (dedup-winning) session showed a heuristic-estimated `182,298` read / `9,906` write instead.

## Fix applied

Added `findDebugLogPath(filePath, sessionId)` in `copilot.ts`: tries the existing cheap same-directory derivation first, and if that path doesn't exist, searches every discovered `workspaceStorage` root in `this.sessionDirs` for the same workspace-hash folder, trying each `COPILOT_EXTENSION_FOLDERS` candidate's `debug-logs/{sessionId}/main.jsonl`. `readDebugLogEvents()` now calls this instead of doing the derivation inline.

**Verified against real local data after the fix** (same script, re-run post-build): session `2603a5da-fc20-...`'s `chatSessions`-parsed copy now correctly attaches real telemetry (`76,288` / `45,824` / `36,480` cache-read tokens across three turns, matching its `transcripts` counterpart exactly) instead of applying the heuristic to those turns; the heuristic still fills in the turns its debug log has no events for, so real and estimated data now correctly coexist within one session rather than the real portion being discarded wholesale. Also confirmed no regression across the other 6 previously-duplicate session pairs and a clean `tsc --noEmit` (aside from one pre-existing, unrelated error in `usageHealthScore.ts` from other uncommitted work in this repo).

## Files changed

- `src/providers/copilot.ts` - added `findDebugLogPath()`; `readDebugLogEvents()` now uses it instead of the inline single-path derivation; updated doc comments (including the `transcripts/` version claim).
- `wiki/providers/copilot.md` - corrected the `transcripts/` version claim with a real evidence table; added "why many sessions never show an estimate" explanation; documented the Remote-WSL/SSH bug and the fix, with before/after verification numbers.
- `README.md` - added a bullet to Accuracy & Limitations about single-turn sessions never getting a cache estimate; updated "GitHub Copilot: Real Cache/Token Data" to note remote setups are now handled and the `transcripts/` version floor.
- `CHANGELOG.md` - added entries for the docs corrections and the fix.
- `wiki/README.md` - added this session log entry.

## Decisions made

- Did not change `dedupeSessions()` in `extension.ts` - out of scope once `findDebugLogPath()` fixes correlation at the source; both duplicate parses of a session now attach real data identically wherever it exists, so which one wins the token-count tiebreak matters far less than before. Revisit only if a future case shows the two duplicates still diverging meaningfully after this fix.

## Follow-up / known gaps

- Did not check whether the same client/remote split affects Remote-SSH or Codespaces identically (only verified WSL2 concretely, on this machine's real data) - the code path is the same (`buildSessionPaths()` treats them uniformly, and the fix is remote-topology-agnostic since it just searches all discovered roots), so it's a reasonable inference but unverified elsewhere.
- The two duplicate parses of the same session (`chatSessions` vs `transcripts`) can still disagree on total tokens for turns *without* a matching debug-log event, since each format's fallback text-estimate differs in completeness (`chatSessions`' rendered-context extraction is more complete than `transcripts`' plain-text fallback). Not addressed here - pre-existing, documented elsewhere (`inputTokenMultiplier`, hidden system prompts).
