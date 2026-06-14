/**
 * Claude Code session log adapter.
 * Reads JSONL files from ~/.claude/projects/ containing per-message token data.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseProvider } from './base';
import { Session, Interaction } from '../types';
import { calculateCost } from '../core/costEstimation';

export class ClaudeCodeProvider extends BaseProvider {
  readonly id = 'claudeCode' as const;
  readonly displayName = 'Claude Code';
  private readonly projectsDir: string;
  private readonly extraDirs: string[];

  constructor(additionalPaths: string[] = []) {
    super();
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
    this.extraDirs = additionalPaths.map(p => p.replace(/^~/, os.homedir()));
  }

  getSessionDirectories(): string[] { return [this.projectsDir, ...this.extraDirs]; }

  async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const dir of this.getSessionDirectories()) {
      try {
        if (fs.existsSync(dir)) { this.walkDir(dir, files); }
      } catch { /* skip */ }
    }
    return files;
  }

  private walkDir(dir: string, files: string[], depth: number = 0): void {
    if (depth > 4) { return; }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDir(full, files, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(full);
        }
      }
    } catch { /* skip */ }
  }

  async parseSessionFile(filePath: string): Promise<Session | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0) { return null; }

      const interactions: Interaction[] = [];
      let startTime: Date | null = null;
      let endTime = new Date();
      let cwd: string | null = null;
      let title: string | undefined;
      const seenMessageIds = new Set<string>();
      let pendingUserPreview: string | undefined;
      const mcpServers = new Set<string>();
      let estimatedBaseContextTokens: number | undefined;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Extract ai-title before processing usage
          if (entry.type === 'ai-title' && entry.aiTitle) {
            title = entry.aiTitle;
            continue;
          }

          // Parse MCP server names from deferred tool list attachments
          if (entry.type === 'attachment') {
            const att = entry.attachment || {};
            if (att.type === 'deferred_tools_delta' && Array.isArray(att.addedNames)) {
              for (const name of att.addedNames as string[]) {
                if (name.startsWith('mcp__')) {
                  const parts = name.split('__');
                  if (parts.length >= 2) { mcpServers.add(parts[1]); }
                }
              }
            }
            continue;
          }

          // Detect compaction boundary events
          if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
            const ts = new Date(entry.timestamp || Date.now());
            if (!startTime) { startTime = ts; }
            endTime = ts;
            const meta = entry.compactMetadata || {};
            interactions.push({
              timestamp: ts, model: '', inputTokens: 0, outputTokens: 0,
              thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
              totalTokens: 0, effectiveContextTokens: 0, mode: 'compaction', toolCalls: [],
              isCompactionEvent: true,
              compactionTrigger: meta.trigger === 'manual' ? 'manual' : 'auto',
              preCompactionTokens: meta.preTokens,
              postCompactionTokens: meta.postTokens,
            });
            continue;
          }

          const ts = new Date(entry.timestamp || entry.createdAt || Date.now());
          if (!startTime) { startTime = ts; }
          endTime = ts;
          if (!cwd && entry.cwd) { cwd = entry.cwd; }

          // Capture user message text so we can attach it to the next assistant turn
          const entryRole = entry.role ?? entry.type ?? entry.message?.role;
          if (entryRole === 'user') {
            const content = entry.message?.content ?? entry.content ?? '';
            pendingUserPreview = this.extractTextPreview(content, 200);
          }

          // Claude Code provides actual token counts
          const usage = entry.usage || entry.message?.usage || entry.tokens || {};
          const inputTokens = usage.input_tokens || usage.input || usage.promptTokens || 0;
          const outputTokens = usage.output_tokens || usage.output || usage.completionTokens || 0;
          const cacheReadTokens = usage.cache_read_input_tokens || usage.cache_read || 0;
          const cacheWriteTokens = usage.cache_creation_input_tokens || usage.cache_write || 0;
          const thinkingTokens = usage.thinking_tokens || usage.thinking || 0;
          const model = entry.model || entry.message?.model || 'claude';
          const serverToolUse = usage.server_tool_use || {};
          const webSearchRequests: number = serverToolUse.web_search_requests || 0;
          const webFetchRequests: number = serverToolUse.web_fetch_requests || 0;

          if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && model === 'claude') { continue; }

          // Deduplicate: same message appears multiple times across conversation branches
          const msgId = entry.message?.id;
          if (msgId) {
            if (seenMessageIds.has(msgId)) { continue; }
            seenMessageIds.add(msgId);
          }

          // First cache-write in session ≈ static overhead (system prompt + CLAUDE.md + MCP schemas)
          if (estimatedBaseContextTokens === undefined && cacheWriteTokens > 0) {
            estimatedBaseContextTokens = cacheWriteTokens;
          }

          // Tool calls live in message.content as type:"tool_use" blocks
          const toolCalls: string[] = [];
          const commandRuns: string[] = [];
          const fileAccesses: Array<{ tool: string; path: string }> = [];
          const msgContent: unknown = entry.message?.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent as any[]) {
              if (block?.type === 'tool_use') {
                const name: string = block.name || 'unknown';
                toolCalls.push(name);
                if (name.toLowerCase() === 'bash' && typeof block.input?.command === 'string' && block.input.command.trim()) {
                  commandRuns.push(block.input.command.trim());
                }
                const fp: unknown = block.input?.file_path ?? block.input?.notebook_path;
                if (typeof fp === 'string' && fp) {
                  fileAccesses.push({ tool: name, path: fp });
                }
              }
            }
          }
          // Fallback for alternative formats
          if (toolCalls.length === 0) {
            for (const t of (entry.tool_calls || entry.toolCalls || [])) {
              toolCalls.push((t as any).name || (t as any).function?.name || 'unknown');
            }
          }

          const effectiveContextTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
          interactions.push({
            timestamp: ts,
            model: model,
            inputTokens, outputTokens,
            thinkingTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheWriteTokens,
            effectiveContextTokens,
            mode: entry.type || entry.role || entry.message?.role || 'chat',
            toolCalls,
            commandRuns: commandRuns.length > 0 ? commandRuns : undefined,
            fileAccesses: fileAccesses.length > 0 ? fileAccesses : undefined,
            promptPreview: pendingUserPreview,
            webSearchRequests: webSearchRequests > 0 ? webSearchRequests : undefined,
            webFetchRequests: webFetchRequests > 0 ? webFetchRequests : undefined,
          });
          pendingUserPreview = undefined; // consumed by first assistant turn after this user message
        } catch { /* skip line */ }
      }

      if (interactions.length === 0) { return null; }
      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const totalCacheReadTokens = interactions.reduce((s, i) => s + i.cacheReadTokens, 0);
      const totalCacheWriteTokens = interactions.reduce((s, i) => s + i.cacheWriteTokens, 0);
      const peakEffectiveContextTokens = interactions.reduce((m, i) => Math.max(m, i.effectiveContextTokens), 0);
      const primaryModel = interactions[interactions.length - 1]?.model || 'claude';
      const estimatedCostUsd = calculateCost(primaryModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens);

      return {
        id: path.basename(filePath, '.jsonl'),
        provider: 'claudeCode', providerName: 'Claude Code',
        startTime: startTime || new Date(), endTime, interactions,
        totalTokens: interactions.reduce((s, i) => s + i.totalTokens, 0),
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
        totalCacheReadTokens,
        totalCacheWriteTokens,
        models: [...new Set(interactions.map(i => i.model))],
        workspace: cwd || this.extractProject(filePath),
        sourceFile: filePath,
        title,
        estimatedCostUsd,
        activeMcpServers: mcpServers.size > 0 ? [...mcpServers] : undefined,
        estimatedBaseContextTokens,
        peakEffectiveContextTokens,
      };
    } catch { return null; }
  }

  private extractTextPreview(content: unknown, maxLen: number): string | undefined {
    // Strip system-injected XML blocks that Claude Code injects into user messages
    const stripSystemTags = (s: string): string =>
      s
        .replace(/<ide_opened_file[\s\S]*?<\/ide_opened_file>/g, '')
        .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
        .replace(/<user-prompt-submit-hook[\s\S]*?<\/user-prompt-submit-hook>/g, '')
        .replace(/<[a-z_]+>[\s\S]*?<\/antml:[a-z_]+>/g, '')
        .trim();

    if (typeof content === 'string') {
      const cleaned = stripSystemTags(content);
      return cleaned.substring(0, maxLen) || undefined;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((c: any) => c?.type === 'text' && typeof c?.text === 'string')
        .map((c: any) => stripSystemTags(c.text as string))
        .filter(s => s.length > 0)
        .join(' ')
        .trim();
      return text.substring(0, maxLen) || undefined;
    }
    return undefined;
  }

  private extractProject(filePath: string): string {
    const parts = filePath.split(path.sep);
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && projIdx + 1 < parts.length) {
      return parts[projIdx + 1];
    }
    return 'unknown';
  }
}
