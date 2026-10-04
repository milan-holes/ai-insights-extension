# Performance rules

**Applies to**: anything on the activation or refresh path - `src/extension.ts`, `src/providers/*`,
`src/core/cacheManager.ts`, `src/core/sessionSnapshotStore.ts`.

This extension reads hundreds of session files across six providers, on every refresh, inside the
VS Code extension host - a thread shared with every other extension. Activation was once measured at
**19 673 ms**, of which 87 % was synchronous filesystem I/O that never yielded. The rules below are
what fixed it; they exist because each one was a real regression, not as general advice.

Full measurement and history:
[sessions/2026-10-03-startup-performance.md](sessions/2026-10-03-startup-performance.md).

## Budgets

| Path | Budget | Notes |
| --- | --- | --- |
| `activate()` returning | < 100 ms | must contain no directory walk and no session parsing |
| Warm refresh (parse cache valid) | < 1 s | discovery I/O only |
| Cold refresh (empty parse cache) | < 8 s | must be off the activation path and must yield |
| Longest uninterrupted block of the host thread | < 50 ms | enforce with `yieldToHost()` |

Exceeding a budget is not automatically a blocker, but it must be measured, stated in the session
log, and justified.

## Rules

### 1. Never run a scan from `activate()`

`activate()` registers commands and wires state. The first `refresh()` is scheduled with
`setTimeout(..., 0)`. Anything that touches the filesystem beyond reading a single small config
file belongs behind that boundary.

### 2. `await` on a sync-bodied `async` function does not yield

Every provider's `discoverSessionFiles()` / `parseSessionFile()` is declared `async` but its body
is fully synchronous. Awaiting such a function schedules a **microtask**, and the microtask queue
is drained completely before the event loop runs again - so the host thread stays blocked for the
whole loop. Verified directly:

```js
let fired = false;
setImmediate(() => { fired = true; });
async function syncBody() { const t = Date.now(); while (Date.now() - t < 30) {} }
for (let i = 0; i < 10; i++) { await syncBody(); }   // 300 ms elapsed
console.log(fired);   // false
```

Any loop over an unbounded number of files must call `yieldToHost()` (a real `setImmediate`) every
~20 items. Adding `async`/`await` alone fixes nothing.

### 3. Anything that yields must be re-entrancy guarded

`refresh()` could not overlap itself while it never yielded. Once it does, the 5-minute timer can
fire mid-pass. `refresh()` returns the in-flight promise rather than starting a second scan. Apply
the same guard to any new periodic work that yields.

### 4. Per-file work must not be O(files x roots)

`findDebugLogPath` probed every workspaceStorage root x 4 extension folders **for every session
file**: 1 950 `existsSync` calls, 1 217 ms. Build an index once per scan and look up per file.

Memoization would not have helped here - all 1 950 paths were distinct. Check whether repeated work
is *the same* work before reaching for a cache.

### 5. List a directory; do not probe fixed paths inside it

Probing 13 fixed candidate subdirectories per workspace costs 13 syscalls whether or not they
exist (546 calls, 2 031 ms). One `readdir` of the parent costs one syscall and answers all 13.

### 6. Do not delete `existsSync` before `readdirSync` without measuring

This looks like a free saving and is usually a **regression**. For a directory that does not exist,
the guard is one cheap `stat`; the bare `readdirSync` is a failed syscall *plus* a thrown
exception. Removing the guards made discovery slower. Remove one only where the caller already
knows the directory exists - because it just listed the parent.

### 7. Stat each file once and thread `fs.Stats` through

The lookback cutoff, the cache-freshness check and the provider's timestamp fallback each had their
own `statSync` on the same path - ~438 redundant calls per refresh. The refresh loop stats once and
passes the result to `cacheManager.needsUpdate(file, mtimeMs)`,
`cacheManager.set(file, session, mtimeMs)` and `provider.parseSessionFile(file, stats)`. New code on
this path takes the stat as a parameter; it does not take its own.

### 8. Never read-modify-write a whole store per item

`SessionSnapshotStore.save()` re-read, re-parsed, re-serialized and rewrote the entire snapshot file
on every call, once per parsed Copilot session - quadratic in the number of snapshots, with a
default cap of 2 000. Mutate in memory, set a dirty flag, `flush()` once at the end of the pass.

### 9. Cache parse results - including negative ones

Roughly half the discovered Copilot files parse to `null` and were being re-read on every refresh.
`CacheEntry.sessionData` is `Session | null` precisely so a known-empty file is not re-parsed.

### 10. Caches are per scan unless deliberately persisted

Filesystem probe caches live for one pass and are cleared by `beginScan()` - stale directory
listings would silently hide newly created sessions. The parsed-session cache *is* persisted
(`<globalStorage>/session-parse-cache.json`) because it is invalidated by mtime, which is sound
across restarts.

### 11. Treat `/mnt/c` as roughly 100x slower than native

Under WSL the Windows filesystem is a 9p mount. A single `existsSync` there costs ~0.6 ms. The
Visual Studio provider's depth-7 home-tree walk cost 746-1 474 ms per refresh and found nothing on
any machine without Visual Studio installed. Any scan that can reach `/mnt/c` must be gated on
evidence the target software exists, and throttled.

### 12. Expensive optional scans are gated and throttled

Pattern: cheap evidence check first (does the tool's own log directory exist?), then a time-based
throttle with the previous result reused in between. See `VisualStudioProvider.shouldDeepScan()`.

## Measuring

Do not report a performance change without a before/after measurement. Working recipes:

**CPU profile a scan** - attributes time to syscalls rather than guesswork:

```bash
node --cpu-prof --cpu-prof-dir=prof probe.js
# then aggregate self-time per callFrame from the .cpuprofile JSON
```

**Count `fs` calls by call site** - monkey-patch before requiring the bundle:

```js
['existsSync','statSync','readdirSync','readFileSync'].forEach(name => {
  const orig = fs[name];
  fs[name] = function (...a) {
    const site = new Error().stack.split('\n').find(l => l.includes('probe.js'));
    /* count + time per site */ return orig.apply(fs, a);
  };
});
```

**A/B against a real baseline.** Build the previous revision into a parallel tree
(`git show HEAD:src/providers/copilot.ts > base-src/providers/copilot.ts`) and run both arms
**alternately** in the same session. The OS page cache makes a single before-then-after comparison
worthless - the same code measured 15.9 s cold and 5.1 s warm. Use `process.hrtime.bigint()`, not
`Date.now()`: WSL clock jumps produced a negative duration during this work.

**Prove behaviour is unchanged.** A performance change to discovery or parsing must be accompanied
by a diff of the output: file lists, and per session `id | totalTokens | workspace |
interactions.length`, before and after. Identical output is the acceptance criterion.

**Check the ceiling before optimizing.** Lazy-loading every webview module was estimated at ~150 ms
and measured at ~27 ms (bundle require 106 ms, vs 79 ms with all webview modules stubbed) against
34-144 ms of run-to-run noise - so it was not done. Measure the upper bound first; if it is inside
the noise, say so and move on.
