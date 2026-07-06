/**
 * GitHub Copilot for JetBrains IDE session log adapter.
 *
 * Reads JSONL partition files written by the GitHub Copilot plugin for
 * JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, …).
 *
 * File location (all platforms):
 *   ~/.copilot/jb/{conversationId}/partition-{n}.jsonl
 *
 * WSL2 support: when JetBrains runs on Windows the files live at
 *   C:\Users\<name>\.copilot\jb\  →  /mnt/c/Users/<name>/.copilot/jb/
 * All Windows user home directories under /mnt/c/Users are probed.
 *
 * Each partition is an append-only JSONL stream. Event types:
 *   partition.created       - session header, carries conversationId + source
 *   user.message            - raw user input (data.content, data.turnId)
 *   user.message_rendered   - full rendered prompt incl. injected file context
 *                             (data.renderedMessage, data.turnId)
 *   assistant.turn_start    - assistant starts responding (data.model optional)
 *   assistant.message       - streamed chunk (data.text, data.thinking.text)
 *   tool.execution_start    - agent-mode tool call (data.toolName, data.toolCallId)
 *   tool.execution_complete - tool result (data.result.result[])
 *   assistant.turn_end      - turn finished
 *
 * Token counts are ESTIMATED (~0.25 tokens/char) - JetBrains Copilot does not
 * expose actual API token counts.
 *
 * Model detection (best-effort):
 *   1. assistant.turn_start.data.model (not present in all builds)
 *   2. toolCallId prefix: toulu_* → claude, call_* → gpt
 *   3. Fallback: 'copilot'
 *
 * Mode: any tool.execution_start event in a partition ⇒ agent; otherwise ask.
 *
 * Schema reference:
 *   .others/ai-engineering-fluency/docs/logFilesSchema/jetbrains-session-schema.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseProvider } from './base';
import { calculateCost } from '../core/costEstimation';
import { Session, Interaction } from '../types';
import { extractContextRefs } from '../core/contextReferences';

export class JetBrainsAIProvider extends BaseProvider {
  readonly id = 'jetbrainsAI' as const;
  readonly displayName = 'Copilot (JetBrains)';

  private readonly sessionRoots: string[];

  constructor(additionalPaths: string[] = []) {
    super();
    this.sessionRoots = this.buildSessionRoots(additionalPaths);
  }

  /**
   * Build the list of candidate ~/.copilot/jb roots to scan.
   * On Linux we probe the native home dir and, when running under WSL2,
   * also every Windows user home accessible at /mnt/c/Users/<name>/.
   */
  private buildSessionRoots(additionalPaths: string[]): string[] {
    const roots = new Set<string>();
    roots.add(path.join(os.homedir(), '.copilot', 'jb'));

    // WSL2: JetBrains runs on Windows → files are under the mounted drive
    if (os.platform() === 'linux' && this.isWSL2()) {
      for (const winHome of this.wslWindowsUserDirs()) {
        roots.add(path.join(winHome, '.copilot', 'jb'));
      }
    }

    for (const p of additionalPaths) { roots.add(this.expandHome(p)); }

    return [...roots];
  }

  private isWSL2(): boolean {
    try {
      return fs.readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
    } catch { return false; }
  }

  private wslWindowsUserDirs(): string[] {
    const dirs: string[] = [];
    const usersDir = '/mnt/c/Users';
    if (!fs.existsSync(usersDir)) { return dirs; }
    try {
      for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) { continue; }
        if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) { continue; }
        if (entry.name.startsWith('.')) { continue; }
        dirs.push(path.join(usersDir, entry.name));
      }
    } catch { /* skip */ }
    return dirs;
  }

  getSessionDirectories(): string[] { return this.sessionRoots; }

  async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];

    for (const sessionRoot of this.sessionRoots) {
      if (!fs.existsSync(sessionRoot)) { continue; }
      try {
        for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) { continue; }
          const convDir = path.join(sessionRoot, entry.name);
          try {
            for (const pEntry of fs.readdirSync(convDir, { withFileTypes: true })) {
              if (!pEntry.isFile() || !/^partition-\d+\.jsonl$/.test(pEntry.name)) { continue; }
              const fullPath = path.join(convDir, pEntry.name);
              try {
                if (fs.statSync(fullPath).size > 0) { files.push(fullPath); }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return files;
  }

  async parseSessionFile(filePath: string): Promise<Session | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.parsePartition(filePath, content);
    } catch { return null; }
  }

  private parsePartition(filePath: string, content: string): Session | null {
    const rawLines = content.split(/\r?\n/);

    // Pre-scan: collect turnIds that have a rendered version so we don't
    // double-count the same turn from both user.message and user.message_rendered.
    const renderedTurnIds = new Set<string>();
    const events: any[] = [];
    for (const line of rawLines) {
      if (!line.trim()) { continue; }
      try {
        const ev = JSON.parse(line);
        if (!ev || typeof ev !== 'object') { continue; }
        events.push(ev);
        if (ev.type === 'user.message_rendered' && typeof ev.data?.turnId === 'string') {
          renderedTurnIds.add(ev.data.turnId);
        }
      } catch { /* skip malformed */ }
    }
    if (events.length === 0) { return null; }

    // ── per-session state ────────────────────────────────────────────────────
    let conversationId: string | null = null;
    let firstUserTs: Date | null = null;
    let lastTs: Date | null = null;
    let sawToolCall = false;
    let modelFromTurnStart: string | null = null;
    let modelFromToolCallId: string | null = null;
    let sessionTitle: string | undefined;
    let detectedWorkspace: string | null = null;

    // ── per-turn accumulator ─────────────────────────────────────────────────
    let pendingInputText = '';
    let pendingTs: Date | null = null;
    let inTurn = false;
    let currentOutputText = '';
    let currentThinkingText = '';
    let currentToolCalls: string[] = [];
    let currentModel: string | null = null;

    const interactions: Interaction[] = [];

    const flushTurn = () => {
      if (!inTurn && !pendingInputText) { return; }
      const inputTokens = this.estimateTokens(pendingInputText, 0.25);
      const outputTokens = this.estimateTokens(currentOutputText, 0.25);
      const thinkingTokens = this.estimateTokens(currentThinkingText, 0.25);
      const model = currentModel || modelFromTurnStart || modelFromToolCallId || 'copilot';
      interactions.push({
        timestamp: pendingTs || new Date(),
        model,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens + thinkingTokens,
        effectiveContextTokens: inputTokens,
        mode: sawToolCall ? 'agent' : 'ask',
        toolCalls: [...currentToolCalls],
        promptPreview: pendingInputText.substring(0, 200) || undefined,
        contextRefs: extractContextRefs(pendingInputText),
      });
      pendingInputText = '';
      currentOutputText = '';
      currentThinkingText = '';
      currentToolCalls = [];
      currentModel = null;
      inTurn = false;
    };

    for (const ev of events) {
      const evTs = typeof ev.timestamp === 'string' ? new Date(ev.timestamp) : null;
      if (evTs && (!lastTs || evTs > lastTs)) { lastTs = evTs; }

      switch (ev.type) {
        case 'partition.created':
          if (ev.data?.conversationId) { conversationId = String(ev.data.conversationId); }
          break;

        case 'user.message': {
          flushTurn();
          if (evTs && !firstUserTs) { firstUserTs = evTs; }
          pendingTs = evTs;
          const turnId = ev.data?.turnId;
          const rawContent = ev.data?.content;
          // Use raw content only when no rendered version covers this turnId
          if (typeof rawContent === 'string' &&
              (typeof turnId !== 'string' || !renderedTurnIds.has(turnId))) {
            pendingInputText = rawContent;
          }
          // Bare user.message gives the cleanest title (no injected context)
          if (!sessionTitle && typeof rawContent === 'string' && rawContent.trim()) {
            sessionTitle = rawContent.trim().substring(0, 80);
          }
          break;
        }

        case 'user.message_rendered': {
          const rendered = ev.data?.renderedMessage;
          if (typeof rendered === 'string') {
            pendingInputText = rendered;
            // Set timestamps when session starts directly with a rendered message
            if (evTs && !firstUserTs) { firstUserTs = evTs; }
            if (!pendingTs) { pendingTs = evTs; }
            // Derive title from rendered message only when no bare message set it yet
            if (!sessionTitle) {
              sessionTitle = extractTitleFromRendered(rendered);
            }
          }
          break;
        }

        case 'assistant.turn_start':
          inTurn = true;
          if (typeof ev.data?.model === 'string' && ev.data.model) {
            if (!modelFromTurnStart) { modelFromTurnStart = ev.data.model; }
            currentModel = ev.data.model;
          }
          break;

        case 'assistant.message':
          if (typeof ev.data?.text === 'string') { currentOutputText += ev.data.text; }
          if (typeof ev.data?.thinking?.text === 'string') { currentThinkingText += ev.data.thinking.text; }
          break;

        case 'tool.execution_start':
          sawToolCall = true;
          if (!modelFromToolCallId) {
            const hint = modelHintFromToolCallId(ev.data?.toolCallId);
            if (hint) { modelFromToolCallId = hint; }
          }
          currentToolCalls.push(typeof ev.data?.toolName === 'string' ? ev.data.toolName : 'unknown');
          if (!detectedWorkspace) {
            detectedWorkspace = extractWorkspaceFromArgs(ev.data?.arguments);
          }
          break;

        case 'tool.execution_complete': {
          const blocks = ev.data?.result?.result;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && typeof b.value === 'string') { currentOutputText += b.value; }
            }
          }
          break;
        }

        case 'assistant.turn_end':
          flushTurn();
          break;
      }
    }
    flushTurn(); // trailing turn without an explicit turn_end

    if (interactions.length === 0) { return null; }

    const convDir = path.basename(path.dirname(filePath));
    const partition = path.basename(filePath, '.jsonl');
    const allModels = [...new Set(interactions.map(i => i.model).filter(m => m !== 'copilot'))];

    return {
      id: `jb-${convDir}-${partition}`,
      provider: 'jetbrainsAI',
      providerName: 'Copilot (JetBrains)',
      startTime: firstUserTs || new Date(),
      endTime: lastTs || firstUserTs || new Date(),
      interactions,
      totalTokens: interactions.reduce((s, i) => s + i.totalTokens, 0),
      totalInputTokens: interactions.reduce((s, i) => s + i.inputTokens, 0),
      totalOutputTokens: interactions.reduce((s, i) => s + i.outputTokens, 0),
      totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      models: allModels.length > 0 ? allModels : [modelFromTurnStart || modelFromToolCallId || 'copilot'],
      workspace: detectedWorkspace || conversationId || convDir,
      sourceFile: filePath,
      title: sessionTitle,
      estimatedCostUsd: interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, 0, 0), 0),
      peakEffectiveContextTokens: interactions.reduce((m, i) => Math.max(m, i.effectiveContextTokens), 0),
    };
  }
}

