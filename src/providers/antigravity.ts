/**
 * Antigravity (Google Gemini) session log adapter.
 * Reads conversation data from ~/.gemini/antigravity/conversations/ (.pb files)
 * and upgrades to accurate token data from brain/<id>/overview.txt when available.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseProvider } from './base';
import { Session, Interaction } from '../types';
import { calculateCost } from '../core/costEstimation';
import { extractContextRefs } from '../core/contextReferences';

interface AntigravityRoot { brainDir: string; conversationsDir: string; }

export class AntigravityProvider extends BaseProvider {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity';
  private readonly brainDir: string;
  private readonly conversationsDir: string;
  private readonly roots: AntigravityRoot[];

  constructor(additionalPaths: string[] = []) {
    super();
    this.brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    this.roots = [
      { brainDir: this.brainDir, conversationsDir: this.conversationsDir },
      ...additionalPaths.map(p => this.expandHome(p)).map(root => ({
        brainDir: path.join(root, 'brain'),
        conversationsDir: path.join(root, 'conversations'),
      })),
    ];
  }

  getSessionDirectories(): string[] { return this.roots.flatMap(r => [r.brainDir, r.conversationsDir]); }

  async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];

    for (const root of this.roots) {
      const seenIds = new Set<string>();

      // Primary source: conversations/*.pb (covers all sessions including old ones)
      try {
        if (fs.existsSync(root.conversationsDir)) {
          const entries = fs.readdirSync(root.conversationsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.name.endsWith('.pb')) { continue; }
            const id = entry.name.replace('.pb', '');
            seenIds.add(id);
            // Prefer overview.txt (accurate token data) when available
            const overviewPath = path.join(root.brainDir, id, '.system_generated', 'logs', 'overview.txt');
            files.push(fs.existsSync(overviewPath) ? overviewPath : path.join(root.conversationsDir, entry.name));
          }
        }
      } catch { /* skip */ }

      // Also pick up brain sessions that have no .pb counterpart
      try {
        if (fs.existsSync(root.brainDir)) {
          const dirs = fs.readdirSync(root.brainDir, { withFileTypes: true });
          for (const dir of dirs) {
            if (!dir.isDirectory() || seenIds.has(dir.name)) { continue; }
            const overviewPath = path.join(root.brainDir, dir.name, '.system_generated', 'logs', 'overview.txt');
            if (fs.existsSync(overviewPath)) { files.push(overviewPath); }
          }
        }
      } catch { /* skip */ }
    }

    return files;
  }

  async parseSessionFile(filePath: string): Promise<Session | null> {
    if (filePath.endsWith('.pb')) {
      return this.parsePbSession(filePath);
    }
    return this.parseOverviewSession(filePath);
  }

  // A .pb file always lives at <root>/conversations/<id>.pb, so its sibling brain root
  // (<root>/brain) can be derived from the file path itself - this keeps parsing correct
  // even when the file came from an additional (non-default) Antigravity root.
  private rootBrainDirFor(filePath: string): string {
    return path.join(path.dirname(path.dirname(filePath)), 'brain');
  }

  // Parse sessions where we only have a binary .pb file (older sessions without overview.txt).
  // Token counts are estimated from file size; dates come from brain metadata.json or file mtime.
  private parsePbSession(filePath: string): Session | null {
    try {
      const id = path.basename(filePath, '.pb');
      const stat = fs.statSync(filePath);
      const rootBrainDir = this.rootBrainDirFor(filePath);

      // Look for the earliest metadata.json updatedAt across brain artifacts
      let sessionTime: Date = stat.mtime;
      const brainDir = path.join(rootBrainDir, id);
      if (fs.existsSync(brainDir)) {
        try {
          const brainEntries = fs.readdirSync(brainDir);
          for (const entry of brainEntries) {
            if (!entry.endsWith('.metadata.json')) { continue; }
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(brainDir, entry), 'utf-8'));
              if (meta.updatedAt) {
                const d = new Date(meta.updatedAt);
                if (!isNaN(d.getTime()) && d < sessionTime) { sessionTime = d; }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      // Rough token estimate: protobuf conversation files average ~4 bytes per token
      const estimatedTokens = Math.max(100, Math.round(stat.size / 4));
      const estimatedInput = Math.round(estimatedTokens * 0.65);
      const estimatedOutput = Math.round(estimatedTokens * 0.35);

      const interaction: Interaction = {
        timestamp: sessionTime,
        model: 'gemini',
        inputTokens: estimatedInput,
        outputTokens: estimatedOutput,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: estimatedTokens,
        effectiveContextTokens: estimatedInput,
        mode: 'chat',
        toolCalls: [],
      };

      return {
        id,
        provider: 'antigravity',
        providerName: 'Antigravity',
        startTime: sessionTime,
        endTime: sessionTime,
        interactions: [interaction],
        totalTokens: estimatedTokens,
        totalInputTokens: estimatedInput,
        totalOutputTokens: estimatedOutput,
        totalThinkingTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        models: ['gemini'],
        workspace: this.extractWorkspaceFromBrain(rootBrainDir, id) || id.substring(0, 8),
        sourceFile: filePath,
        title: this.extractTitleFromBrain(rootBrainDir, id),
        estimatedCostUsd: calculateCost('gemini', estimatedInput, estimatedOutput, 0, 0),
      };
    } catch { return null; }
  }

  private extractWorkspaceFromBrain(brainDir: string, id: string): string | null {
    try {
      const taskPath = path.join(brainDir, id, 'task.md');
      if (!fs.existsSync(taskPath)) { return null; }
      const content = fs.readFileSync(taskPath, 'utf-8');
      const match = content.match(/Active Document:\s*(\/[^\s(]+)/);
      if (!match) { return null; }
      let dir = path.dirname(match[1]);
      const markers = ['.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
      while (dir !== '/' && dir !== os.homedir()) {
        if (markers.some(m => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } })) {
          return dir;
        }
        dir = path.dirname(dir);
      }
    } catch { /* skip */ }
    return null;
  }

  private extractTitleFromBrain(brainDir: string, id: string): string | undefined {
    try {
      const metaFiles = ['task.md.metadata.json', 'walkthrough.md.metadata.json'];
      for (const mf of metaFiles) {
        const p = path.join(brainDir, id, mf);
        if (!fs.existsSync(p)) { continue; }
        const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (meta.summary) { return String(meta.summary).substring(0, 80); }
      }
    } catch { /* skip */ }
    return undefined;
  }

  private parseOverviewSession(filePath: string): Session | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.trim()) { return null; }
      const convDir = path.resolve(filePath, '..', '..', '..');
      const convId = path.basename(convDir);
      const { interactions, startTime, endTime, title } = this.parseOverview(content, filePath);
      if (interactions.length === 0) { return null; }
      const totalTokens = interactions.reduce((s, i) => s + i.totalTokens, 0);
      const totalInputTokens = interactions.reduce((s, i) => s + i.inputTokens, 0);
      const totalOutputTokens = interactions.reduce((s, i) => s + i.outputTokens, 0);
      const primaryModel = interactions[interactions.length - 1]?.model || 'gemini-3.1-pro';
      const estimatedCostUsd = calculateCost(primaryModel, totalInputTokens, totalOutputTokens, 0, 0);

      return {
        id: convId, provider: 'antigravity', providerName: 'Antigravity',
        startTime, endTime,
        interactions, totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens: interactions.reduce((s, i) => s + i.thinkingTokens, 0),
        totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
        models: [...new Set(interactions.map(i => i.model))],
        workspace: this.extractWorkspaceFromOverview(content) || convId.substring(0, 8) + '...',
        sourceFile: filePath,
        title,
        estimatedCostUsd,
      };
    } catch { return null; }
  }

  private extractWorkspaceFromOverview(content: string): string | null {
    for (const line of content.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
          const match = entry.content.match(/Active Document:\s*(\/[^\s(]+)/);
          if (!match) { continue; }
          let dir = path.dirname(match[1]);
          const markers = ['.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
          while (dir !== '/' && dir !== os.homedir()) {
            if (markers.some(m => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } })) {
              return dir;
            }
            dir = path.dirname(dir);
          }
          return path.dirname(match[1]);
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  }

  private parseOverview(content: string, filePath: string): {
    interactions: Interaction[];
    startTime: Date;
    endTime: Date;
    title: string | undefined;
  } {
    const interactions: Interaction[] = [];
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    let title: string | undefined;
    let totalTokensEstimate = 0;
    let pendingUserContent: string | undefined;

    for (const line of content.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const entry = JSON.parse(line);
        const ts = entry.created_at ? new Date(entry.created_at) : null;
        if (ts && !isNaN(ts.getTime())) {
          if (!startTime) { startTime = ts; }
          endTime = ts;
        }
        if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
          const raw = entry.content.replace(/<[^>]+>/g, '').trim();
          pendingUserContent = raw;
          if (!title) {
            const firstLine = raw.split('\n').find((l: string) => l.trim().length > 5);
            if (firstLine) { title = firstLine.trim().substring(0, 80); }
          }
        }
        if (typeof entry.input_tokens === 'number' || typeof entry.output_tokens === 'number') {
          const inputTokens = entry.input_tokens || 0;
          const outputTokens = entry.output_tokens || 0;
          interactions.push({
            timestamp: ts || new Date(),
            model: entry.model || 'gemini',
            inputTokens, outputTokens,
            thinkingTokens: entry.thinking_tokens || 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            totalTokens: inputTokens + outputTokens,
            effectiveContextTokens: inputTokens,
            mode: 'chat', toolCalls: [],
            contextRefs: extractContextRefs(pendingUserContent),
          });
          pendingUserContent = undefined;
        } else {
          totalTokensEstimate += this.estimateTokens(JSON.stringify(entry), 0.24);
        }
      } catch { /* skip malformed lines */ }
    }

    if (interactions.length === 0) {
      const fileStat = (() => { try { return fs.statSync(filePath); } catch { return null; } })();
      const fallbackEnd = fileStat?.mtime || new Date();
      // Prefer the real timestamp span seen above (from entry.created_at) over the file's
      // mtime alone - without this, every synthetic turn below gets the exact same
      // timestamp, so a multi-day session gets all of its tokens counted on a single day.
      const spanStart = startTime || fallbackEnd;
      const spanEnd = endTime || fallbackEnd;
      const totalEst = totalTokensEstimate || this.estimateTokens(content, 0.24);
      if (totalEst >= 10) {
        const turnCount = Math.max(1, (content.match(/(?:^|\n)(?:USER|User|user|MODEL|model|Assistant)[:>]/gim) || []).length / 2);
        const tokensPerTurn = Math.round(totalEst / turnCount);
        const spanMs = spanEnd.getTime() - spanStart.getTime();
        for (let i = 0; i < turnCount; i++) {
          const frac = turnCount > 1 ? i / (turnCount - 1) : 0;
          const timestamp = spanMs > 0 ? new Date(spanStart.getTime() + frac * spanMs) : fallbackEnd;
          interactions.push({
            timestamp, model: 'gemini',
            inputTokens: Math.round(tokensPerTurn * 0.3),
            outputTokens: Math.round(tokensPerTurn * 0.7),
            thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
            totalTokens: tokensPerTurn,
            effectiveContextTokens: Math.round(tokensPerTurn * 0.3),
            mode: 'chat', toolCalls: [],
          });
        }
      }
    }

    const fileStat = (() => { try { return fs.statSync(filePath); } catch { return null; } })();
    const fallbackTime = fileStat?.mtime || new Date();
    return {
      interactions,
      startTime: startTime || fallbackTime,
      endTime: endTime || fallbackTime,
      title,
    };
  }
}
