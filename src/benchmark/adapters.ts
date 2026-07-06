import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface AdapterRunOptions {
  systemPrompt: string;
  /** Prior conversation turns for rot simulation */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  /** Worktree path — used as cwd for CLI adapters so CLAUDE.md is auto-loaded */
  worktreePath: string;
  /** Called with each stdout chunk as it arrives (CLI adapters only) */
  onChunk?: (chunk: string) => void;
}

export interface AdapterResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** 'api' when counts come from provider, 'estimated' when derived from char count */
  tokenSource: 'api' | 'estimated';
  ttftMs: number;
  wallTimeMs: number;
}

export interface BenchmarkAdapter {
  readonly id: string;
  readonly name: string;
  /** Check if this adapter can actually be used in the current environment */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  run(opts: AdapterRunOptions): Promise<AdapterResult>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── 1. Claude Code CLI adapter ────────────────────────────────────────────────
//
// Uses `claude -p "<prompt>"` run inside the worktree so CLAUDE.md is picked
// up automatically. Token counts come from the JSONL written by the session.

// VS Code may not inherit the shell PATH (especially on macOS when launched from Dock).
// Try common install locations so the adapter works even without PATH inheritance.
const CLAUDE_BIN_CANDIDATES = [
  'claude',
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  path.join(os.homedir(), '.claude', 'bin', 'claude'),
];

async function findClaudeBin(): Promise<string | null> {
  for (const bin of CLAUDE_BIN_CANDIDATES) {
    const found = await new Promise<boolean>(resolve => {
      cp.exec(`"${bin}" --version`, (err) => resolve(!err));
    });
    if (found) { return bin; }
  }
  return null;
}

export class ClaudeCodeCliAdapter implements BenchmarkAdapter {
  readonly id = 'claude-code-cli';
  readonly name: string;
  private claudeBin: string | null = null;
  private readonly model?: string;

  constructor(model?: string) {
    this.model = model;
    this.name = model ? `Claude Code — ${model}` : 'Claude Code (CLI)';
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    this.claudeBin = await findClaudeBin();
    if (!this.claudeBin) {
      return {
        available: false,
        reason: 'claude CLI not found in PATH. If installed, try launching VS Code from the terminal: code .',
      };
    }
    return { available: true };
  }

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const bin = this.claudeBin ?? (await findClaudeBin()) ?? 'claude';
    const start = Date.now();

    // Build the full prompt including rot history as a preamble
    let fullPrompt = opts.userPrompt;
    if (opts.history.length > 0) {
      const historyText = opts.history
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n');
      fullPrompt = `Context from prior conversation:\n${historyText}\n\n---\n\n${opts.userPrompt}`;
    }

    // Record JSONL directory before run so we can find the new session after
    const projectKey = opts.worktreePath.replace(/\//g, '-').replace(/^-/, '');
    const jsonlDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
    const beforeFiles = getJsonlMtimes(jsonlDir);

    const args = ['-p', fullPrompt];
    if (opts.systemPrompt.trim()) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (this.model) {
      args.push('--model', this.model);
    }

    // Use spawn (not exec) so we can stream stdout chunks for live display
    const response = await new Promise<string>((resolve, reject) => {
      const child = cp.spawn(bin, args, {
        cwd: opts.worktreePath,
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        opts.onChunk?.(text);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => {
        if (code === 0) { resolve(stdout.trim()); }
        else { reject(new Error(stderr.trim() || `claude exited with code ${code}`)); }
      });
      child.on('error', reject);
    });

    const wallTimeMs = Date.now() - start;

    // Try to read token counts from the JSONL written by the session
    const tokens = readNewSessionTokens(jsonlDir, beforeFiles);

    return {
      response,
      inputTokens: tokens?.inputTokens ?? estimateTokens(opts.systemPrompt + fullPrompt),
      outputTokens: tokens?.outputTokens ?? estimateTokens(response),
      cacheCreationTokens: tokens?.cacheCreationTokens ?? 0,
      cacheReadTokens: tokens?.cacheReadTokens ?? 0,
      tokenSource: tokens ? 'api' : 'estimated',
      ttftMs: -1, // streaming not available in CLI mode
      wallTimeMs,
    };
  }
}

function getJsonlMtimes(dir: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) {
        map.set(f, fs.statSync(path.join(dir, f)).mtimeMs);
      }
    }
  } catch { /* dir may not exist yet */ }
  return map;
}

