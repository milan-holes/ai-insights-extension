# Visual Studio Copilot Chat Provider

Source: [src/providers/visualStudio.ts](../../src/providers/visualStudio.ts)  
Format was reverse-engineered from real Visual Studio Copilot session files; the fields this parser relies on are documented below.

## Purpose

Reads conversation history from **Visual Studio's GitHub Copilot Chat** extension (VS 2022+, Windows only). Also supports **WSL2**: when the extension runs inside WSL2, the Windows filesystem is scanned via `/mnt/c/Users/`.

## File location

```
<project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
%LOCALAPPDATA%\Microsoft\VisualStudio\<version>\VSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
```

VS stores one binary file per chat session. Solution-scoped chats live inside each project's `.vs` folder. Chats started without a solution open live in Visual Studio's AppData `VSGitHubCopilot` store. WSL2 scans use the equivalent `/mnt/c/Users/<winUser>/AppData/Local/...` paths.

## Discovery

Three strategies run in parallel, results merged by path:

### 1. Log file discovery (fast)
VS writes each session path into temp log files:
```
%LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log
```
Lines matching `Updating session file '<path>'` are extracted and verified.  
WSL2 equivalent: `/mnt/c/Users/<winUser>/AppData/Local/Temp/VSGitHubCopilotLogs/`

### 2. AppData session scan (fast)

Scans Visual Studio's own AppData store for solution-less chats:
```
%LOCALAPPDATA%\Microsoft\VisualStudio\<version>\VSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
```
WSL2 equivalent: `/mnt/c/Users/<winUser>/AppData/Local/Microsoft/VisualStudio/...`

### 3. Filesystem scan (supplemental)
Scans home dir (depth 7) and common dev roots — `C:\repos`, `C:\code`, `C:\src`, `C:\projects`, `C:\dev` (depth 5) — for `.vs` directories, then finds `copilot-chat/{hash}/sessions/{uuid}` files inside.  
WSL2 equivalents: `/mnt/c/Users/<winUser>/` and `/mnt/c/{repos,code,src,…}/`

Skips heavy dirs: `node_modules`, `.git`, `bin`, `obj`, `dist`, `AppData`, `Windows`, `Program Files`, etc.

**Gated and throttled (2026-10-03).** This scan is the single most expensive thing the extension
did at startup on WSL: the home tree lives on the 9p `/mnt/c` mount, where the depth-7 walk cost
746-1 474 ms of blocking I/O on every 5-minute refresh - and found nothing at all on a machine
without Visual Studio installed, which is the common case on Linux and WSL.

It now runs only when there is evidence Visual Studio is present:

| Condition | Effect |
| --- | --- |
| A `VSGitHubCopilotLogs` directory exists (see strategy 1) | deep scan runs |
| `additionalSessionPaths` is configured for this provider | deep scan runs |
| Neither | deep scan skipped; log-file and AppData discovery still run |

When it does run it is throttled to once per 30 minutes (`DEEP_SCAN_INTERVAL_MS`), with the
previous result reused in between and merged into each refresh's output. Files that disappear in
the meantime are dropped by the refresh loop, which stats every candidate anyway. Measured effect:
746 ms -> 16 ms per discovery pass. See
[sessions/2026-10-03-startup-performance.md](../sessions/2026-10-03-startup-performance.md).

## File format

```
[0x01] [MessagePack object 0] [MessagePack object 1] [MessagePack object 2] …
```

- **Byte 0**: version prefix (skipped before decode)
- **Object 0**: session header `{ Name, TimeCreated, TimeUpdated, ConversationMode }`
- **Objects 1, 3, 5, …** (odd): user requests `{ CorrelationId, Content, Model.ModelId, Context }`
- **Objects 2, 4, 6, …** (even): AI responses `{ Content, Model[version, {Id, Name}], Author }`

Decoded with `@msgpack/msgpack` (`decodeMulti`).

## Parsing logic

- `Content` arrays are `[[type, {Content: string}], …]` tuples — text extracted from `inner.Content`.
- `Context` arrays carry `ValueContainer` items; when the value is a numeric-keyed object (raw bytes), it is decoded as nested MessagePack to extract additional `Content` text.
- Session title = first 80 chars of the first user message (VS behaviour).
- Timestamps are distributed evenly between `TimeCreated` and `TimeUpdated` across interaction pairs.
- Model per turn: `Model[1].Id` from the response object; `Model.ModelId` from the request as fallback.

## Token counting

Estimated at 0.25 tokens/char from `requestText + contextText` (input) and `responseText` (output). No actual API counts are stored by VS.

- Input = request `Content` text plus decoded request `Context` text.
- Output = response `Content` text.
- Thinking/cache tokens are always `0`; this MessagePack format does not expose them.

## Session ID

`vs-{uuid}` where `uuid` is the session filename.

## Configuration

```json
"aiInsights.providers.visualStudio.enabled": true
```

## Dependency

Requires `@msgpack/msgpack` (added to `package.json`).
