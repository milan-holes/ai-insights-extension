# Live Token Counter

Always-on status bar token counter with editor selection support and token highlighting.

**Source**: [src/core/liveTokenCounter.ts](../../src/core/liveTokenCounter.ts)

## Features

| Feature | Description |
|---------|-------------|
| Status bar count | Shows token count for selection or full document, updates on every cursor change |
| Model cycling | Click the status bar item to rotate Claude → GPT → Gemini tokenizer families |
| Token highlighting | Alternating colored decorations on selected text showing approximate token boundaries |
| Customizable | Colors, default model, status bar template all configurable via VS Code settings |

## Commands

| Command ID | Title | Description |
|-----------|-------|-------------|
| `aiInsights.changeTokenModel` | Change Token Counter Model | Cycles tokenizer family (also triggered by status bar click) |
| `aiInsights.toggleTokenHighlight` | Toggle Token Highlighting | Enable/disable alternating token color bands on selection |
| `aiInsights.configureTokenHighlightColors` | Configure Token Highlight Colors | Opens settings panel filtered to `aiInsights.tokenCounter` |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `aiInsights.tokenCounter.defaultFamily` | enum | `claude` | Default tokenizer: `claude` (3.5), `gpt` (4.0), `gemini` (3.8) chars/token |
| `aiInsights.tokenCounter.highlightEnabled` | boolean | `false` | Persist highlight state across sessions |
| `aiInsights.tokenCounter.highlightColorEven` | string | `#FF8C0030` | Background for even-indexed tokens (8-digit hex `#RRGGBBAA`) |
| `aiInsights.tokenCounter.highlightColorOdd` | string | `#4169E130` | Background for odd-indexed tokens |
| `aiInsights.tokenCounter.statusBarTemplate` | string | `$(symbol-numeric) {count}{sel} \| {model}` | Status bar format; placeholders: `{count}`, `{sel}`, `{model}`, `{family}`, `{provider}` |

## Status bar behaviour

- Hidden when no text editor is active or the scheme is `output`/`debug`
- Shows `N sel` when there is an active selection, `N` for full document
- Tooltip: exact count, model name, chars/token ratio
- `{sel}` placeholder expands to `" sel"` when a selection exists, empty string otherwise

## Approximate tokenizer

`approximateTokenRanges(text, charsPerToken)` — exported from the module.

Regex-based splitter that roughly matches BPE behavior:
1. Whitespace runs, newlines — own token spans
2. Identifiers / numbers — single token if `length ≤ maxChars + 1`
3. Long identifiers — chunked at `maxChars` boundaries
4. Every other character (operators, punctuation) — individual token spans

Whitespace-only spans are skipped when building decoration ranges so the highlight only covers visible text.

Cap: text over 200 K characters is truncated before tokenization to keep decoration rendering fast.