interface SessionTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function readNewSessionTokens(dir: string, before: Map<string, number>): SessionTokens | null {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    // Find file that is new or was modified after our snapshot
    const newFile = files.find(f => {
      const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      return !before.has(f) || mtime > (before.get(f) ?? 0);
    });
    if (!newFile) { return null; }

    const lines = fs.readFileSync(path.join(dir, newFile), 'utf8').split('\n').filter(Boolean);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const usage = entry.usage ?? entry.message?.usage;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
          cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        }
      } catch { /* skip malformed lines */ }
    }

    return inputTokens > 0 ? { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } : null;
  } catch { return null; }
}

// ── 1b. Codex CLI adapter ──────────────────────────────────────────────────────
//
// Uses `codex exec` (Codex's scripted/non-interactive mode) run inside the
// worktree so AGENTS.md is picked up automatically. `codex exec` is sandboxed
// and does not stop for approvals, matching `claude -p`'s non-interactive
// behavior. Output is requested as JSONL (`--json`) so token usage can be
// read from the event stream; falls back to raw stdout + estimated tokens
// if the event schema doesn't match (older/newer CLI versions).

const CODEX_BIN_CANDIDATES = [
  'codex',
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex',
];

async function findCodexBin(): Promise<string | null> {
  for (const bin of CODEX_BIN_CANDIDATES) {
    const found = await new Promise<boolean>(resolve => {
      cp.exec(`"${bin}" --version`, (err) => resolve(!err));
    });
    if (found) { return bin; }
  }
  return null;
}

export class CodexCliAdapter implements BenchmarkAdapter {
  readonly id = 'codex-cli';
  readonly name: string;
  private codexBin: string | null = null;
  private readonly model?: string;

  constructor(model?: string) {
    this.model = model;
    this.name = model ? `Codex — ${model}` : 'Codex (CLI)';
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    this.codexBin = await findCodexBin();
    if (!this.codexBin) {
      return {
        available: false,
        reason: 'codex CLI not found in PATH. If installed, try launching VS Code from the terminal: code .',
      };
    }
    return { available: true };
  }

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const bin = this.codexBin ?? (await findCodexBin()) ?? 'codex';
    const start = Date.now();

    let fullPrompt = opts.systemPrompt.trim()
      ? `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`
      : opts.userPrompt;
    if (opts.history.length > 0) {
      const historyText = opts.history
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n');
      fullPrompt = `Context from prior conversation:\n${historyText}\n\n---\n\n${fullPrompt}`;
    }

    const args = ['exec', '--json'];
    if (this.model) { args.push('-m', this.model); }
    args.push(fullPrompt);

    const rawOutput = await new Promise<string>((resolve, reject) => {
      const child = cp.spawn(bin, args, {
        cwd: opts.worktreePath,
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        opts.onChunk?.(text);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => {
        if (code === 0) { resolve(stdout); }
        else { reject(new Error(stderr.trim() || `codex exited with code ${code}`)); }
      });
      child.on('error', reject);
    });

    const wallTimeMs = Date.now() - start;
    const parsed = parseCodexJsonlOutput(rawOutput);

    return {
      response: parsed?.response ?? rawOutput.trim(),
      inputTokens: parsed?.inputTokens ?? estimateTokens(fullPrompt),
      outputTokens: parsed?.outputTokens ?? estimateTokens(parsed?.response ?? rawOutput),
      cacheCreationTokens: 0,
      cacheReadTokens: parsed?.cacheReadTokens ?? 0,
      tokenSource: parsed?.inputTokens != null ? 'api' : 'estimated',
      ttftMs: -1,
      wallTimeMs,
    };
  }
}

