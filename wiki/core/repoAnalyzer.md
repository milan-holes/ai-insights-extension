# repoAnalyzer

Multi-language static source analysis engine. Scans a workspace and produces a dependency graph + agent handoff document.

## Location

[src/core/repoAnalyzer.ts](../../src/core/repoAnalyzer.ts)

## Supported languages

| Extension(s) | Language | Import detection | Export detection |
|---|---|---|---|
| `.ts`, `.tsx` | TypeScript | ES module `import … from`, dynamic `import()`, `require()` | `export function/class/interface/type/const/enum` |
| `.js`, `.jsx` | JavaScript (incl. React JSX) | ES module + `require()` + named `export {}` + `module.exports` | Same + `module.exports = { … }` |
| `.vue` | Vue (SFC) | `<script>` block: ES module + `require()` | `name:` property or filename, `export default/function/const` |
| `.php` | PHP | `require/require_once/include/include_once` | Top-level `class/interface/trait/enum` and `function` |
| `.py` | Python | Relative `from .module import` only | Top-level `class`, non-private `def`, `UPPER_CONST = ` |
| `.cs` | C# (.NET) | — (namespace-based) | `public/internal class/interface/enum/struct/record` |
| `.vb` | VB.NET | — | `Public/Friend Class/Interface/Enum/Structure/Module` |
| `.fs` | F# | — | Top-level `type`, `let`, `module` |

## Public API

```ts
analyzeRepo(rootPath: string): Promise<RepoGraph>   // async — non-blocking file reads
export const LANG_LABELS: Record<Language, string>  // e.g. 'TS', 'JS', 'Vue', ...
```

## Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_FILES` | 800 | Global cap across the whole walk (shared accumulator, not per-directory). `RepoGraph.truncated` is set when hit. |
| `MAX_FILE_BYTES` | 512 KB | Files larger than this are skipped. |

### `ModuleInfo`

| Field | Type | Description |
|-------|------|-------------|
| `filePath` | `string` | Absolute path |
| `relativePath` | `string` | Relative to workspace root |
| `folder` | `string` | Folder label: `core`, `providers`, `webview`, `benchmark`, `src`, `root` |
| `rawImports` | `string[]` | Raw import specifiers (language-specific) |
| `resolvedImports` | `string[]` | Resolved relative paths of internal module dependencies |
| `exports` | `string[]` | Exported name identifiers |
| `linesOfCode` | `number` | Total line count |
| `language` | `Language` | Detected language |
| `description?` | `string` | LLM-generated summary (optional, populated by webview enrichment) |

### `RepoGraph`

| Field | Description |
|-------|-------------|
| `modules` | All discovered `ModuleInfo` objects |
| `mermaidDiagram` | `graph LR` Mermaid source with `subgraph` per folder |
| `handoffMarkdown` | Always `''` — the webview builds the handoff markdown itself (see Notes) |
| `rootPath` | Workspace root used for analysis |
| `generatedAt` | ISO timestamp |
| `truncated?` | `true` when the 800-file cap was reached |

## How it works

1. **File discovery** — recursive walk from `rootPath`. Skips `node_modules`, `dist`, `.git`, `out`, `build`, `__pycache__`, `vendor`, `.venv`, `venv`, `bin`, `obj`. Collects all supported extensions (not `.d.ts`).
2. **Language detection** — by file extension via `EXT_TO_LANG` map.
3. **First pass** — per file: `extractImports(content, language)` + `extractExports(content, language, path)`. Vue files are parsed through `extractVueScript()` to isolate the `<script>` block first.
4. **Second pass** — `resolveImport()` per language: multi-extension fallback (`ts → tsx → js → jsx → vue → index.*`) for JS/TS/Vue; dot-count traversal for Python; `path.resolve` for PHP. .NET files produce no resolved imports (namespace-based deps).
5. **Mermaid generation** — `subgraph` per folder, one node per file (full filename), edges from resolved imports.

## Notes

- The handoff markdown is built only in the webview (`buildHandoffMarkdown` in [repoAnalysisView.ts](../../src/webview/repoAnalysisView.ts)) at export time, so enriched descriptions and AI enrichment metadata are included in the exported file. `analyzeRepo` no longer pre-builds it.
- `analyzeRepo` is async (`fs.promises.readFile`) so the extension host event loop stays responsive during the scan; webview messages are delivered while analysis runs.
- The webview kicks off the initial analysis itself by posting `analyze` once its script runs — the extension must never auto-post results on a timer, because VS Code silently drops messages sent to a webview that hasn't finished loading.
- React components (`.jsx`, `.tsx`) are treated as JS/TS — component names are extracted via the same `export function/class` patterns.
- For .NET, the graph shows modules and their exports but no edges (no file-level import links).
