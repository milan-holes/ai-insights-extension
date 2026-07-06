/**
 * Codex session log adapter.
 * Reads JSONL rollout files from ~/.codex/sessions/.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseProvider } from './base';
import { Session, Interaction } from '../types';
import { calculateCost } from '../core/costEstimation';
import { extractContextRefs } from '../core/contextReferences';

type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

export class CodexProvider extends BaseProvider {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  private readonly sessionsDir: string;
  private readonly indexFile: string;
  private readonly extraDirs: string[];

  constructor(additionalPaths: string[] = []) {
    super();
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.sessionsDir = path.join(codexHome, 'sessions');
    this.indexFile = path.join(codexHome, 'session_index.jsonl');
    this.extraDirs = additionalPaths.map(p => this.expandHome(p));
  }

  getSessionDirectories(): string[] { return [this.sessionsDir, this.indexFile, ...this.extraDirs]; }

  async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const dir of [this.sessionsDir, ...this.extraDirs]) {
      try {
        if (fs.existsSync(dir)) { this.walkDir(dir, files); }
      } catch { /* skip */ }
    }
    return files;
  }

  private walkDir(dir: string, files: string[], depth: number = 0): void {
    if (depth > 5) { return; }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDir(full, files, depth + 1);
        } else if (entry.name.endsWith('.jsonl') && entry.name.startsWith('rollout-')) {
          files.push(full);
        }
      }
    } catch { /* skip */ }
  }

  async parseSessionFile(filePath: string): Promise<Session | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) { return null; }

      const interactions: Interaction[] = [];
      const fallbackTimestamp = this.getFileFallbackDate(filePath);
      let startTime = fallbackTimestamp;
      let endTime = fallbackTimestamp;
      let id = path.basename(filePath, '.jsonl');
      let workspace = 'unknown';
      let model = 'codex';
      let title: string | undefined;
      let pendingToolCalls: string[] = [];
      let pendingCommandRuns: string[] = [];
      let pendingFileAccesses: Array<{ tool: string; path: string }> = [];
      let pendingUserTexts: string[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const timestamp = this.parseTimestamp(entry.timestamp, fallbackTimestamp);
          if (timestamp < startTime) { startTime = timestamp; }
          if (timestamp > endTime) { endTime = timestamp; }

          if (entry.type === 'session_meta') {
            id = entry.payload?.id || id;
            workspace = entry.payload?.cwd || workspace;
            model = entry.payload?.model || entry.payload?.model_slug || model;
            // Extract title from common session meta fields
            title = entry.payload?.task || entry.payload?.title || entry.payload?.name || entry.payload?.prompt || title;
            continue;
          }

          // Capture title from the dedicated user_message event only.
          // response_item entries with role='user' contain injected context
          // (environment_context, permissions) and must not be used as the title.
          if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && entry.payload?.message) {
            let msg = String(entry.payload.message);
            // VS Code extension injects IDE context before the real request; extract it when present
            const requestMatch = msg.match(/##\s*My request for Codex:\s*\n([\s\S]+)/i);
            if (requestMatch) { msg = requestMatch[1]; }
            pendingUserTexts.push(msg);
            if (!title) {
              title = msg.trim().slice(0, 80).replace(/[\n\r]+/g, ' ');
            }
          }

          const payloadType = entry.payload?.type;
          if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
            const name = String(entry.payload.name || 'unknown');
            pendingToolCalls.push(name);
            this.extractCodexFunctionDetails(name, entry.payload.arguments, pendingCommandRuns, pendingFileAccesses);
            continue;
          }

          if (entry.type === 'event_msg' && payloadType === 'exec_command_end') {
            if (pendingToolCalls[pendingToolCalls.length - 1] !== 'exec_command') {
              pendingToolCalls.push('exec_command');
            }
            const cmd = this.extractExecutedCommand(entry.payload);
            if (cmd && pendingCommandRuns[pendingCommandRuns.length - 1] !== cmd) {
              pendingCommandRuns.push(cmd);
            }
            for (const fa of this.extractParsedCommandFiles(entry.payload)) {
              pendingFileAccesses.push(fa);
            }
            continue;
          }

          if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') {
            continue;
          }

          const usage = entry.payload?.info?.last_token_usage as TokenUsage | undefined;
          if (!usage) { continue; }

          const inputTokens = this.toTokenCount(usage.input_tokens);
          const outputTokens = this.toTokenCount(usage.output_tokens);
          const thinkingTokens = this.toTokenCount(usage.reasoning_output_tokens);
          const cacheReadTokens = this.toTokenCount(usage.cached_input_tokens);
          const totalTokens = this.toTokenCount(usage.total_tokens) || inputTokens + outputTokens + thinkingTokens;
          if (totalTokens === 0) { continue; }

          interactions.push({
            timestamp,
            model,
            inputTokens,
            outputTokens,
            thinkingTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
            totalTokens,
            effectiveContextTokens: inputTokens + cacheReadTokens,
            mode: 'agent',
            toolCalls: pendingToolCalls,
            commandRuns: pendingCommandRuns.length > 0 ? pendingCommandRuns : undefined,
            fileAccesses: pendingFileAccesses.length > 0 ? pendingFileAccesses : undefined,
            contextRefs: extractContextRefs(pendingUserTexts.join('\n')),
          });
          pendingToolCalls = [];
          pendingCommandRuns = [];
          pendingFileAccesses = [];
          pendingUserTexts = [];
        } catch { /* skip malformed lines */ }
      }

      if (interactions.length === 0) { return null; }
      interactions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const totalTokens = interactions.reduce((s, i) => s + i.totalTokens, 0);

      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const primaryModel = interactions[interactions.length - 1]?.model || 'gpt-5.3-codex';
      const estimatedCostUsd = calculateCost(primaryModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, 0);

      return {
        id,
        provider: 'codex',
        providerName: 'Codex',
        startTime: interactions[0].timestamp,
        endTime: interactions[interactions.length - 1].timestamp,
        interactions,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
        totalCacheReadTokens,
        totalCacheWriteTokens: 0,
        models: [...new Set(interactions.map(i => i.model))],
        workspace,
        sourceFile: filePath,
        title,
        estimatedCostUsd,
      };
    } catch { return null; }
  }

  private toTokenCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private parseTimestamp(value: unknown, fallback: Date): Date {
    if (typeof value === 'number' || typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) { return parsed; }
    }
    return fallback;
  }

  private getFileFallbackDate(filePath: string): Date {
    try {
      return fs.statSync(filePath).mtime;
    } catch {
      return new Date(0);
    }
  }

  private extractCodexFunctionDetails(
    toolName: string,
    rawArgs: unknown,
    commandRuns: string[],
    fileAccesses: Array<{ tool: string; path: string }>,
  ): void {
    let args: any = rawArgs;
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs); } catch { args = {}; }
    }
    if (!args || typeof args !== 'object') { return; }

    const lowerName = toolName.toLowerCase();
    if (lowerName === 'exec_command' && typeof args.cmd === 'string' && args.cmd.trim()) {
      commandRuns.push(args.cmd.trim());
    }

    const pathValue = args.path ?? args.file_path ?? args.ref_id;
    if (typeof pathValue === 'string' && pathValue.startsWith('/')) {
      const action = lowerName.includes('apply_patch') || lowerName.includes('write') || lowerName.includes('edit')
        ? 'edit'
        : 'read';
      fileAccesses.push({ tool: action, path: pathValue });
    }
  }

  private extractExecutedCommand(payload: any): string | null {
    if (Array.isArray(payload?.command) && payload.command.length > 0) {
      const command = payload.command;
      if (command.length >= 3 && command[1] === '-lc' && typeof command[2] === 'string') {
        return command[2];
      }
      return command.map((part: unknown) => String(part)).join(' ');
    }
    return null;
  }

  private extractParsedCommandFiles(payload: any): Array<{ tool: string; path: string }> {
    const result: Array<{ tool: string; path: string }> = [];
    const parsed = Array.isArray(payload?.parsed_cmd) ? payload.parsed_cmd : [];
    for (const cmd of parsed) {
      const pathValue = cmd?.path;
      if (typeof pathValue !== 'string' || !pathValue) { continue; }
      const type = String(cmd?.type || '').toLowerCase();
      const tool = type.includes('write') || type.includes('edit') || type.includes('patch') ? 'edit' : 'read';
      result.push({ tool, path: pathValue });
    }
    return result;
  }
}