function parseCodexJsonlOutput(raw: string): { response: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null {
  const lines = raw.split('\n').filter(Boolean);
  const messageParts: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let sawJson = false;

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    sawJson = true;

    const msg = entry.msg ?? entry;
    const type = msg?.type ?? entry.type;
    if (type === 'agent_message' && typeof msg.message === 'string') {
      messageParts.push(msg.message);
    } else if (typeof msg?.text === 'string' && (type === 'agent_message_delta' || type === 'item.completed')) {
      messageParts.push(msg.text);
    }

    const usage = entry.usage ?? msg?.usage ?? (type === 'token_count' ? msg : undefined);
    if (usage) {
      inputTokens = usage.input_tokens ?? usage.inputTokens ?? inputTokens;
      outputTokens = usage.output_tokens ?? usage.outputTokens ?? outputTokens;
      cacheReadTokens = usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? cacheReadTokens;
    }
  }

  if (!sawJson) { return null; }
  return {
    response: messageParts.join('\n').trim(),
    inputTokens,
    outputTokens,
    cacheReadTokens,
  };
}

// ── 2. GitHub Copilot adapter (vscode.lm) ─────────────────────────────────────
//
// Uses VS Code's Language Model API — no API key needed, uses the user's
// existing Copilot subscription. Context injected as system prompt since
// Copilot doesn't read CLAUDE.md files.

export class CopilotAdapter implements BenchmarkAdapter {
  readonly id: string;
  readonly name: string;
  private readonly modelId: string;

  constructor(modelId: string, displayName: string) {
    this.id = `copilot-${modelId}`;
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

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        opts.systemPrompt
          ? `${opts.systemPrompt}\n\n---\n\n${userPrompt}`
          : userPrompt,
      ),
    ];

    const start = Date.now();
    let ttft = -1;
    let responseText = '';

    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(messages, {}, cts.token);

    for await (const chunk of response.stream) {
      if (ttft === -1) { ttft = Date.now() - start; }
      if (chunk instanceof vscode.LanguageModelTextPart) {
        responseText += chunk.value;
      }
    }

    const wallTimeMs = Date.now() - start;
    const usage = (response as any).usage as { inputTokens?: number; outputTokens?: number } | undefined;

    return {
      response: responseText,
      inputTokens: usage?.inputTokens ?? estimateTokens(opts.systemPrompt + userPrompt),
      outputTokens: usage?.outputTokens ?? estimateTokens(responseText),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tokenSource: usage?.inputTokens != null ? 'api' : 'estimated',
      ttftMs: ttft,
      wallTimeMs,
    };
  }
}

export async function resolveCopilotModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
  const exact = await vscode.lm.selectChatModels({ vendor: 'copilot', id: modelId });
  if (exact.length) { return exact[0]; }

  const normalizedTarget = normalizeModelId(modelId);
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return models.find(model => {
    const candidate = model as vscode.LanguageModelChat & { family?: string; version?: string };
    return [candidate.id, candidate.name, candidate.family, candidate.version]
      .filter((value): value is string => typeof value === 'string')
      .some(value => normalizeModelId(value) === normalizedTarget);
  });
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ── 3. Anthropic API adapter ──────────────────────────────────────────────────
//
// Direct Anthropic API — requires an API key stored in VS Code SecretStorage.
// Provides the most granular token data including cache breakdown.

