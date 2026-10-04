# Session: Sessions View (postMessage) - 2026-05-02

## What was done

- Diagnosed why the Sessions v1 screen remained empty despite the 2026-05-01 fix
- Found that esbuild inlines local variables into template literals, so `${safeJson}` becomes `${JSON.stringify(s).replace(...)}` in the compiled output - still inside a template literal so it evaluates correctly, but `allSessions` being empty when passed to `getHtml` means the webview gets `[]`
- Created a new `SessionsViewProvider` using VS Code's `postMessage` API to send data after the webview loads (bypasses all template-interpolation issues)
- Added `aiInsights.showSessionsView` command and "Sessions v2" button in the dashboard nav

## Files changed

- [`src/webview/sessionsView.ts`](../../src/webview/sessionsView.ts) - new provider; static skeleton HTML + postMessage data flow
- [`src/extension.ts`](../../src/extension.ts) - import `SessionsViewProvider`; register `aiInsights.showSessionsView`; added `showSessionsView()` function
- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) - handle `showSessionsView` message; add "Sessions v2" button in nav
- [`CHANGELOG.md`](../../CHANGELOG.md) - documented new feature

## Architecture: server-side injection via array join

```
showSessionsView(context)
    └─► await refresh(getEnabledProviders())   // allSessions populated
    └─► SessionsViewProvider.createPanel(context, allSessions)
            └─► toRows(sessions)               // sort + map to plain objects
            └─► buildHtml(rows)
                    └─► safe = JSON.stringify(rows).replace(...)
                    └─► parts.push('<script>window.__SESSIONS__=')
                    └─► parts.push(safe)       // plain string, evaluated before push
                    └─► parts.push(';</script>')
                    └─► parts.join('')         // produces full HTML with embedded data
            └─► panel.webview.html = html      // webview renders immediately
```

On Refresh button click:

```
webview sends {command: 'refresh'}
    └─► vscode.commands.executeCommand('aiInsights.showSessionsView')
    └─► showSessionsView → refresh() → createPanel(context, allSessions)
    └─► existing panel's html is replaced with new data
```

## Why array join is more reliable than template injection

| Approach                                        | Risk                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `${safeJson}` in TS template literal            | esbuild inlines variable definition - expression becomes `${JSON.stringify(s).replace(...)}` as literal text |
| `Buffer.from(x).toString('base64')` in template | esbuild compiles to single-quoted string - expression never evaluated                                        |
| `postMessage` after `ready` signal              | Timing race: message can be lost if webview registers listener after `ready` is sent                         |
| `parts.push(safe); parts.join('')`              | safe is a plain string at call time; join() is a runtime call esbuild cannot inline                          |

## Decisions made

- `buildHtml` receives already-evaluated `rows` - no template expressions needed
- Data injection uses `Array.push + join` so esbuild has no template literal to transform
- `infoBar` is server-side rendered HTML (not JS-driven), so session count is visible even if client JS fails
- Refresh re-runs `showSessionsView` to get fresh data and rebuild the HTML

## Follow-up / known gaps

- The v1 `SessionsListProvider` (sessionsList.ts) is still present; can be removed once v2 is confirmed working
- Both panels share no state - opening Sessions and Sessions v2 simultaneously shows different panels independently