/**
 * Extract a short title from a rendered message.
 * Rendered messages can contain pseudo-XML tags injected by Copilot
 * (<context>, <reminderInstructions>, <userRequest>…</userRequest>).
 * We prefer the <userRequest> content; otherwise strip all tags and take
 * the first 80 characters.
 */
function extractTitleFromRendered(rendered: string): string | undefined {
  // Try <userRequest>...</userRequest> first — that's the clean user text
  const reqMatch = rendered.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
  if (reqMatch) {
    const text = reqMatch[1].trim();
    if (text) { return text.substring(0, 80); }
  }
  // Strip all XML-ish tags and collapse whitespace
  const stripped = rendered.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+>/g, '').trim();
  return stripped ? stripped.substring(0, 80) : undefined;
}

/**
 * Extract a human-readable workspace name from tool call arguments.
 * Handles both Unix paths (/home/user/dev/proj/file.ts) and
 * Windows UNC paths (\\wsl.localhost\Ubuntu\home\user\dev\proj\file.ts).
 */
function extractWorkspaceFromArgs(args: any): string | null {
  if (!args || typeof args !== 'object') { return null; }
  const rawPath: unknown = args.filePath ?? args.path ?? args.file_path;
  if (typeof rawPath !== 'string' || !rawPath) { return null; }

  // Normalise Windows UNC WSL path to Unix: \\wsl.localhost\Distro\home\... → /home/...
  let normalised = rawPath.replace(/\\\\/g, '/').replace(/^\/wsl\.localhost\/[^/]+/, '');
  // Also strip a leading single backslash that might remain
  normalised = normalised.replace(/^\\/, '');

  const parts = normalised.replace(/\\/g, '/').split('/').filter(Boolean);
  // We want the directory one level above the filename, e.g.
  //   /home/twd/dev/english-tutor/package.json → parts[-2] = 'english-tutor'
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return null;
}

function modelHintFromToolCallId(id: string | undefined): string | null {
  if (!id || typeof id !== 'string') { return null; }
  if (id.startsWith('toolu_')) { return 'claude'; } // Anthropic (toolu_bdrk_* = Bedrock)
  if (id.startsWith('call_')) { return 'gpt'; }      // OpenAI
  return null;
}