export class AnthropicApiAdapter implements BenchmarkAdapter {
  readonly id = 'anthropic-api';
  readonly name = 'Anthropic API';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    if (!this.apiKey) {
      return { available: false, reason: 'No Anthropic API key set. Enter it in the Benchmark panel.' };
    }
    return { available: true };
  }

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    // Lazy import so the SDK is only loaded when this adapter is used
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const messages = [
      ...opts.history,
      { role: 'user' as const, content: opts.userPrompt },
    ];

    const start = Date.now();
    let ttft = -1;
    let responseText = '';

    const stream = await client.messages.stream({
      model: this.model,
      max_tokens: 1024,
      system: opts.systemPrompt || undefined,
      messages,
    });

    for await (const event of stream) {
      if (ttft === -1 && event.type === 'content_block_delta') {
        ttft = Date.now() - start;
      }
    }

    const msg = await stream.finalMessage();
    responseText = msg.content.map(b => b.type === 'text' ? b.text : '').join('');

    return {
      response: responseText,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheCreationTokens: (msg.usage as any).cache_creation_input_tokens ?? 0,
      cacheReadTokens: (msg.usage as any).cache_read_input_tokens ?? 0,
      tokenSource: 'api',
      ttftMs: ttft,
      wallTimeMs: Date.now() - start,
    };
  }
}

// ── Available adapter IDs ─────────────────────────────────────────────────────

export type AdapterId =
  | 'claude-code-cli'
  | 'copilot-gpt-5.3-codex'
  | 'copilot-gpt-5.4'
  | 'copilot-gpt-5.4-mini'
  | 'copilot-gpt-5.5'
  | 'copilot-claude-sonnet-4.6'
  | 'copilot-claude-opus-4.7'
  | 'copilot-gemini-3-flash'
  | 'copilot-gemini-3.1-pro'
  | 'anthropic-api';

export const ADAPTER_DEFS: Array<{ id: AdapterId; label: string; group: string }> = [
  { id: 'claude-code-cli',              label: 'Claude Code CLI',       group: 'Claude Code' },
  { id: 'copilot-gpt-5.3-codex',        label: 'GPT-5.3 Codex',         group: 'GitHub Copilot' },
  { id: 'copilot-gpt-5.4',              label: 'GPT-5.4',               group: 'GitHub Copilot' },
  { id: 'copilot-gpt-5.4-mini',         label: 'GPT-5.4 mini',          group: 'GitHub Copilot' },
  { id: 'copilot-gpt-5.5',              label: 'GPT-5.5',               group: 'GitHub Copilot' },
  { id: 'copilot-claude-sonnet-4.6',    label: 'Claude Sonnet 4.6',     group: 'GitHub Copilot' },
  { id: 'copilot-claude-opus-4.7',      label: 'Claude Opus 4.7',       group: 'GitHub Copilot' },
  { id: 'copilot-gemini-3-flash',       label: 'Gemini 3 Flash',        group: 'GitHub Copilot' },
  { id: 'copilot-gemini-3.1-pro',       label: 'Gemini 3.1 Pro',        group: 'GitHub Copilot' },
  { id: 'anthropic-api',                label: 'Anthropic API (direct)', group: 'Anthropic' },
];

export function buildAdapter(id: AdapterId, apiKey = '', model = 'claude-sonnet-4-6'): BenchmarkAdapter {
  switch (id) {
    case 'claude-code-cli':
      return new ClaudeCodeCliAdapter();
    case 'copilot-gpt-5.3-codex':
      return new CopilotAdapter('gpt-5.3-codex', 'GPT-5.3 Codex');
    case 'copilot-gpt-5.4':
      return new CopilotAdapter('gpt-5.4', 'GPT-5.4');
    case 'copilot-gpt-5.4-mini':
      return new CopilotAdapter('gpt-5.4-mini', 'GPT-5.4 mini');
    case 'copilot-gpt-5.5':
      return new CopilotAdapter('gpt-5.5', 'GPT-5.5');
    case 'copilot-claude-sonnet-4.6':
      return new CopilotAdapter('claude-sonnet-4.6', 'Claude Sonnet 4.6');
    case 'copilot-claude-opus-4.7':
      return new CopilotAdapter('claude-opus-4.7', 'Claude Opus 4.7');
    case 'copilot-gemini-3-flash':
      return new CopilotAdapter('gemini-3-flash', 'Gemini 3 Flash');
    case 'copilot-gemini-3.1-pro':
      return new CopilotAdapter('gemini-3.1-pro', 'Gemini 3.1 Pro');
    case 'anthropic-api':
      return new AnthropicApiAdapter(apiKey, model);
  }
}
