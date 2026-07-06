import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BenchmarkAdapter, AdapterRunOptions, AdapterResult, resolveCopilotModel, estimateTokens } from '../benchmark/adapters';

const MAX_TOOL_OUTPUT_CHARS = 8000;
const MAX_SEARCH_RESULTS = 40;
const MAX_TOOL_ITERATIONS = 50;
const WARNING_REMAINING_THRESHOLD = 3;
const MAX_WRITE_CHARS = 200000;
const MAX_TREE_ENTRIES = 300;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target', '.next', '.nuxt']);

const TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the project, given a path relative to the project root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the project root' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories at a path relative to the project root. Omit path to list the root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the project root' } },
    },
  },
  {
    name: 'search_files',
    description: 'Search project source files for a plain-text or regex pattern. Returns matching file paths with line numbers and the matching line.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Text or regex to search for' } },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a brand-new file, or fully replace an existing one, given a path relative to the project root and the full new content. Creates parent directories as needed. For editing part of an EXISTING file, prefer edit_file instead — it avoids having to reproduce the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        content: { type: 'string', description: 'Full new content of the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Make a targeted edit to an existing file by replacing one exact snippet of its current content with new content — far cheaper and safer than write_file for modifying part of a file you already read. old_text must match the file\'s current content exactly (read the file first) and must occur exactly once; include enough surrounding lines to make it unique if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        old_text: { type: 'string', description: 'Exact existing text to find and replace — must appear exactly once in the file' },
        new_text: { type: 'string', description: 'Text to replace it with' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
];

const TOOL_USAGE_HINT = '\n\n---\n\nYou have tools scoped to this project\'s root: read_file, list_directory, search_files (read-only exploration), write_file (create a new file or fully replace one), and edit_file (replace one exact snippet within an existing file — prefer this over write_file for editing part of a file you already read, since it avoids reproducing the whole file). Use them to explore and, for feature/code-generation requests, to actually create and edit files — do not just print file content as your answer instead of writing it.';

/**
 * GitHub Copilot variant used only by A/B Test (not Technique Benchmark's `CopilotAdapter`,
 * which is deliberately tool-less so it measures injected-context strategies in isolation).
 * `vscode.lm.sendRequest` has no implicit workspace access, so without tools this adapter can
 * only ever answer questions about whatever's explicitly attached to the prompt (see
 * `abTestView.ts`'s "attach active editor" feature) — which fails outright on whole-project
 * prompts. This adapter instead advertises a small set of tools scoped to the variant's own
 * worktree (read/list/search, plus write_file to create/replace a file and edit_file to patch
 * part of an existing one) and runs the standard tool-call loop (call → execute locally → feed
 * result back) so the model can genuinely explore and modify the worktree — including
 * multi-file feature-generation-sized tasks, not just single-file edits — bounded by
 * `MAX_TOOL_ITERATIONS` so a confused model can't loop forever.
 */
export class CopilotAgentAdapter implements BenchmarkAdapter {
  readonly id: string;
  readonly name: string;
  private readonly modelId: string;

  constructor(modelId: string, displayName: string) {
    this.id = `copilot-agent-${modelId}`;
    this.name = `Copilot — ${displayName}`;
    this.modelId = modelId;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      const model = await resolveCopilotModel(this.modelId);
      if (model) { return { available: true }; }
      const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (any.length > 0) {
        return {
          available: false,
          reason: `${this.name} is not available in your current Copilot model list. Check your Copilot plan, org model policy, and VS Code/Copilot extension version.`,
        };
      }
      return { available: false, reason: 'GitHub Copilot not signed in or no models available.' };
    } catch {
      return { available: false, reason: 'GitHub Copilot not available in this environment.' };
    }
  }

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const model = await resolveCopilotModel(this.modelId);
    if (!model) { throw new Error(`${this.name} is not available in GitHub Copilot.`); }

    let userPrompt = opts.userPrompt;
    if (opts.history.length > 0) {
      const historyText = opts.history
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n');
      userPrompt = `Context from prior conversation:\n${historyText}\n\n---\n\n${opts.userPrompt}`;
    }

    const fileTree = buildFileTree(opts.worktreePath);
    const treeBlock = fileTree ? `\n\n---\n\nProject file listing (for orientation — you still need read_file/search_files to see contents):\n${fileTree}` : '';
    const initialText = (opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt) + treeBlock + TOOL_USAGE_HINT;
    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(initialText)];

    const start = Date.now();
    let ttft = -1;
    let allText = '';
    let responseText = '';
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let sawRealUsage = false;
    let toolsUsed = false;

    const runTurn = async (withTools: boolean): Promise<{ text: string; toolCalls: vscode.LanguageModelToolCallPart[] }> => {
      const cts = new vscode.CancellationTokenSource();
      const response = await model.sendRequest(messages, withTools ? { tools: TOOLS } : {}, cts.token);

      let text = '';
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const chunk of response.stream) {
        if (ttft === -1) { ttft = Date.now() - start; }
        if (chunk instanceof vscode.LanguageModelTextPart) {
          text += chunk.value;
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(chunk);
        }
      }

      const usage = (response as any).usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (usage?.inputTokens != null) { sawRealUsage = true; inputTokensTotal += usage.inputTokens; }
      if (usage?.outputTokens != null) { sawRealUsage = true; outputTokensTotal += usage.outputTokens; }
      return { text, toolCalls };
    };

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const remaining = MAX_TOOL_ITERATIONS - iteration;
      if (remaining === WARNING_REMAINING_THRESHOLD) {
        messages.push(vscode.LanguageModelChatMessage.User(
          `You have ${remaining} tool calls left before you must give a final answer with no further tool access. ` +
          'Stop exploring now and use your remaining calls to finish: if you still need to create or edit files, call write_file/edit_file now rather than continuing to read or search.',
        ));
      }

      const { text, toolCalls } = await runTurn(true);
      allText += text;

      if (toolCalls.length === 0) {
        responseText = text;
        break;
      }

      toolsUsed = true;
      messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of toolCalls) {
        const output = await executeWorktreeTool(opts.worktreePath, call.name, call.input as Record<string, unknown>);
        resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(output)]));
      }
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    // Ran out of tool-call budget without the model ever giving a final, tool-free answer —
    // force one more request with no tools available so it must answer with what it has.
    if (!responseText.trim()) {
      messages.push(vscode.LanguageModelChatMessage.User(
        'You have used all available tool calls. Give your final answer now, based on everything you found, without calling any more tools.',
      ));
      const { text } = await runTurn(false);
      responseText = text;
      allText += text;
    }

    // Last resort: use whatever incidental text was produced across turns rather than nothing.
    if (!responseText.trim() && allText.trim()) {
      responseText = allText.trim();
    }

    const wallTimeMs = Date.now() - start;

    if (!responseText.trim()) {
      throw new Error(`${this.name} returned an empty response${toolsUsed ? ' after exploring the worktree' : ''} — try a different model or rephrase the prompt.`);
    }

    return {
      response: responseText,
      inputTokens: sawRealUsage ? inputTokensTotal : estimateTokens(initialText),
      outputTokens: sawRealUsage ? outputTokensTotal : estimateTokens(responseText),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tokenSource: sawRealUsage ? 'api' : 'estimated',
      ttftMs: ttft,
      wallTimeMs,
    };
  }
}

