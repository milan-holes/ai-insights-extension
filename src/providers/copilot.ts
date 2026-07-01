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
import { Session, Interaction } from '../types';
import { calculateCost } from '../core/costEstimation';

const COPILOT_EXTENSION_FOLDERS = [
  'GitHub.copilot-chat',
  'github.copilot-chat',
  'GitHub.copilot',
  'github.copilot',
];

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

export class CopilotProvider extends BaseProvider {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';

  private readonly sessionDirs: string[];
  private readonly inputTokenMultiplier: number;

  constructor(inputTokenMultiplier = 1.0) {
    super();
    this.inputTokenMultiplier = Math.max(0.1, inputTokenMultiplier);
    this.sessionDirs = this.buildSessionPaths();
  }

  private buildSessionPaths(): string[] {
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
        if (!fs.existsSync(dir)) { continue; }

        if (dir.includes('workspaceStorage')) {
          // Scan each workspace folder for chatSessions
          const workspaces = fs.readdirSync(dir, { withFileTypes: true });
          for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const workspaceRoot = path.join(dir, ws.name);
            const candidateDirs = [
              path.join(workspaceRoot, 'chatSessions'),
              ...COPILOT_EXTENSION_FOLDERS.flatMap(folder => [
                path.join(workspaceRoot, folder, 'chatSessions'),
                path.join(workspaceRoot, folder, 'debug-logs'),
              ]),
            ];
            for (const chatDir of candidateDirs) {
              this.addSessionFilesFromDir(files, chatDir);
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

  async parseSessionFile(filePath: string): Promise<Session | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      if (filePath.endsWith('.jsonl') || this.isJsonlContent(content)) {
        if (this.isCopilotCliSessionPath(filePath)) {
          return this.parseCopilotCliSession(filePath, content);
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
        });
      }

      if (interactions.length === 0) { return null; }

      const totalTokens = interactions.reduce((sum, i) => sum + i.totalTokens, 0);
      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const totalCacheWriteTokens = interactions.reduce((s, i) => s + i.cacheWriteTokens, 0);
      const estimatedCostUsd = interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0);

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
        estimatedCostUsd,
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
          });
        } catch {
          // Skip malformed lines
        }
      }

      if (interactions.length === 0) { return null; }

      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const totalCacheWriteTokens = interactions.reduce((s, i) => s + i.cacheWriteTokens, 0);
      const estimatedCostUsd = interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0);

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
        estimatedCostUsd,
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
      });
    }

    if (interactions.length === 0) { return null; }
    const estimatedCostUsd = interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0);

    const session = this.buildSession(filePath, path.basename(filePath, '.jsonl'), startTime, endTime, interactions);
    session.estimatedCostUsd = estimatedCostUsd;
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
      } catch {
        // Skip malformed lines.
      }
    }

    if (interactions.length === 0) { return null; }
    const estimatedCostUsd = interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0);

    const session = this.buildSession(filePath, sessionId, startTime || fallbackTimestamp, endTime, interactions);
    session.estimatedCostUsd = estimatedCostUsd;
    return session;
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
      try {
        const wsJson = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf-8'));
        const uri: string = wsJson.folder || wsJson.workspace;
        if (uri) { return this.resolveVSCodeUri(uri); }
      } catch { /* fall through */ }
      return parts[wsIdx + 1].substring(0, 8) + '...';
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

  private addSessionFilesFromDir(files: Set<string>, dir: string): void {
    try {
      if (!fs.existsSync(dir)) { return; }
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
      if (!fs.existsSync(dir)) { return; }
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
      if (!fs.existsSync(dir)) { return; }
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
    const candidates = [
      request?.modelId,
      request?.resolvedModel,
      request?.model,
      request?.selectedModel?.identifier,
      request?.selectedModel?.metadata?.id,
      request?.result?.metadata?.modelId,
      request?.result?.metadata?.resolvedModel,
      request?.response?.model,
      fallback,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        const normalized = this.normalizeModelId(candidate);
        if (normalized !== 'auto') { return normalized; }
      }
    }

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
    try {
      const stats = fs.statSync(filePath);
      if (stats.birthtimeMs > 0 && stats.birthtimeMs < stats.mtimeMs) {
        return stats.birthtime;
      }
      return stats.mtime;
    } catch {
      return new Date(0);
    }
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
