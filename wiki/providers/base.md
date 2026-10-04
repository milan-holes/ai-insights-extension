# BaseProvider

**File**: [src/providers/base.ts](../../src/providers/base.ts)

Abstract base class for all AI provider adapters.

## Interface

```ts
abstract class BaseProvider {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;

  abstract getSessionDirectories(): string[];
  abstract discoverSessionFiles(): Promise<string[]>;
  abstract parseSessionFile(filePath: string, stats?: fs.Stats): Promise<Session | null>;

  // Called once before each discovery+parse pass. Default no-op; providers that
  // memoize per scan override it to drop those caches.
  beginScan(): void;

  // Shared helper - estimates token count from raw text
  estimateTokens(text: string, charsPerToken?: number): number;

  // Shared helper - expands a leading ~ to os.homedir(), for user-supplied additional session paths
  expandHome(p: string): string;
}
```

## Per-scan lifecycle

`beginScan()` is called by `refresh()` in [src/extension.ts](../../src/extension.ts) once per pass,
before any provider's `discoverSessionFiles()`. Providers that cache filesystem probes for the
duration of a scan (today only `CopilotProvider`) clear those caches there. The default
implementation does nothing, so providers that hold no state need not implement it.

`parseSessionFile()` takes the refresh loop's already-taken `fs.Stats` for the file. Providers that
need file timestamps should use it rather than stat the path again - the loop stats each file once
to apply the lookback cutoff and to check cache freshness, and passing it through removed two
redundant `statSync` calls per file. The parameter is optional; the provider must still work when
it is absent.

## Token estimation

`estimateTokens(text, charsPerToken)` divides the character count by `charsPerToken`.  
Default ratio is `4.0` (English prose). Override per-provider or per-file-type using `tokenEstimators.json`.

Providers that have real token counts (Claude Code) ignore this method; it is mainly used by Antigravity whose log files contain conversation text rather than structured token data.

## Custom session-folder paths (`additionalSessionPaths`)

Every provider now takes an optional `additionalPaths: string[]` constructor argument, backed by an `aiInsights.providers.<id>.additionalSessionPaths` array setting, for non-standard folders where that provider's sessions are stored (moved home directory, synced backup, remote mount, `CODEX_HOME` override, etc.). `getEnabledProviders()` in `src/extension.ts` reads the setting and passes it through. Each provider's `expandHome()` call (inherited from `BaseProvider`) expands a leading `~` the same way `ClaudeCodeProvider` already did before this was generalized.

What "additional path" means differs per provider, since each has its own on-disk layout:

| Provider | Meaning of each additional path |
| --- | --- |
| Claude Code | An extra directory walked recursively for `.jsonl` files, same as `~/.claude/projects/`. |
| Codex | An extra directory walked recursively for `rollout-*.jsonl` files, same as `$CODEX_HOME/sessions`. |
| GitHub Copilot for JetBrains | An extra `~/.copilot/jb`-style root (directly containing per-conversation folders of `partition-N.jsonl`). |
| Visual Studio | An extra root to recursively scan for `.vs/**/copilot-chat/**/sessions/*` folders, same as the auto-discovered dev roots. |
| GitHub Copilot | An extra directory added to the provider's session-dir list; scanned with the same generic recursive fallback used for any directory that doesn't match a recognized `workspaceStorage`/`.copilot/session-state` layout. |
| Antigravity | An extra **home-style root** expected to contain its own `brain/` and `conversations/` subfolders (mirroring `~/.gemini/antigravity/`) - not a single flat directory of session files. See [antigravity.md](antigravity.md) for why. |

## Adding a new provider

1. Extend `BaseProvider` in `src/providers/<name>.ts`.
2. Implement the three abstract methods.
3. Register the provider in `src/extension.ts → getEnabledProviders()`.
4. Add a `configuration` property in `package.json` for the enabled toggle.
5. Add a pricing entry in `src/data/modelPricing.json` for the provider's model(s).
