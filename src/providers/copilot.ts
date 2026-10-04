/**
 * GitHub Copilot session log adapter.
 *
 * Copilot stores chat sessions as JSON files in VS Code's workspaceStorage
 * and globalStorage directories. Each file contains conversation history
 * with message content, model names, and sometimes actual token counts.
 *
 * Session locations:
 *   - ~/.config/Code/User/workspaceStorage/{hash}/state.vscdb (SQLite)
 *   - ~/.config/Code/User/globalStorage/github.copilot-chat/
 *   - ~/.config/Code - Insiders/User/workspaceStorage/{hash}/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseProvider } from './base';
import { CostSource, PromptPrefixBreakdown, Session, Interaction } from '../types';
import { calculateCost, resolveInteractionCost, weakestCostSource, USD_PER_AI_CREDIT } from '../core/costEstimation';
import { modelHosting, modelVendor } from '../core/modelNames';
import { nanoAiuToUsd, observeBilledRequest } from '../core/copilotBillingCalibration';
import { readPromptPrefix } from '../core/copilotPrefix';
import { extractContextRefs } from '../core/contextReferences';

const COPILOT_EXTENSION_FOLDERS = [
  'GitHub.copilot-chat',
  'github.copilot-chat',
  'GitHub.copilot',
  'github.copilot',
];

/** Session-bearing subdirectories inside a workspace's Copilot extension folder. */
const COPILOT_WORKSPACE_SUBDIRS = ['chatSessions', 'transcripts', 'debug-logs'];

const NON_SESSION_PATTERNS = [
  'embeddings',
  'index',
  'cache',
  'preferences',
  'settings',
  'config',
  'workspacesessions',
  'globalsessions',
  'api.json',
];

const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type CopilotCacheConvention = 'inclusive' | 'exclusive';

/** One `llm_request` telemetry event from `debug-logs/<session>/main.jsonl`. */
interface DebugLogEvent {
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model: string;
  /**
   * GitHub's own billed cost for this request, from `attrs.copilotUsageNanoAiu`.
   * Undefined when the field is absent (older Copilot versions).
   */
  billedUsd?: number;
}

/**
 * Session cost for a Copilot session, preferring GitHub's own billed figure over our
 * estimate turn by turn.
 *
 * Copilot bills non-cached input at the cache-creation rate, so estimates here use the
 * `copilot` billing shape - see core/costEstimation.ts. `costSource` reports the weakest
 * source that contributed, so a session is only called `billed` when nothing in it had to
 * be estimated.
 */
function resolveCopilotSessionCost(interactions: Interaction[]): {
  estimatedCostUsd: number;
  costSource: CostSource;
  billedCostUsd?: number;
  billedInteractionCount: number;
} {
  let total = 0;
  let billedTotal = 0;
  let billedCount = 0;
  const sources: CostSource[] = [];

  for (const i of interactions) {
    const { usd, source } = resolveInteractionCost('copilot', i);
    total += usd;
    sources.push(source);
    if (source === 'billed') {
      billedTotal += usd;
      billedCount += 1;
    }
  }

  return {
    estimatedCostUsd: total,
    costSource: weakestCostSource(sources),
    billedCostUsd: billedCount > 0 ? billedTotal : undefined,
    billedInteractionCount: billedCount,
  };
}

export class CopilotProvider extends BaseProvider {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';

  private readonly sessionDirs: string[];
  private readonly inputTokenMultiplier: number;
  private readonly cacheEstimationEnabled: boolean;
  private readonly cacheEstimationConvention: CopilotCacheConvention;

  constructor(
    inputTokenMultiplier = 1.0,
    cacheEstimationEnabled = true,
    cacheEstimationConvention: CopilotCacheConvention = 'inclusive',
    additionalPaths: string[] = [],
  ) {
    super();
    this.inputTokenMultiplier = Math.max(0.1, inputTokenMultiplier);
    this.cacheEstimationEnabled = cacheEstimationEnabled;
    this.cacheEstimationConvention = cacheEstimationConvention;
    this.sessionDirs = this.buildSessionPaths(additionalPaths.map(p => this.expandHome(p)));
  }

  // ── Per-scan caches ─────────────────────────────────────────────────────────
  // Discovery and parsing probe the same handful of directories once per session
  // file. On WSL those probes land on the 9p /mnt/c mount where a single
  // existsSync costs ~0.6ms, so the repeats dominated refresh time. These caches
  // live for one scan only and are dropped by beginScan().

  /** Directory path -> exists. */
  private dirExistsCache = new Map<string, boolean>();
  /** sessionId -> candidate debug-log roots that exist, built once per scan. */
  private debugLogIndex: Map<string, string[]> | null = null;
  /** workspaceStorage hash dir -> resolved workspace label. */
  private workspaceCache = new Map<string, string>();
  /** File path -> stat, seeded by parseSessionFile so each file is stat'd once. */
  private statCache = new Map<string, fs.Stats | null>();
  /** Directory -> entry names, null when unreadable. Shared by discovery and the debug-log index. */
  private dirListCache = new Map<string, Set<string> | null>();

  /** Drop per-scan caches. Called by the extension before each refresh. */
  beginScan(): void {
    this.dirExistsCache.clear();
    this.debugLogIndex = null;
    this.workspaceCache.clear();
    this.statCache.clear();
    this.dirListCache.clear();
  }

  /**
   * readdir memoized for one scan. Discovery and the debug-log index both walk
   * the same workspace roots, so without this each root is listed twice.
   */
  private listDir(dir: string): Set<string> | null {
    const hit = this.dirListCache.get(dir);
    if (hit !== undefined) { return hit; }
    let names: Set<string> | null = null;
    try { names = new Set(fs.readdirSync(dir)); } catch { names = null; }
    this.dirListCache.set(dir, names);
    return names;
  }

  /** statSync memoized for the duration of one scan. */
  private statOf(filePath: string): fs.Stats | null {
    const hit = this.statCache.get(filePath);
    if (hit !== undefined) { return hit; }
    let stats: fs.Stats | null = null;
    try { stats = fs.statSync(filePath); } catch { stats = null; }
    this.statCache.set(filePath, stats);
    return stats;
  }

  /** existsSync for a directory, memoized for the duration of one scan. */
  private dirExists(dir: string): boolean {
    const hit = this.dirExistsCache.get(dir);
    if (hit !== undefined) { return hit; }
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch { exists = false; }
    this.dirExistsCache.set(dir, exists);
    return exists;
  }

  private buildSessionPaths(additionalPaths: string[]): string[] {
    const home = os.homedir();
    const dirs = new Set<string>();

    // VS Code variants and their config directories
    const codeVariants = [
      'Code',
      'Code - Insiders',
      'Code - Exploration',
      'VSCodium',
      'Cursor',
    ];

    const platform = os.platform();

    for (const variant of codeVariants) {
      let configBase: string;
      if (platform === 'win32') {
        configBase = path.join(home, 'AppData', 'Roaming', variant, 'User');
      } else if (platform === 'darwin') {
        configBase = path.join(home, 'Library', 'Application Support', variant, 'User');
      } else {
        // Linux
        configBase = path.join(home, '.config', variant, 'User');
      }

      this.addVSCodeUserSessionDirs(dirs, configBase);
    }

    // VS Code Remote / Server paths (WSL, SSH remotes, containers, Codespaces).
    for (const userDir of [
      path.join(home, '.vscode-server', 'data', 'User'),
      path.join(home, '.vscode-server-insiders', 'data', 'User'),
      path.join(home, '.vscode-remote', 'data', 'User'),
      path.join('/tmp', '.vscode-server', 'data', 'User'),
      path.join('/workspace', '.vscode-server', 'data', 'User'),
    ]) {
      this.addVSCodeUserSessionDirs(dirs, userDir);
    }

    // WSL2: VS Code runs on Windows, so workspace data is in Windows AppData
    if (platform === 'linux' && this.isWSL2()) {
      for (const winUserDir of this.findWSLWindowsUsers()) {
        for (const variant of codeVariants) {
          const winBase = path.join(winUserDir, 'AppData', 'Roaming', variant, 'User');
          this.addVSCodeUserSessionDirs(dirs, winBase);
        }
      }
    }

    dirs.add(path.join(home, '.copilot', 'session-state'));

    for (const p of additionalPaths) { dirs.add(p); }

    return [...dirs];
  }

