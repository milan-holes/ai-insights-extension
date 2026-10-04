# Session: Wiki scope separation — product docs only - 2026-10-03

## What was done

Split the wiki by audience. `wiki/` is now exclusively about **our own** product;
research about other projects in this space moved out to a separate research folder
outside `wiki/`, which is where it stays. Documentation and comments only — no
behavior changed, so no `CHANGELOG.md` entry.

- **Moved out of `wiki/`**: three standalone research documents (a market/landscape
  analysis, a Copilot metric-precision deep dive, and a watchlist of tracked projects)
  plus the 2026-10-03 research session log, and the ranked feature-gap analysis that
  had been sitting in `docs/`.
- **Scrubbed the files that stayed.** 12 wiki pages carried third-party names,
  attributions, or paths into the research folder. Every *verified* fact was kept and
  restated on its own evidence; only the attribution and the comparison framing were
  removed. Two session logs were renamed to drop comparative titles.
- **Rewrote one wiki section rather than deleting it.** `providers/copilot.md`'s
  comparison section became "Design note: why the cache heuristic stays" — the
  self-standing conclusion (the opt-in debug log is the only real cache source for
  Copilot Chat, so the conservative turn-over-turn estimate is required for most
  users) survives without the comparison it was wrapped in.
- **Scrubbed five source comments** carrying the same references, including one in
  `src/core/copilotPrefix.ts` that pointed at a wiki path which no longer exists.
  `tsc --noEmit` clean.
- **Codified the rule in all four instruction surfaces** so it holds automatically:
  rule 6 in `CLAUDE.md`, `.cursorrules` and `.github/copilot-instructions.md`, and
  rule 1d plus a "What NOT to put in the wiki" bullet in `llm-wiki-setup.md`.

## Files changed

- `wiki/README.md` - dropped 4 research rows; scrubbed 3 row descriptions
- `wiki/llm-wiki-setup.md` - new rule 1d (wiki scope); extended "What NOT to put in the wiki"
- `wiki/providers/copilot.md` - removed "See also" line; rewrote the comparison section as a design note; made the opt-in-telemetry finding stand on its own reproduction
- `wiki/providers/jetbrainsAI.md`, `wiki/providers/visualStudio.md` - schema/format provenance now says "reverse-engineered from real session files"
- `wiki/providers/claudeCode.md` - token-counting rationale stated as convention, not comparison
- `wiki/core/claudeQuota.md` - "Why it exists" rewritten around the two facts that make it possible (OAuth token on disk, rate-limit response headers)
- `wiki/core/copilotQuota.md` - same treatment for the `copilot_internal/user` endpoint and `computeBudgetPlan()`
- `wiki/copilot-billing-calibration.md` - provenance-labelling standard stated directly
- `wiki/sessions/2026-05-01-sessions-screen-empty-fix.md`, `2026-06-11-webview-design-system.md`, `2026-07-03-copilot-real-cache-tokens.md`, `2026-07-05-copilot-cache-docs-and-dashboard-button.md`, `2026-07-08-copilot-quota.md` - scrubbed
- `wiki/sessions/2026-07-04-usage-maturity-metrics.md` - renamed from `2026-07-04-fluency-inspired-metrics.md`
- `wiki/sessions/2026-08-25-quota-planner-and-coach.md` - renamed from `2026-08-25-competitive-gaps-quota-planner-coach.md`
- `wiki/sessions/2026-08-25-remove-coach-tab.md` - updated the renamed link
- `src/core/copilotPrefix.ts`, `src/core/copilotQuota.ts`, `src/core/claudeQuota.ts`, `src/providers/jetbrainsAI.ts`, `src/providers/visualStudio.ts` - comment provenance scrubbed
- `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` - new mandatory rule 6
- `CHANGELOG.md` - one parenthetical comparison removed from a 2026-05 entry

## Decisions made

- **Scrub, don't delete, the session logs that stayed.** Five of them record our own
  shipped work and the reasoning behind it; the third-party reference was one clause
  in each. Deleting them to satisfy a naming rule would have cost real history.
- **Keep every verified fact, drop every attribution.** The distinction that makes
  this workable: a log field we confirmed on this machine, a setting we reproduced as
  opt-in, a billing rate we calibrated — those are our findings and belong in the
  wiki. Who first pointed at them does not.
- **One-way dependency.** The research folder may link into `wiki/`; `wiki/` never
  links back. Otherwise the separation decays on the first convenient cross-reference.
- **No `CHANGELOG.md` entry.** Rule 5 requires one for shipped behavior changes; this
  shipped none. The one CHANGELOG edit was removing a comparison from existing prose,
  not adding an entry.
- **Renamed two session-log files.** `fluency-inspired-metrics` and
  `competitive-gaps-...` encoded the framing in the filename, where no amount of
  body-text scrubbing reaches.

## Follow-up (resolved same day)

- The dashboard's **"Developer Fluency Score"** heading was flagged here rather than
  changed, since renaming a shipped user-facing string is a product call. It was then
  renamed to **"AI Workflow Maturity"** per user decision, along with the
  `maturityCacheHitPct` / `nowForMaturity` locals and the two section comments in
  `src/webview/dashboard.ts`. The six sub-scores, the four stage labels and every
  threshold are untouched - display only. `tsc --noEmit` clean; `CHANGELOG.md` entry
  added under 0.1.17.

## Follow-up / known gaps

- Pre-existing broken links in `wiki/proposed-metrics.md` (four `../core/...`,
  `../providers/...`, `../architecture.md` links that should not have the `../`) —
  unrelated to this change, left alone.
- `wiki/sessions/2026-08-25-quota-planner-and-coach.md` still links to
  `src/core/coach.ts` / `src/webview/coachView.ts`, which were deleted when the Coach
  tab was reverted. Already flagged in that file's own note.
