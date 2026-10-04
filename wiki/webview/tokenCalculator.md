# Token Calculator

Panel for estimating input token costs before sending a prompt to Claude.

**Command**: `AI Insights: Open Token Calculator`  
**Source**: [src/webview/tokenCalculator.ts](../../src/webview/tokenCalculator.ts)  
**Media**: [media/tokenCalculator.css](../../media/tokenCalculator.css), [media/tokenCalculator.js](../../media/tokenCalculator.js)

## Layout

| Column | Contents |
|--------|----------|
| Left (320px) | Workspace file picker with search, **Open files** / Add all / Clear buttons |
| Right | Prompt textarea, token breakdown, context window bars |

## Behaviour

- File list is populated via `vscode.workspace.findFiles` (up to 10,000 files, filtered to text extensions, excludes `node_modules`/`.git`/`dist`/etc.)
- **Open files button**: reads all currently open VS Code editor tabs via `vscode.window.tabGroups.all`, filters to text files within the workspace, streams their content, and auto-selects them. Button label updates to show count (e.g. `Open files (7)`).
- File content is fetched lazily on checkbox select, or streamed in bulk via `get_all_files`
- Token estimate: `chars / 3.5`
- Context window: 200,000 tokens for all three models shown

## Models shown

| Model | Input cost |
|-------|-----------|
| claude-sonnet-4.6 | $3.00/MTok |
| claude-opus-4.7   | $5.00/MTok |
| claude-haiku-4.5  | $1.00/MTok |

## Message protocol (extension ↔ webview)

| Direction | Type | Payload |
|-----------|------|---------|
| webview → ext | `ready` | — |
| ext → webview | `file_list` | `{ files: [{path}] }` |
| webview → ext | `get_file` | `{ path }` |
| ext → webview | `file_content` | `{ path, content }` |
| webview → ext | `get_all_files` | — |
| ext → webview | `all_files_start` | `{ total }` |
| ext → webview | `all_files_done` | — |
| webview → ext | `get_open_files` | — |
| ext → webview | `open_files_start` | `{ total }` |
| ext → webview | `open_files_done` | `{ files: [{path}] }` |