  private addVSCodeUserSessionDirs(dirs: Set<string>, userDir: string): void {
    dirs.add(path.join(userDir, 'workspaceStorage'));
    dirs.add(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'));
    for (const folder of COPILOT_EXTENSION_FOLDERS) {
      dirs.add(path.join(userDir, 'globalStorage', folder));
    }
  }

  private isWSL2(): boolean {
    try {
      return fs.readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
    } catch { return false; }
  }

  private findWSLWindowsUsers(): string[] {
    const mntC = '/mnt/c/Users';
    try {
      if (!fs.existsSync(mntC)) { return []; }
      const skip = new Set(['Public', 'Default', 'Default User', 'All Users']);
      return fs.readdirSync(mntC, { withFileTypes: true })
        .filter(e => e.isDirectory() && !skip.has(e.name))
        .map(e => path.join(mntC, e.name));
    } catch { return []; }
  }

  getSessionDirectories(): string[] {
    return this.sessionDirs;
  }

  async discoverSessionFiles(): Promise<string[]> {
    const files = new Set<string>();

    for (const dir of this.sessionDirs) {
      try {
        if (dir.includes('workspaceStorage')) {
          // Scan each workspace folder for chatSessions.
          //
          // One readdir of the workspace root (and of each Copilot extension
          // folder that is actually present) replaces blind existsSync probes of
          // 13 fixed candidate paths per workspace. With ~40 workspaces that was
          // ~550 probes per refresh, nearly all on paths that do not exist.
          const workspaces = fs.readdirSync(dir, { withFileTypes: true });
          for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const workspaceRoot = path.join(dir, ws.name);

            const present = this.listDir(workspaceRoot);
            if (!present) { continue; }

            if (present.has('chatSessions')) {
              this.addSessionFilesFromDir(files, path.join(workspaceRoot, 'chatSessions'));
            }
            for (const folder of COPILOT_EXTENSION_FOLDERS) {
              if (!present.has(folder)) { continue; }
              const folderRoot = path.join(workspaceRoot, folder);
              const inFolder = this.listDir(folderRoot);
              if (!inFolder) { continue; }
              for (const sub of COPILOT_WORKSPACE_SUBDIRS) {
                if (inFolder.has(sub)) {
                  this.addSessionFilesFromDir(files, path.join(folderRoot, sub));
                }
              }
            }
          }
        } else if (dir.includes(`${path.sep}.copilot${path.sep}session-state`)) {
          this.addCopilotCliSessionFiles(files, dir);
        } else {
          // Global storage can contain emptyWindowChatSessions directly or
          // extension-specific nested session/debug files.
          if (dir.endsWith('emptyWindowChatSessions')) {
            this.addSessionFilesFromDir(files, dir);
          } else {
            this.addSessionFilesRecursively(files, dir);
          }
        }
      } catch {
        // Directory not accessible, skip
      }
    }

    return [...files];
  }