function resolveSafePath(worktreePath: string, relPath: string): string | null {
  const target = path.resolve(worktreePath, relPath || '.');
  if (target !== worktreePath && !target.startsWith(worktreePath + path.sep)) { return null; }
  return target;
}

async function executeWorktreeTool(worktreePath: string, name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'read_file') {
      const target = resolveSafePath(worktreePath, String(input?.path ?? ''));
      if (!target) { return 'Error: path escapes the project root.'; }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { return 'Error: not a file.'; }
      const content = fs.readFileSync(target, 'utf8');
      return content.length > MAX_TOOL_OUTPUT_CHARS ? content.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[truncated]' : content;
    }

    if (name === 'list_directory') {
      const target = resolveSafePath(worktreePath, String(input?.path ?? '.'));
      if (!target) { return 'Error: path escapes the project root.'; }
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { return 'Error: not a directory.'; }
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter(e => !IGNORE_DIRS.has(e.name))
        .map(e => e.isDirectory() ? `${e.name}/` : e.name);
      return entries.length ? entries.join('\n') : '(empty directory)';
    }

    if (name === 'search_files') {
      const pattern = String(input?.pattern ?? '');
      if (!pattern) { return 'Error: pattern is required.'; }
      const matches = grepWorktree(worktreePath, pattern);
      return matches.length ? matches.join('\n') : 'No matches found.';
    }

    if (name === 'write_file') {
      const target = resolveSafePath(worktreePath, String(input?.path ?? ''));
      if (!target) { return 'Error: path escapes the project root.'; }
      const content = String(input?.content ?? '');
      if (content.length > MAX_WRITE_CHARS) { return `Error: content too large (max ${MAX_WRITE_CHARS} chars).`; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      const rel = path.relative(worktreePath, target).replace(/\\/g, '/');
      return `Wrote ${content.length} chars to ${rel}`;
    }

    if (name === 'edit_file') {
      const target = resolveSafePath(worktreePath, String(input?.path ?? ''));
      if (!target) { return 'Error: path escapes the project root.'; }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { return 'Error: not a file. Use write_file to create a new file.'; }
      const oldText = String(input?.old_text ?? '');
      const newText = String(input?.new_text ?? '');
      if (!oldText) { return 'Error: old_text is required and must be non-empty.'; }

      const content = fs.readFileSync(target, 'utf8');
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) { return 'Error: old_text not found in the file. Read the file again to get its exact current content before editing.'; }
      if (occurrences > 1) { return `Error: old_text is not unique — found ${occurrences} occurrences. Include more surrounding context to make it match only one place.`; }

      const updated = content.replace(oldText, newText);
      fs.writeFileSync(target, updated, 'utf8');
      const rel = path.relative(worktreePath, target).replace(/\\/g, '/');
      return `Edited ${rel}: replaced ${oldText.length} chars with ${newText.length} chars`;
    }

    return `Error: unknown tool ${name}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function grepWorktree(worktreePath: string, pattern: string): string[] {
  let regex: RegExp;
  try { regex = new RegExp(pattern); } catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }

  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (results.length >= MAX_SEARCH_RESULTS || depth > 8) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) { return; }
      if (IGNORE_DIRS.has(entry.name)) { continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let content: string;
        try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
          if (regex.test(lines[i])) {
            const rel = path.relative(worktreePath, full).replace(/\\/g, '/');
            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
    }
  }

  walk(worktreePath, 0);
  return results;
}

/**
 * Recursively lists relative file paths in the worktree, capped at `MAX_TREE_ENTRIES`. Given to
 * the model upfront so it doesn't need to spend tool-call budget on `list_directory` calls just
 * to discover structure before it can start actually investigating with read_file/search_files —
 * every iteration spent rediscovering the tree is one not spent making progress on the task.
 */
function buildFileTree(worktreePath: string): string {
  const entries: string[] = [];

  function walk(dir: string, depth: number): void {
    if (entries.length >= MAX_TREE_ENTRIES || depth > 8) { return; }
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) { return; }
      if (IGNORE_DIRS.has(item.name)) { continue; }
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, depth + 1);
      } else if (item.isFile()) {
        entries.push(path.relative(worktreePath, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(worktreePath, 0);
  const truncated = entries.length >= MAX_TREE_ENTRIES;
  return entries.join('\n') + (truncated ? `\n...(truncated at ${MAX_TREE_ENTRIES} files — use list_directory/search_files for more)` : '');
}
