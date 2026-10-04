# Webview security model

One page covering how webview content is kept from executing, and where the
rules live. Applies to every panel in [src/webview/](../../src/webview/).

## Threat model

Webviews run with extension privileges: anything that executes in one can
`postMessage` to the extension host. The content they render is **not**
trusted — almost all of it is derived from data the extension merely found on
disk:

| Rendered value | Where it comes from | Attacker control |
| --- | --- | --- |
| Repository label | last path segment of a session's workspace dir | directory name on disk |
| MCP server / tool name | parsed `mcp__<server>__<tool>` tool-call keys in session logs | any configured MCP server |
| Shell command strings | `commandRuns` lifted from Claude Code / Codex transcripts | routinely contains quotes |
| Session title | first prompt / session id | prompt content |
| Sharing error text | raw HTTP response body of the configured team server | the remote server |

## The three rules

### 1. Escape everything session-derived

Use the shared helpers in [navShared.ts](../../src/webview/navShared.ts) —
never a local reimplementation:

| Helper | Use |
| --- | --- |
| `escapeHtml(value)` | TypeScript side, for `${...}` inside an HTML template literal |
| `escJs()` | emits an identical `esc()` into a view's inline script, for client-built rows |

Both escape `& < > " '`. The quote characters matter as much as the angle
brackets: most sinks in these views are `title="..."` attributes, so an escaper
that only handles `<` and `>` (for example a `textContent` → `innerHTML`
round-trip) still allows attribute breakout.

### 2. Every panel sets a CSP

`cspMeta(nonce, cspSource)` / `webviewAssets(webview, extensionUri)` produce the
policy and a per-render nonce:

```
default-src 'none';
img-src <cspSource> data:;      /* data: is the share QR code */
font-src <cspSource>;
style-src 'unsafe-inline' <cspSource>;
script-src 'nonce-<nonce>';
```

`style-src 'unsafe-inline'` is unavoidable — the views are built almost entirely
from inline `style=` attributes, which cannot execute script.

**Consequence:** inline `onclick`/`onchange` attributes do not run. Use a
`data-*` attribute plus a delegated listener instead:

```js
document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-post]');
  if (el && window.vscode) { window.vscode.postMessage({ command: el.getAttribute('data-post') }); }
});
```

Every `<script>` tag — including `src=` ones — needs `nonce="${assets.nonce}"`.
A panel that reuses an existing `currentPanel` must generate a **fresh** nonce
for that render too, or its scripts are blocked.

### 3. No remote script origins

Chart.js and Mermaid live in `assets/vendor/`, refreshed by
[scripts/vendor-assets.sh](../../scripts/vendor-assets.sh) (`npm run vendor:assets`)
and referenced through `assets.chartJsUri` / `assets.mermaidUri`. They were
previously loaded from `cdn.jsdelivr.net`; the Mermaid tag pinned only
`mermaid@10`, so each new 10.x release executed automatically inside a
privileged webview. Panels that load them need
`localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')]`.

## Host-side message handling

The webview is the untrusted side of the boundary — never trust a message
payload just because the shipped UI would not send a bad one:

- `diagnostics.ts` `updateSetting` accepts only keys present in this
  extension's own `contributes.configuration.properties`, with a schema type
  check. Without that it relays an arbitrary global settings write.
- Settings that decide where credentials go or which files are read are
  `"scope": "machine"` in [package.json](../../package.json), so a workspace
  cannot set them: `sharing.mode`, `sharing.teamServer.endpointUrl`,
  `shareHost`, `sharePort`, and all `providers.*.additionalSessionPaths`.

## Known gaps

- `openFile` / `openSession` still accept an arbitrary absolute path from the
  webview and open it in the editor.
- The team-server upload sends a real GitHub OAuth token with no `https:`
  requirement and no confirmation naming the destination host.
- `openExternal` trusts the `dashboardUrl` the remote server returns, including
  its scheme.