  async parseSessionFile(filePath: string, stats?: fs.Stats): Promise<Session | null> {
    // The refresh loop already stat'd this file to apply the lookback cutoff;
    // reuse it so getFileFallbackDate does not stat the same path again.
    if (stats) { this.statCache.set(filePath, stats); }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      if (filePath.endsWith('.jsonl') || this.isJsonlContent(content)) {
        if (this.isCopilotCliSessionPath(filePath)) {
          return this.parseCopilotCliSession(filePath, content);
        }
        if (this.isCopilotChatTranscriptPath(filePath)) {
          return this.parseCopilotChatTranscriptSession(filePath, content);
        }
        return this.parseJsonlSession(filePath, content);
      } else {
        return this.parseJsonSession(filePath, content);
      }
    } catch {
      return null;
    }
  }

  private parseJsonSession(filePath: string, content: string): Session | null {
    try {
      const data = JSON.parse(content);

      // Copilot chat sessions have a specific structure
      const interactions: Interaction[] = [];
      const hasRealPromptTokens: boolean[] = [];
      const fallbackTimestamp = this.getFileFallbackDate(filePath);
      let startTime = fallbackTimestamp;
      let endTime = fallbackTimestamp;

      // Handle array of requests/responses
      const requests = data.requests || data.history || [];
      if (requests.length === 0) { return null; }

      for (const req of requests) {
        const timestamp = this.parseTimestamp(
          req.timestamp || req.date || req.createdAt || req.updatedAt || data.timestamp || data.date || data.createdAt || data.updatedAt,
          fallbackTimestamp,
        );
        if (interactions.length === 0) { startTime = timestamp; }
        endTime = timestamp;

        const model = this.getModelFromRequest(req, data.model || 'gpt-5-mini');
        const renderedInput = [
          this.extractRenderedText(req.result?.metadata?.renderedUserMessage),
          this.extractRenderedText(req.result?.metadata?.renderedGlobalContext),
        ].filter(s => s.length > 0).join('\n');
        const inputText = renderedInput || this.extractInputText(req);
        const outputText = this.extractResponseText(req.response || req.responses);

        // Use actual token counts if available, otherwise estimate.
        const rawInputTokens = this.pickTokenCount(req, [
          'tokens.input', 'tokens.inputTokens', 'tokens.prompt', 'tokens.promptTokens',
          'usage.input_tokens', 'usage.prompt_tokens', 'usage.inputTokens', 'usage.promptTokens',
          'result.usage.promptTokens', 'result.usage.inputTokens',
          'result.promptTokens', 'result.metadata.promptTokens', 'promptTokens',
        ]);
        const outputTokens = this.pickTokenCount(req, [
          'tokens.output', 'tokens.outputTokens', 'tokens.completion', 'tokens.completionTokens',
          'usage.output_tokens', 'usage.completion_tokens', 'usage.outputTokens', 'usage.completionTokens',
          'result.usage.outputTokens', 'result.usage.completionTokens',
          'result.outputTokens', 'result.metadata.outputTokens', 'completionTokens',
        ]) ||
          this.estimateTokens(outputText);
        const cacheReadTokens = this.pickTokenCount(req, [
          'tokens.cacheRead', 'tokens.cache_read', 'tokens.cachedInput', 'tokens.cached_input',
          'usage.cache_read_input_tokens', 'usage.cached_tokens', 'usage.cached_input_tokens',
          'cacheReadTokens',
        ]);
        const cacheWriteTokens = this.pickTokenCount(req, [
          'tokens.cacheWrite', 'tokens.cache_write', 'tokens.cacheCreation', 'tokens.cache_creation',
          'usage.cache_creation_input_tokens', 'usage.cache_write_input_tokens',
          'cacheWriteTokens',
        ]);
        const estimatedInputTokens = Math.round(this.estimateTokens(inputText) * this.inputTokenMultiplier);
        const inputTokens = Math.max(rawInputTokens || estimatedInputTokens, cacheReadTokens + cacheWriteTokens);

        const toolCalls: string[] = [];
        if (req.response?.toolCalls) {
          for (const tc of req.response.toolCalls) {
            toolCalls.push(tc.name || tc.function?.name || 'unknown');
          }
        }

        const thinkingTokens = this.pickTokenCount(req, ['tokens.thinking', 'usage.thinking_tokens']) || 0;

        interactions.push({
          timestamp,
          model,
          inputTokens,
          outputTokens,
          thinkingTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: inputTokens + outputTokens + thinkingTokens,
          effectiveContextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
          mode: this.getModeFromRequest(req),
          toolCalls,
          promptPreview: inputText ? inputText.trim().substring(0, 200) : undefined,
          contextRefs: extractContextRefs(inputText),
        });
        hasRealPromptTokens.push(rawInputTokens > 0);
      }

      if (interactions.length === 0) { return null; }

      const hasRealCacheData = this.attachRealCacheData(filePath, interactions, hasRealPromptTokens);
      this.applyCacheHeuristic(interactions, hasRealPromptTokens, hasRealCacheData);

      const totalTokens = interactions.reduce((sum, i) => sum + i.totalTokens, 0);
      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const totalCacheWriteTokens = interactions.reduce((s, i) => s + i.cacheWriteTokens, 0);
      const cost = resolveCopilotSessionCost(interactions);

      // Extract title from data or first message
      let title = data.title;
      if (!title && requests[0]) {
        const firstInput = this.extractInputText(requests[0]);
        if (firstInput) {
          title = firstInput.split('\n')[0].substring(0, 80);
        }
      }

      return {
        id: data.sessionId || path.basename(filePath, path.extname(filePath)),
        provider: 'copilot',
        providerName: 'GitHub Copilot',
        startTime,
        endTime,
        interactions,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
        totalCacheReadTokens,
        totalCacheWriteTokens,
        models: [...new Set(interactions.map(i => i.model))],
        workspace: this.extractWorkspace(filePath),
        sourceFile: filePath,
        title,
        estimatedCostUsd: cost.estimatedCostUsd,
        promptPrefix: this.readSessionPromptPrefix(filePath, interactions) ?? undefined,
        costSource: cost.costSource,
        billedCostUsd: cost.billedCostUsd,
        billedInteractionCount: cost.billedInteractionCount,
        cacheTokensEstimated: interactions.some(i => i.cacheTokensEstimated),
      };
    } catch {
      return null;
    }
  }

  private parseJsonlSession(filePath: string, content: string): Session | null {
    try {
      const lines = content.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0) { return null; }

      if (this.isDeltaJsonl(lines)) {
        return this.parseDeltaJsonlSession(filePath, lines);
      }

      const interactions: Interaction[] = [];
      const hasRealPromptTokens: boolean[] = [];
      let startTime: Date | null = null;
      const fallbackTimestamp = this.getFileFallbackDate(filePath);
      let endTime = fallbackTimestamp;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const timestamp = this.parseTimestamp(
            entry.timestamp || entry.date || entry.createdAt || entry.updatedAt,
            fallbackTimestamp,
          );
          if (!startTime) { startTime = timestamp; }
          endTime = timestamp;

          const model = this.normalizeModelId(entry.model || entry.modelId || 'gpt-5-mini');
          const cacheReadTokens = this.pickTokenCount(entry, [
            'tokens.cacheRead', 'tokens.cache_read', 'tokens.cachedInput', 'tokens.cached_input',
            'usage.cache_read_input_tokens', 'usage.cached_tokens', 'usage.cached_input_tokens',
            'cacheReadTokens',
          ]);
          const cacheWriteTokens = this.pickTokenCount(entry, [
            'tokens.cacheWrite', 'tokens.cache_write', 'tokens.cacheCreation', 'tokens.cache_creation',
            'usage.cache_creation_input_tokens', 'usage.cache_write_input_tokens',
            'cacheWriteTokens',
          ]);
          const rawInputTokens = this.pickTokenCount(entry, [
            'promptTokens', 'tokens.input', 'tokens.inputTokens', 'tokens.prompt', 'tokens.promptTokens',
            'usage.input_tokens', 'usage.prompt_tokens', 'usage.inputTokens', 'usage.promptTokens',
          ]);
          const estimatedInput = Math.round(this.estimateTokens(entry.prompt || entry.message || '') * this.inputTokenMultiplier);
          const inputTokens = Math.max(rawInputTokens || estimatedInput, cacheReadTokens + cacheWriteTokens);
          const outputTokens = this.pickTokenCount(entry, [
            'completionTokens', 'tokens.output', 'tokens.outputTokens', 'tokens.completion', 'tokens.completionTokens',
            'usage.output_tokens', 'usage.completion_tokens', 'usage.outputTokens', 'usage.completionTokens',
          ]) ||
            this.estimateTokens(entry.completion || entry.response || '');
          const thinkingTokens = this.pickTokenCount(entry, ['tokens.thinking', 'usage.thinking_tokens']) || 0;

          const promptText = (entry.prompt || entry.message || '').toString().trim();
          interactions.push({
            timestamp,
            model,
            inputTokens,
            outputTokens,
            thinkingTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens + thinkingTokens,
            effectiveContextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
            mode: entry.mode || 'chat',
            toolCalls: [],
            promptPreview: promptText ? promptText.substring(0, 200) : undefined,
            contextRefs: extractContextRefs(promptText),
          });
          hasRealPromptTokens.push(rawInputTokens > 0);
        } catch {
          // Skip malformed lines
        }
      }

      if (interactions.length === 0) { return null; }

      const hasRealCacheData = this.attachRealCacheData(filePath, interactions, hasRealPromptTokens);
      this.applyCacheHeuristic(interactions, hasRealPromptTokens, hasRealCacheData);

      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const totalCacheWriteTokens = interactions.reduce((s, i) => s + i.cacheWriteTokens, 0);
      const cost = resolveCopilotSessionCost(interactions);

      return {
        id: path.basename(filePath, '.jsonl'),
        provider: 'copilot',
        providerName: 'GitHub Copilot',
        startTime: startTime || fallbackTimestamp,
        endTime,
        interactions,
        totalTokens: interactions.reduce((sum, i) => sum + i.totalTokens, 0),
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
        totalCacheReadTokens,
        totalCacheWriteTokens,
        models: [...new Set(interactions.map(i => i.model))],
        workspace: this.extractWorkspace(filePath),
        sourceFile: filePath,
        estimatedCostUsd: cost.estimatedCostUsd,
        promptPrefix: this.readSessionPromptPrefix(filePath, interactions) ?? undefined,
        costSource: cost.costSource,
        billedCostUsd: cost.billedCostUsd,
        billedInteractionCount: cost.billedInteractionCount,
        cacheTokensEstimated: interactions.some(i => i.cacheTokensEstimated),
      };
    } catch {
      return null;
    }
  }

  private parseDeltaJsonlSession(filePath: string, lines: string[]): Session | null {
    const fallbackTimestamp = this.getFileFallbackDate(filePath);
    const state: Record<string, unknown> = Object.create(null);
    const requestsById = new Map<string, any>();

    const captureRequest = (request: any) => {
      if (!request || typeof request !== 'object') { return; }
      const requestId = request.requestId;
      if (typeof requestId !== 'string' || !requestId) { return; }
      const existing = requestsById.get(requestId);
      if (!existing) {
        requestsById.set(requestId, request);
        return;
      }

      const previousCompletionTokens = existing.completionTokens ?? 0;
      const nextCompletionTokens = request.completionTokens ?? 0;
      requestsById.set(requestId, {
        ...existing,
        ...request,
        completionTokens: Math.max(previousCompletionTokens, nextCompletionTokens),
      });
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        this.applyDelta(state, event);
        if (Array.isArray((state as any).requests)) {
          for (const request of (state as any).requests) {
            captureRequest(request);
          }
        }
      } catch {
        // Skip malformed lines; partial session data is better than no session.
      }
    }

    const requests = [...requestsById.values()];
    if (requests.length === 0) { return null; }

    const interactions: Interaction[] = [];
    const hasRealPromptTokens: boolean[] = [];
    let startTime = fallbackTimestamp;
    let endTime = fallbackTimestamp;

    for (const request of requests) {
      const timestamp = this.parseTimestamp(request.timestamp || request.createdAt || request.updatedAt, fallbackTimestamp);
      if (interactions.length === 0) { startTime = timestamp; }
      if (timestamp > endTime || endTime.getTime() === fallbackTimestamp.getTime()) { endTime = timestamp; }

      const model = this.getModelFromRequest(request, 'gpt-5-mini');
      const renderedInput = [
        this.extractRenderedText(request.result?.metadata?.renderedUserMessage),
        this.extractRenderedText(request.result?.metadata?.renderedGlobalContext),
      ].filter(s => s.length > 0).join('\n');
      const inputText = renderedInput || this.extractInputText(request);
      const outputText = this.extractResponseText(request.response || request.responses);

      const rawInputTokens = this.pickTokenCount(request, [
        'promptTokens', 'inputTokens',
        'result.promptTokens', 'result.inputTokens',
        'result.metadata.promptTokens', 'result.usage.promptTokens', 'result.usage.inputTokens',
      ]);
      const outputTokens = this.pickTokenCount(request, [
        'completionTokens', 'outputTokens',
        'result.outputTokens', 'result.completionTokens',
        'result.metadata.outputTokens', 'result.usage.outputTokens', 'result.usage.completionTokens',
      ]) || this.estimateTokens(outputText);
      const inputTokens = rawInputTokens || Math.round(this.estimateTokens(inputText) * this.inputTokenMultiplier);
      const thinkingTokens = this.estimateTokens(this.extractThinkingText(request.response || request.responses));

      interactions.push({
        timestamp,
        model,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens + thinkingTokens,
        effectiveContextTokens: inputTokens,
        mode: this.getModeFromRequest(request),
        toolCalls: this.extractToolCalls(request),
        promptPreview: inputText ? inputText.trim().substring(0, 200) : undefined,
        contextRefs: extractContextRefs(inputText),
      });
      hasRealPromptTokens.push(rawInputTokens > 0);
    }

    if (interactions.length === 0) { return null; }

    const hasRealCacheData = this.attachRealCacheData(filePath, interactions, hasRealPromptTokens);
    this.applyCacheHeuristic(interactions, hasRealPromptTokens, hasRealCacheData);

    const cost = resolveCopilotSessionCost(interactions);

    const session = this.buildSession(filePath, path.basename(filePath, '.jsonl'), startTime, endTime, interactions);
    session.estimatedCostUsd = cost.estimatedCostUsd;
    session.promptPrefix = this.readSessionPromptPrefix(filePath, interactions) ?? undefined;
    session.costSource = cost.costSource;
    session.billedCostUsd = cost.billedCostUsd;
    session.billedInteractionCount = cost.billedInteractionCount;
    session.cacheTokensEstimated = interactions.some(i => i.cacheTokensEstimated);
    session.title = (state as any).title;
    if (!session.title && requests[0]) {
      const firstInput = this.extractInputText(requests[0]);
      if (firstInput) {
        session.title = firstInput.split('\n')[0].substring(0, 80);
      }
    }
    return session;
  }

  private parseCopilotCliSession(filePath: string, content: string): Session | null {
    const fallbackTimestamp = this.getFileFallbackDate(filePath);
    const interactions: Interaction[] = [];
    let sessionId = path.basename(path.dirname(filePath));
    let currentModel = 'gpt-5-mini';
    let pendingInputEstimate = 0;
    let startTime: Date | null = null;
    let endTime = fallbackTimestamp;
    let segmentStart = 0;

    for (const line of content.trim().split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const event = JSON.parse(line);
        const timestamp = this.parseTimestamp(event.timestamp, fallbackTimestamp);
        if (!startTime) { startTime = timestamp; }
        endTime = timestamp;

        if (event.type === 'session.start' && event.data?.sessionId) {
          sessionId = event.data.sessionId;
        }
        if ((event.type === 'session.start' || event.type === 'session.resume') && event.data?.selectedModel) {
          currentModel = this.normalizeModelId(event.data.selectedModel);
        }
        if (event.type === 'session.model_change' && event.data?.newModel) {
          currentModel = this.normalizeModelId(event.data.newModel);
        }

        if (['system.message', 'user.message', 'tool.execution_complete'].includes(event.type)) {
          pendingInputEstimate += this.estimateTokens(JSON.stringify(event.data ?? ''));
        }

        if (event.type === 'assistant.message') {
          const outputTokens = this.pickTokenCount(event, ['data.outputTokens', 'outputTokens']);
          const inputTokens = pendingInputEstimate;
          interactions.push({
            timestamp,
            model: currentModel,
            inputTokens,
            outputTokens,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: inputTokens + outputTokens,
            effectiveContextTokens: inputTokens,
            mode: 'agent',
            toolCalls: this.extractToolRequests(event.data?.toolRequests),
          });
          pendingInputEstimate = this.estimateTokens(JSON.stringify(event.data?.content ?? '')) +
            this.estimateTokens(JSON.stringify(event.data?.toolRequests ?? ''));
        }

        if (event.type === 'session.compaction_complete' && event.data?.compactionTokensUsed) {
          const usage = event.data.compactionTokensUsed;
          const inputTokens = usage.inputTokens ?? 0;
          const outputTokens = usage.outputTokens ?? 0;
          const cacheReadTokens = usage.cacheReadTokens ?? 0;
          const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
          interactions.push({
            timestamp,
            model: this.normalizeModelId(usage.model ?? currentModel),
            inputTokens,
            outputTokens,
            thinkingTokens: 0,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens,
            effectiveContextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
            mode: 'compaction',
            toolCalls: [],
          });
        }

        if (event.type === 'session.shutdown') {
          this.reconcileCliSegmentUsage(interactions, segmentStart, event.data?.modelMetrics);
          segmentStart = interactions.length;
        }
      } catch {
        // Skip malformed lines.
      }
    }

    if (interactions.length === 0) { return null; }
    const cost = resolveCopilotSessionCost(interactions);

    const session = this.buildSession(filePath, sessionId, startTime || fallbackTimestamp, endTime, interactions);
    session.estimatedCostUsd = cost.estimatedCostUsd;
    session.promptPrefix = this.readSessionPromptPrefix(filePath, interactions) ?? undefined;
    session.costSource = cost.costSource;
    session.billedCostUsd = cost.billedCostUsd;
    session.billedInteractionCount = cost.billedInteractionCount;
    return session;
  }

  /**
   * The CLI's `session.shutdown` event carries real, model-attributed usage totals
   * (`data.modelMetrics[model].usage`) for every `assistant.message` call since the previous
   * `session.start`/`session.shutdown` - including `cacheWriteTokens`, which Copilot CLI's
   * Claude-model billing genuinely reports (unlike the VS Code extension's debug-log telemetry,
   * see `attachRealCacheData`). Only the segment aggregate is real; there's no per-call
   * breakdown, so this distributes each field across that segment's interactions in proportion
   * to their already-real `outputTokens` (falling back to an even split if all are zero).
   * Compaction interactions already carry their own real numbers and are left untouched.
   */
  private reconcileCliSegmentUsage(interactions: Interaction[], segmentStart: number, modelMetrics: unknown): void {
    if (!modelMetrics || typeof modelMetrics !== 'object') { return; }

    for (const [rawModel, metrics] of Object.entries(modelMetrics as Record<string, any>)) {
      const usage = metrics?.usage;
      if (!usage) { continue; }
      const model = this.normalizeModelId(rawModel);
      const realInput = Number(usage.inputTokens) || 0;
      const realCacheRead = Number(usage.cacheReadTokens) || 0;
      const realCacheWrite = Number(usage.cacheWriteTokens) || 0;

      const segment = interactions
        .slice(segmentStart)
        .filter(interaction => interaction.model === model && interaction.mode !== 'compaction');
      if (segment.length === 0) { continue; }

      const outputWeightTotal = segment.reduce((sum, i) => sum + i.outputTokens, 0);

      for (const interaction of segment) {
        const weight = outputWeightTotal > 0 ? interaction.outputTokens / outputWeightTotal : 1 / segment.length;
        interaction.inputTokens = Math.round(realInput * weight);
        interaction.cacheReadTokens = Math.round(realCacheRead * weight);
        interaction.cacheWriteTokens = Math.round(realCacheWrite * weight);
        interaction.totalTokens = interaction.inputTokens + interaction.outputTokens + interaction.thinkingTokens;
        interaction.effectiveContextTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
      }
    }
  }

  /**
   * Parses Copilot Chat's newer typed-event transcript format (`transcripts/{sessionId}.jsonl`,
   * confirmed present since at least Copilot Chat v0.46.0 / VS Code 1.118.0 - see
   * wiki/providers/copilot.md for the version-evidence table; true origin version unknown).
   * This format replaced the flat `requests` JSON blob and carries no
   * token/usage data of its own - only conversation content (`session.start`, `user.message`,
   * `assistant.turn_start/end`, `assistant.message`, `tool.execution_start/complete`). Real token
   * and cache counts, when available, come from the sibling `debug-logs/{sessionId}/main.jsonl`
   * telemetry file via `attachRealCacheData`; otherwise interactions fall back to text-length
   * estimates like the other formats.
   *
   * One interaction is emitted per user turn (from a `user.message` up to, but not including,
   * the next one), aggregating every assistant message and tool call in between - this mirrors
   * how the JSON `requests` format treats one API round-trip (including its internal tool-call
   * rounds) as a single interaction.
   */
  private parseCopilotChatTranscriptSession(filePath: string, content: string): Session | null {
    const fallbackTimestamp = this.getFileFallbackDate(filePath);
    const lines = content.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) { return null; }

    let sessionId = path.basename(filePath, '.jsonl');
    const interactions: Interaction[] = [];
    const hasRealPromptTokens: boolean[] = [];
    let startTime: Date | null = null;
    let endTime = fallbackTimestamp;
    let firstUserMessage: string | undefined;

    let pendingUserText = '';
    let pendingUserTimestamp: Date | null = null;
    let outputParts: string[] = [];
    let thinkingParts: string[] = [];
    let toolCalls = new Set<string>();
    let hasContent = false;
    let lastTimestamp = fallbackTimestamp;

    const flush = () => {
      if (!pendingUserTimestamp && !hasContent) { return; }
      const timestamp = pendingUserTimestamp ?? lastTimestamp;
      if (!startTime) { startTime = timestamp; }
      const outputText = outputParts.join('\n');
      const inputTokens = this.estimateTokens(pendingUserText);
      const outputTokens = this.estimateTokens(outputText);
      const thinkingTokens = this.estimateTokens(thinkingParts.join('\n'));
      interactions.push({
        timestamp,
        model: 'gpt-5-mini',
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens + thinkingTokens,
        effectiveContextTokens: inputTokens,
        mode: 'agent',
        toolCalls: [...toolCalls],
        promptPreview: pendingUserText ? pendingUserText.trim().substring(0, 200) : undefined,
        contextRefs: extractContextRefs(pendingUserText),
      });
      hasRealPromptTokens.push(false);
      pendingUserText = '';
      pendingUserTimestamp = null;
      outputParts = [];
      thinkingParts = [];
      toolCalls = new Set<string>();
      hasContent = false;
    };

    for (const line of lines) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      const timestamp = this.parseTimestamp(event?.timestamp, fallbackTimestamp);

      switch (event?.type) {
        case 'session.start':
          if (typeof event.data?.sessionId === 'string' && event.data.sessionId) {
            sessionId = event.data.sessionId;
          }
          break;
        case 'user.message':
          flush();
          pendingUserText = typeof event.data?.content === 'string' ? event.data.content : '';
          pendingUserTimestamp = timestamp;
          if (!firstUserMessage && pendingUserText) { firstUserMessage = pendingUserText; }
          hasContent = true;
          break;
        case 'assistant.message':
          if (typeof event.data?.content === 'string' && event.data.content) { outputParts.push(event.data.content); }
          if (typeof event.data?.reasoningText === 'string' && event.data.reasoningText) { thinkingParts.push(event.data.reasoningText); }
          if (Array.isArray(event.data?.toolRequests)) {
            for (const tr of event.data.toolRequests) {
              const name = tr?.name || tr?.toolName;
              if (typeof name === 'string' && name) { toolCalls.add(name); }
              // `arguments` is the model's own generated tool-call payload (e.g. a full
              // apply_patch diff or create_file body) - it's part of the assistant's output,
              // not the tool's result, and can dwarf the visible reply text.
              if (typeof tr?.arguments === 'string' && tr.arguments) { outputParts.push(tr.arguments); }
            }
          }
          hasContent = true;
          break;
        case 'tool.execution_start':
          if (typeof event.data?.toolName === 'string' && event.data.toolName) { toolCalls.add(event.data.toolName); }
          hasContent = true;
          break;
        default:
          break;
      }

      lastTimestamp = timestamp;
      endTime = timestamp;
    }
    flush();

    if (interactions.length === 0) { return null; }

    const hasRealCacheData = this.attachRealCacheData(filePath, interactions, hasRealPromptTokens);
    this.applyCacheHeuristic(interactions, hasRealPromptTokens, hasRealCacheData);

    const cost = resolveCopilotSessionCost(interactions);

    const session = this.buildSession(filePath, sessionId, startTime || fallbackTimestamp, endTime, interactions);
    session.estimatedCostUsd = cost.estimatedCostUsd;
    session.promptPrefix = this.readSessionPromptPrefix(filePath, interactions) ?? undefined;
    session.costSource = cost.costSource;
    session.billedCostUsd = cost.billedCostUsd;
    session.billedInteractionCount = cost.billedInteractionCount;
    session.cacheTokensEstimated = interactions.some(i => i.cacheTokensEstimated);
    if (firstUserMessage) {
      session.title = firstUserMessage.split('\n')[0].substring(0, 80);
    }
    return session;
  }

  /**
   * Reads real per-call token/cache counts from the `llm_request` telemetry events in the
   * sibling `debug-logs/{sessionId}/main.jsonl` file, when one exists next to `filePath`
   * (i.e. `.../<ext-folder>/{chatSessions,transcripts}/{sessionId}.{json,jsonl}` ->
   * `.../<ext-folder>/debug-logs/{sessionId}/main.jsonl`). `attrs.cachedTokens` there is the
   * portion of `attrs.inputTokens` already served from the model provider's prompt cache
   * (mirrors OpenAI's `usage.prompt_tokens_details.cached_tokens`, a subset of the total) -
   * there's no separate cache-write/creation count.
   *
   * That absence is a reporting gap, not a billing one: calibrating against
   * `copilotUsageNanoAiu` shows Copilot *does* bill the uncached remainder at the
   * cache-creation rate, which for Anthropic models is 1.25x input. `cacheWriteTokens` is
   * therefore left at 0 here (we cannot measure it) and the cost path infers it from
   * `inputTokens - cachedTokens` instead - see core/costEstimation.ts's `copilot` shape.
   * Also reads `attrs.copilotUsageNanoAiu`, GitHub's own billed cost for the request.
   *
   * Buckets each event into whichever interaction most recently started before it (by
   * timestamp), since a single user turn can trigger several LLM calls in agent mode and the
   * debug log has no other shared identifier back to the parsed session content. Returns a
   * `hasRealCacheData` flag per interaction so `applyCacheHeuristic` never overwrites a bucket
   * that already reflects real telemetry, even when its real cache count happens to be zero.
   */
  /**
   * Reads the fixed prompt prefix (system prompt + tool catalog) from the
   * `system_prompt_*.json` / `tools_*.json` sidecars Copilot writes next to the debug
   * log, and attributes the catalog to tools this session actually called.
   *
   * Returns null whenever the sidecars aren't there - they're written for only some
   * sessions, so a missing prefix is normal and must not be reported as zero.
   */
  private readSessionPromptPrefix(filePath: string, interactions: Interaction[]): PromptPrefixBreakdown | null {
    const sessionId = path.basename(filePath, path.extname(filePath));
    const debugLogPath = this.findDebugLogPath(filePath, sessionId);
    if (!debugLogPath) { return null; }

    const calledTools = new Set<string>();
    for (const interaction of interactions) {
      for (const tool of interaction.toolCalls) { calledTools.add(tool); }
    }

    const withInput = interactions.filter(i => i.inputTokens > 0);
    const meanInputTokens = withInput.length > 0
      ? withInput.reduce((sum, i) => sum + i.inputTokens, 0) / withInput.length
      : undefined;

    return readPromptPrefix(debugLogPath, calledTools, meanInputTokens);
  }

  private attachRealCacheData(filePath: string, interactions: Interaction[], hasRealPromptTokens: boolean[]): boolean[] {
    const hasRealCacheData = interactions.map(() => false);
    if (interactions.length === 0) { return hasRealCacheData; }

    const debugEvents = this.readDebugLogEvents(filePath);
    if (debugEvents.length === 0) { return hasRealCacheData; }

    const order = interactions
      .map((_, idx) => idx)
      .sort((a, b) => interactions[a].timestamp.getTime() - interactions[b].timestamp.getTime());

    const buckets = new Map<number, {
      input: number; output: number; cached: number;
      models: Map<string, number>;
      billedUsd: number; billedEvents: number; totalEvents: number;
    }>();

    for (const ev of debugEvents) {
      let target = order[0];
      for (const idx of order) {
        if (interactions[idx].timestamp.getTime() <= ev.ts) { target = idx; } else { break; }
      }
      const bucket = buckets.get(target) ?? {
        input: 0, output: 0, cached: 0, models: new Map<string, number>(),
        billedUsd: 0, billedEvents: 0, totalEvents: 0,
      };
      bucket.input += ev.inputTokens;
      bucket.output += ev.outputTokens;
      bucket.cached += ev.cachedTokens;
      bucket.totalEvents += 1;
      if (ev.billedUsd !== undefined) {
        bucket.billedUsd += ev.billedUsd;
        bucket.billedEvents += 1;
      }
      if (ev.model) { bucket.models.set(ev.model, (bucket.models.get(ev.model) ?? 0) + 1); }
      buckets.set(target, bucket);
    }

    for (const [idx, bucket] of buckets) {
      const interaction = interactions[idx];
      interaction.inputTokens = bucket.input;
      interaction.outputTokens = bucket.output;
      interaction.cacheReadTokens = bucket.cached;
      interaction.cacheWriteTokens = 0;
      interaction.cacheTokensEstimated = false;
      // Only claim an exact cost when every request behind this turn reported one;
      // a partial sum would silently under-report an agent turn's real spend.
      interaction.billedCostUsd = bucket.billedEvents > 0 && bucket.billedEvents === bucket.totalEvents
        ? bucket.billedUsd
        : undefined;
      interaction.totalTokens = interaction.inputTokens + interaction.outputTokens + interaction.thinkingTokens;
      interaction.effectiveContextTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
      // The debug log names the bare model; keep the vendor-prefixed id of a non-Copilot
      // model rather than letting it be priced as the hosted model of the same name.
      if (bucket.models.size > 0 && modelHosting(interaction.model) === 'provider') {
        const bestModel = [...bucket.models.entries()].sort((a, b) => b[1] - a[1])[0][0];
        interaction.model = this.normalizeModelId(bestModel);
      }
      hasRealPromptTokens[idx] = true;
      hasRealCacheData[idx] = true;
    }

    return hasRealCacheData;
  }

  /**
   * Parses `llm_request` events out of `debug-logs/{sessionId}/main.jsonl`, if it can be found
   * for `filePath`'s session. Derives the debug-log path structurally (parent-of-parent of
   * `filePath`, plus `debug-logs/{sessionId}/main.jsonl`), which works for `transcripts/` and
   * for `chatSessions/` when nested under the extension folder - but the top-level
   * `workspaceRoot/chatSessions/{sessionId}.ext` VS Code actually writes (client-side chat
   * storage, one directory higher than the extension folder) doesn't match that shape, so
   * `findDebugLogPath()` falls back to searching every discovered `workspaceStorage` root for
   * the same workspace hash. That fallback also covers Remote-WSL/SSH/Codespaces, where
   * `chatSessions` (written by the local UI process) and `transcripts`/`debug-logs` (written by
   * the remote extension host) live on two different filesystems under the same hash.
   */
  private readDebugLogEvents(filePath: string): DebugLogEvent[] {
    try {
      const sessionId = path.basename(filePath, path.extname(filePath));
      const debugLogPath = this.findDebugLogPath(filePath, sessionId);
      if (!debugLogPath) { return []; }

      const content = fs.readFileSync(debugLogPath, 'utf-8');
      const events: DebugLogEvent[] = [];
      for (const line of content.trim().split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const event = JSON.parse(line);
          if (event?.type !== 'llm_request') { continue; }
          const attrs = event.attrs ?? {};
          const inputTokens = typeof attrs.inputTokens === 'number' ? attrs.inputTokens : 0;
          const outputTokens = typeof attrs.outputTokens === 'number' ? attrs.outputTokens : 0;
          const cachedTokens = typeof attrs.cachedTokens === 'number' ? attrs.cachedTokens : 0;
          const model = typeof attrs.model === 'string' ? attrs.model : '';
          // GitHub's own billed cost for this request. Exact, and present on every
          // token-bearing request in current Copilot versions.
          const billedUsd = typeof attrs.copilotUsageNanoAiu === 'number' && attrs.copilotUsageNanoAiu > 0
            ? nanoAiuToUsd(attrs.copilotUsageNanoAiu, USD_PER_AI_CREDIT)
            : undefined;

          // Feed the calibration oracle before anyone asks for an estimate: compare what
          // we would have predicted at list rates against what GitHub charged.
          if (billedUsd !== undefined && model) {
            const predicted = calculateCost(model, inputTokens, outputTokens, cachedTokens, 0, {
              shape: 'copilot',
              calibrate: false,
            });
            observeBilledRequest(model, predicted, billedUsd);
          }

          events.push({
            ts: typeof event.ts === 'number' ? event.ts : 0,
            inputTokens,
            outputTokens,
            cachedTokens,
            model,
            billedUsd,
          });
        } catch {
          // Skip malformed telemetry lines.
        }
      }
      return events.sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  }

  /**
   * Locates `debug-logs/{sessionId}/main.jsonl` for a session file. Tries the structural
   * same-directory derivation first (cheap, and correct for `transcripts/` and any
   * extension-nested `chatSessions/`), then falls back to searching every discovered
   * `workspaceStorage` root for the same workspace-hash folder - this also covers the top-level
   * `workspaceRoot/chatSessions/{sessionId}.ext` layout (one directory above the extension
   * folder, so the structural derivation misses it even on a single machine) and the
   * Remote-WSL/SSH/Codespaces case where the client-side `chatSessions` file and the remote
   * host's `debug-logs` sit under the same hash on two entirely different filesystems.
   */
  /**
   * Index every debug-log directory once per scan: sessionId -> the debug-logs
   * roots that contain it.
   *
   * Previously this was probed per session file, looping every workspaceStorage
   * root x every extension folder and existsSync-ing each candidate. That is
   * O(files x roots) syscalls - ~1950 existsSync calls for 95 files here, 1.2s
   * of the refresh, nearly all of them on paths that do not exist. One readdir
   * per debug-logs root replaces all of it.
   */
  private getDebugLogIndex(): Map<string, string[]> {
    if (this.debugLogIndex) { return this.debugLogIndex; }
    const index = new Map<string, string[]>();

    const roots: string[] = [];
    for (const dir of this.sessionDirs) {
      if (!dir.replace(/\\/g, '/').endsWith('/workspaceStorage')) { continue; }
      let hashes: fs.Dirent[];
      try { hashes = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const hashDir of hashes) {
        if (!hashDir.isDirectory()) { continue; }
        const workspaceRoot = path.join(dir, hashDir.name);
        const present = this.listDir(workspaceRoot);
        if (!present) { continue; }
        for (const folder of COPILOT_EXTENSION_FOLDERS) {
          if (!present.has(folder)) { continue; }
          const inFolder = this.listDir(path.join(workspaceRoot, folder));
          if (!inFolder?.has('debug-logs')) { continue; }
          roots.push(path.join(workspaceRoot, folder, 'debug-logs'));
        }
      }
    }

    for (const root of roots) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const existing = index.get(entry.name);
        if (existing) { existing.push(root); } else { index.set(entry.name, [root]); }
      }
    }

    this.debugLogIndex = index;
    return index;
  }

  private findDebugLogPath(filePath: string, sessionId: string): string | null {
    const roots = this.getDebugLogIndex().get(sessionId);
    if (!roots || roots.length === 0) { return null; }

    // A log living under this session file's own extension folder still wins, so
    // precedence matches the previous structural-candidate-first behaviour.
    const structuralRoot = path.join(path.dirname(path.dirname(filePath)), 'debug-logs');
    const ordered = roots.includes(structuralRoot)
      ? [structuralRoot, ...roots.filter(r => r !== structuralRoot)]
      : roots;

    for (const root of ordered) {
      const candidate = path.join(root, sessionId, 'main.jsonl');
      if (fs.existsSync(candidate)) { return candidate; }
    }
    return null;
  }

  private isCopilotChatTranscriptPath(filePath: string): boolean {
    return filePath.replace(/\\/g, '/').includes('/transcripts/') && filePath.endsWith('.jsonl');
  }

  private buildSession(filePath: string, id: string, startTime: Date, endTime: Date, interactions: Interaction[]): Session {
    return {
      id,
      provider: 'copilot',
      providerName: 'GitHub Copilot',
      startTime,
      endTime,
      interactions,
      totalTokens: interactions.reduce((sum, i) => sum + i.totalTokens, 0),
      totalInputTokens: interactions.reduce((s, i) => s + i.inputTokens, 0),
      totalOutputTokens: interactions.reduce((s, i) => s + i.outputTokens, 0),
      totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
      totalCacheReadTokens: interactions.reduce((s, i) => s + i.cacheReadTokens, 0),
      totalCacheWriteTokens: interactions.reduce((s, i) => s + i.cacheWriteTokens, 0),
      models: [...new Set(interactions.map(i => i.model))],
      workspace: this.extractWorkspace(filePath),
      sourceFile: filePath,
    };
  }

  private extractWorkspace(filePath: string): string {
    const parts = filePath.split(path.sep);
    const wsIdx = parts.indexOf('workspaceStorage');
    if (wsIdx >= 0 && wsIdx + 1 < parts.length) {
      const hashDir = parts.slice(0, wsIdx + 2).join(path.sep);
      // Every session file in a workspace resolves to the same workspace.json,
      // so read it once per hash dir rather than once per file.
      const cached = this.workspaceCache.get(hashDir);
      if (cached !== undefined) { return cached; }

      let label = parts[wsIdx + 1].substring(0, 8) + '...';
      try {
        const wsJson = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf-8'));
        const uri: string = wsJson.folder || wsJson.workspace;
        if (uri) { label = this.resolveVSCodeUri(uri); }
      } catch { /* keep the hash-prefix fallback */ }
      this.workspaceCache.set(hashDir, label);
      return label;
    }
    return 'global';
  }

  private pickTokenCount(source: unknown, paths: string[]): number {
    for (const tokenPath of paths) {
      const value = tokenPath.split('.').reduce<unknown>((obj, key) => {
        if (obj && typeof obj === 'object' && key in obj) {
          return (obj as Record<string, unknown>)[key];
        }
        return undefined;
      }, source);
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return Math.max(0, parsed);
        }
      }
    }
    return 0;
  }

  /**
   * Estimates cache-read and cache-write tokens via turn-over-turn context diffing. Used as a
   * fallback only - real cache counts ARE available from `debug-logs/{sessionId}/main.jsonl`
   * (see `attachRealCacheData()` below and wiki/providers/copilot.md, "Cache tokens: real data
   * exists"), but only for sessions started after the user opts into GitHub Copilot's own
   * `github.copilot.chat.agentDebugLog.fileLogging.enabled` setting (off by default). For
   * everyone else - the overwhelming majority of users, and every session predating that
   * setting - session logs carry no cache breakdown at all, so this heuristic is what fills the
   * gap. This is a calculated estimate, not measured data - every interaction it touches is
   * flagged via `cacheTokensEstimated`.
   *
   * Cache read: assumes the previous turn's full context (its total prompt tokens + its
   * output tokens) gets reused via prompt caching, so cacheRead = min(this turn's full
   * context, that baseline). Resets the baseline (no reuse assumed) whenever prompt tokens
   * don't grow or the model changes, since a shrink or model switch usually means compaction
   * or an unrelated request sharing the same session file, not genuine cache reuse.
   *
   * Cache write: the growth above the cache-read baseline (the "fresh delta") is attributed
   * to a new cache write rather than left as plain uncached input. This follows directly from
   * the cache-read assumption above - the next turn's cache-read estimate only makes sense if
   * this turn's new content actually got written to cache, so treating the two as symmetric is
   * the more internally consistent choice. This is a rougher estimate than cache-read: real
   * data can deviate (e.g. a large one-off tool result added without a cache breakpoint would
   * show as plain input in reality but gets counted as cache-write here), so accuracy on the
   * read/write split specifically should be treated as lower-confidence than the total
   * fresh-vs-cached split.
   *
   * Only runs on interactions where `hasRealPromptTokens[i]` is true - never stacks an
   * estimate on top of an already-estimated (text-based) input token count. Also skips any
   * interaction flagged in `hasRealCacheData` (real telemetry from `attachRealCacheData`),
   * even when its real cache-read count happens to be zero - a confirmed zero shouldn't be
   * overwritten by a guess. Real interactions (estimated or not) still update the running
   * baseline so later, telemetry-less turns in the same session can diff against them.
   *
   * `this.cacheEstimationConvention` controls how the estimate is written back:
   *  - 'inclusive' (default): inputTokens is left as the real reported total; cacheReadTokens
   *    and cacheWriteTokens become subsets of it. Matches costEstimation.ts's
   *    `inputTokens - cacheReadTokens - cacheWriteTokens` subtraction, so cost stays accurate.
   *  - 'exclusive': inputTokens is reduced to just whatever's left after cache read + write
   *    (often ~0); cacheReadTokens/cacheWriteTokens are additive on top. Matches Claude Code's
   *    native convention and the dashboard's Cache Efficiency widget (budgetManager.ts
   *    computeCacheMetrics), so that widget's hit-rate % is exact - but can understate cost
   *    when cache tokens exceed fresh tokens, since costEstimation.ts would then subtract twice.
   */
  private applyCacheHeuristic(interactions: Interaction[], hasRealPromptTokens: boolean[], hasRealCacheData?: boolean[]): void {
    if (!this.cacheEstimationEnabled) { return; }

    let prevFullContext: number | null = null;
    let prevModel: string | null = null;

    for (let i = 0; i < interactions.length; i++) {
      const interaction = interactions[i];
      const isReal = hasRealPromptTokens[i];
      const isRealCache = hasRealCacheData?.[i] ?? false;
      const fullContext = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;

      if (!isReal || isRealCache || interaction.cacheReadTokens > 0 || interaction.cacheWriteTokens > 0) {
        prevFullContext = isReal ? fullContext + interaction.outputTokens : null;
        prevModel = isReal ? interaction.model : null;
        continue;
      }

      if (prevFullContext !== null && prevModel === interaction.model && fullContext > prevFullContext) {
        const cacheRead = Math.min(fullContext, prevFullContext);
        const cacheWrite = fullContext - cacheRead;
        interaction.cacheReadTokens = cacheRead;
        interaction.cacheWriteTokens = cacheWrite;
        interaction.cacheTokensEstimated = true;
        if (this.cacheEstimationConvention === 'exclusive') {
          interaction.inputTokens = fullContext - cacheRead - cacheWrite;
          interaction.effectiveContextTokens = interaction.inputTokens + cacheRead + cacheWrite;
          interaction.totalTokens = interaction.inputTokens + interaction.outputTokens + interaction.thinkingTokens;
        }
      }

      prevFullContext = fullContext + interaction.outputTokens;
      prevModel = interaction.model;
    }
  }

  private addSessionFilesFromDir(files: Set<string>, dir: string): void {
    // No existsSync guard: readdirSync throws ENOENT for a missing directory and
    // the catch below already handles it, so the probe was a wasted syscall.
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) { continue; }
        if (!this.isSessionFilename(entry.name)) { continue; }
        files.add(path.join(dir, entry.name));
      }
    } catch {
      // Ignore inaccessible session directories.
    }
  }

  private addSessionFilesRecursively(files: Set<string>, dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.addSessionFilesRecursively(files, fullPath);
        } else if (entry.isFile() && this.isSessionFilename(entry.name)) {
          files.add(fullPath);
        }
      }
    } catch {
      // Ignore inaccessible session directories.
    }
  }

  private addCopilotCliSessionFiles(files: Set<string>, dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && this.isSessionFilename(entry.name)) {
          files.add(fullPath);
        } else if (entry.isDirectory()) {
          const eventsFile = path.join(fullPath, 'events.jsonl');
          if (fs.existsSync(eventsFile)) {
            files.add(eventsFile);
          }
        }
      }
    } catch {
      // Ignore inaccessible CLI directories.
    }
  }

  private isSessionFilename(filename: string): boolean {
    if (!filename.endsWith('.json') && !filename.endsWith('.jsonl')) { return false; }
    const lower = filename.toLowerCase();
    return !NON_SESSION_PATTERNS.some(pattern => lower.includes(pattern));
  }

  private isCopilotCliSessionPath(filePath: string): boolean {
    return filePath.replace(/\\/g, '/').includes('/.copilot/session-state/');
  }

  private isDeltaJsonl(lines: string[]): boolean {
    for (const line of lines.slice(0, 5)) {
      try {
        const event = JSON.parse(line);
        if (typeof event?.kind === 'number') { return true; }
      } catch {
        // Try the next line.
      }
    }
    return false;
  }

  private isJsonlContent(content: string): boolean {
    const lines = content.trim().split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) { return false; }
    return lines.slice(0, 2).every(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('{') && trimmed.endsWith('}');
    });
  }

  private applyDelta(state: Record<string, unknown>, delta: any): void {
    if (!delta || typeof delta !== 'object') { return; }
    if (delta.kind === 0 && delta.v && typeof delta.v === 'object') {
      Object.assign(state, delta.v);
      return;
    }
    if ((delta.kind !== 1 && delta.kind !== 2) || !Array.isArray(delta.k)) { return; }
    const pathParts = delta.k as Array<string | number>;
    if (pathParts.some(part => typeof part === 'string' && UNSAFE_PATH_KEYS.has(part))) { return; }

    let cursor: any = state;
    for (let index = 0; index < pathParts.length - 1; index++) {
      const key = pathParts[index];
      const nextKey = pathParts[index + 1];
      if (cursor[key] == null || typeof cursor[key] !== 'object') {
        cursor[key] = typeof nextKey === 'number' ? [] : {};
      }
      cursor = cursor[key];
    }

    const lastKey = pathParts[pathParts.length - 1];
    if (delta.kind === 2 && Array.isArray(cursor[lastKey])) {
      if (Array.isArray(delta.v)) {
        cursor[lastKey].push(...delta.v);
      } else {
        cursor[lastKey].push(delta.v);
      }
      return;
    }
    cursor[lastKey] = delta.v;
  }

  private getModelFromRequest(request: any, fallback: string): string {
    // A chat served by a non-Copilot model (Ollama, a llama.cpp server behind the
    // OpenAI-compatible endpoint, the user's own API key) keeps its `<vendor>/` prefix so
    // pricing can tell it apart - see modelHosting() in core/modelNames.ts. When the id
    // and the vendor are stored separately, put them back together.
    const rawVendor = request?.selectedModel?.metadata?.vendor;
    const vendor = typeof rawVendor === 'string' && rawVendor.trim() && !/^(github-)?copilot$/i.test(rawVendor.trim())
      ? rawVendor.trim().toLowerCase()
      : null;
    const withVendor = (model: string): string =>
      vendor && modelVendor(model) === null ? `${vendor}/${model}` : model;

    const candidates = [
      request?.modelId,
      request?.resolvedModel,
      request?.model,
      request?.selectedModel?.identifier,
      request?.selectedModel?.metadata?.id,
      request?.result?.metadata?.modelId,
      request?.result?.metadata?.resolvedModel,
      request?.response?.model,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        const normalized = this.normalizeModelId(candidate);
        if (normalized !== 'auto') { return withVendor(normalized); }
      }
    }
    // Never guess a Copilot model for a chat a different vendor served.
    if (vendor) { return `${vendor}/unknown`; }
    if (fallback.trim() && this.normalizeModelId(fallback) !== 'auto') { return this.normalizeModelId(fallback); }

    // For auto mode, extract the actual resolved model from toolCallRounds phaseModelId
    const rounds: any[] = request?.result?.metadata?.toolCallRounds;
    if (Array.isArray(rounds) && rounds.length > 0) {
      const counts = new Map<string, number>();
      for (const round of rounds) {
        const id = round?.phaseModelId;
        if (typeof id === 'string' && id) { counts.set(id, (counts.get(id) ?? 0) + 1); }
      }
      if (counts.size > 0) {
        const resolved = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return this.normalizeModelId(resolved);
      }
    }

    const details = String(request?.details || request?.result?.details || '').toLowerCase();
    if (details.includes('claude fable 5') || details.includes('claude-fable-5')) { return 'claude-fable-5'; }
    if (details.includes('claude opus 4.8') || details.includes('claude-opus-4.8')) { return 'claude-opus-4.8'; }
    if (details.includes('claude opus 4.7') || details.includes('claude-opus-4.7')) { return 'claude-opus-4.7'; }
    if (details.includes('claude opus 4.6') || details.includes('claude-opus-4.6')) { return 'claude-opus-4.6'; }
    if (details.includes('claude opus 4.5') || details.includes('claude-opus-4.5')) { return 'claude-opus-4.5'; }
    if (details.includes('claude sonnet 4.6') || details.includes('claude-sonnet-4.6')) { return 'claude-sonnet-4.6'; }
    if (details.includes('claude sonnet 4.5') || details.includes('claude-sonnet-4.5')) { return 'claude-sonnet-4.5'; }
    if (details.includes('claude haiku 4.5') || details.includes('claude-haiku-4.5')) { return 'claude-haiku-4.5'; }
    if (details.includes('claude-sonnet-4') || details.includes('claude sonnet 4')) { return 'claude-sonnet-4'; }
    if (details.includes('gemini 3.5 flash') || details.includes('gemini-3.5-flash')) { return 'gemini-3.5-flash'; }
    if (details.includes('gemini 3.1 pro') || details.includes('gemini-3.1-pro')) { return 'gemini-3.1-pro'; }
    if (details.includes('gemini 3 flash') || details.includes('gemini-3-flash')) { return 'gemini-3-flash'; }
    if (details.includes('gemini 2.5 pro') || details.includes('gemini-2.5-pro')) { return 'gemini-2.5-pro'; }
    if (details.includes('mai-code-1-flash') || details.includes('mai code 1 flash')) { return 'mai-code-1-flash'; }
    if (details.includes('gpt-5.5')) { return 'gpt-5.5'; }
    if (details.includes('gpt-5.4 mini') || details.includes('gpt-5.4-mini')) { return 'gpt-5.4-mini'; }
    if (details.includes('gpt-5.4 nano') || details.includes('gpt-5.4-nano')) { return 'gpt-5.4-nano'; }
    if (details.includes('gpt-5.4')) { return 'gpt-5.4'; }
    if (details.includes('gpt-5.3-codex') || details.includes('gpt-5.3 codex')) { return 'gpt-5.3-codex'; }
    if (details.includes('gpt-5.2-codex') || details.includes('gpt-5.2 codex')) { return 'gpt-5.2-codex'; }
    if (details.includes('gpt-5 mini') || details.includes('gpt-5-mini')) { return 'gpt-5-mini'; }
    if (details.includes('raptor mini') || details.includes('raptor-mini')) { return 'raptor-mini'; }
    if (details.includes('gpt-4.1')) { return 'gpt-4.1'; }

    return 'gpt-5-mini'; // Default fallback instead of 'auto' to ensure cost calculation works better
  }

  private normalizeModelId(model: string): string {
    return model.replace(/^copilot\//, '').replace(/^github-copilot\//, '').trim() || 'gpt-5-mini';
  }

  // renderedUserMessage / renderedGlobalContext are stored as [{type:1, text:"..."}, {type:3,...}]
  // type 1 = text block, type 3 = cache marker (no text)
  private extractRenderedText(value: unknown): string {
    if (typeof value === 'string') { return value; }
    if (Array.isArray(value)) {
      return value
        .filter((item): item is { type: number; text: string } => item?.type === 1 && typeof item?.text === 'string')
        .map(item => item.text)
        .join('\n');
    }
    return '';
  }

  private extractInputText(request: any): string {
    const parts: string[] = [];
    if (typeof request?.message === 'string') { parts.push(request.message); }
    if (typeof request?.message?.text === 'string') { parts.push(request.message.text); }
    if (Array.isArray(request?.message?.parts)) {
      for (const part of request.message.parts) {
        if (typeof part?.text === 'string') { parts.push(part.text); }
      }
    }
    for (const key of ['prompt', 'request']) {
      if (typeof request?.[key] === 'string') { parts.push(request[key]); }
    }
    return parts.join('\n');
  }

  private extractResponseText(response: any): string {
    if (typeof response === 'string') { return response; }
    if (response?.message && typeof response.message === 'string') { return response.message; }
    if (response?.text && typeof response.text === 'string') { return response.text; }
    const responses = Array.isArray(response) ? response : [];
    const parts: string[] = [];
    for (const item of responses) {
      if (item?.kind === 'thinking') { continue; }
      if (typeof item?.content?.value === 'string') { parts.push(item.content.value); }
      else if (typeof item?.value === 'string') { parts.push(item.value); }
      if (Array.isArray(item?.message?.parts)) {
        for (const part of item.message.parts) {
          if (typeof part?.text === 'string') { parts.push(part.text); }
        }
      }
    }
    return parts.join('\n');
  }

  private extractThinkingText(response: any): string {
    const responses = Array.isArray(response) ? response : [];
    return responses
      .filter(item => item?.kind === 'thinking' && typeof item.value === 'string')
      .map(item => item.value)
      .join('\n');
  }

  private getModeFromRequest(request: any): string {
    const command = request?.command || request?.slashCommand?.command || request?.slashCommand?.name;
    if (command === 'compact') { return 'compaction'; }
    return request?.modeInfo?.modeId || request?.mode || request?.type || 'chat';
  }

  private extractToolCalls(request: any): string[] {
    const tools = new Set<string>();
    const candidates = [
      request?.response?.toolCalls,
      request?.result?.toolCalls,
      request?.toolCalls,
    ];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) { continue; }
      for (const tool of candidate) {
        const name = tool?.name || tool?.function?.name || tool?.toolName;
        if (typeof name === 'string' && name) { tools.add(name); }
      }
    }
    if (Array.isArray(request?.response)) {
      for (const item of request.response) {
        const name = item?.name || item?.toolName || item?.toolSpecificData?.toolId;
        if (typeof name === 'string' && name) { tools.add(name); }
      }
    }
    return [...tools];
  }

  private extractToolRequests(toolRequests: unknown): string[] {
    if (!Array.isArray(toolRequests)) { return []; }
    return toolRequests
      .map((tool: any) => tool?.name || tool?.toolName || tool?.function?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }

  private parseTimestamp(value: unknown, fallback: Date): Date {
    if (typeof value === 'number' || typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return fallback;
  }

  private getFileFallbackDate(filePath: string): Date {
    const stats = this.statOf(filePath);
    if (!stats) { return new Date(0); }
    if (stats.birthtimeMs > 0 && stats.birthtimeMs < stats.mtimeMs) {
      return stats.birthtime;
    }
    return stats.mtime;
  }

  private resolveVSCodeUri(uri: string): string {
    // file:///home/user/project -> /home/user/project
    if (uri.startsWith('file:///')) {
      return decodeURIComponent(uri.slice(7));
    }
    // vscode-remote://wsl%2Bubuntu/home/user/project (WSL2 remote)
    const wslMatch = uri.match(/^vscode-remote:\/\/wsl[^/]*/i);
    if (wslMatch) {
      return decodeURIComponent(uri.slice(wslMatch[0].length));
    }
    return uri;
  }
}
