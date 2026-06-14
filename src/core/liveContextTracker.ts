import * as vscode from 'vscode';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { computeContextRotScore } from './contextRot';

const LIVE_THRESHOLD_MS = 3 * 60 * 1000;
const EXPIRE_AFTER_MS = 3 * 60 * 1000;
const DEBOUNCE_MS = 1500;
const CONTEXT_LIMIT_TOKENS = 200_000;

export interface LiveContextInfo {
  sessionTitle: string | undefined;
  /** inputTokens + cacheReadTokens for the most recent turn - approx context window usage */
  lastInputTokens: number;
  contextLimitTokens: number;
  contextPct: number;
  healthLabel: 'healthy' | 'warning' | 'stale';
  healthScore: number;
  turnsCount: number;
  totalSessionTokens: number;
  cacheEfficiencyPct: number;
  /** ms timestamp of the last update - used to sort sessions newest-first */
  lastUpdatedAt: number;
}

/**
 * Watches ~/.claude/projects/**\/*.jsonl via VS Code's file system watcher and
 * emits live context health info within ~1.5 s of each Claude Code turn completing.
 * Tracks all active sessions independently; fires onUpdate([]) when all have expired.
 */
export class LiveContextTracker implements vscode.Disposable {
  private readonly watchedDirs: string[];
  private readonly provider: ClaudeCodeProvider;
  private readonly onUpdate: (infos: LiveContextInfo[]) => void;
  private readonly activeSessions = new Map<string, LiveContextInfo>();
  private readonly expireTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(onUpdate: (infos: LiveContextInfo[]) => void, additionalPaths: string[] = []) {
    this.provider = new ClaudeCodeProvider(additionalPaths);
    this.watchedDirs = this.provider.getSessionDirectories();
    this.onUpdate = onUpdate;
  }

  start(subscriptions: vscode.Disposable[]): void {
    for (const dir of this.watchedDirs) {
      try {
        const base = vscode.Uri.file(dir);
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(base, '**/*.jsonl'),
        );
        watcher.onDidCreate(uri => this.schedule(uri.fsPath), null, subscriptions);
        watcher.onDidChange(uri => this.schedule(uri.fsPath), null, subscriptions);
        subscriptions.push(watcher);
      } catch {
        // Watcher unavailable for this dir - status bar falls back to the 30s polling timer.
      }
    }
  }

  /** Returns the most-recently-updated active session, or null if none. */
  getLatest(): LiveContextInfo | null {
    if (this.activeSessions.size === 0) { return null; }
    return [...this.activeSessions.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)[0];
  }

  dispose(): void {
    for (const t of this.expireTimers.values()) { clearTimeout(t); }
    this.expireTimers.clear();
    for (const t of this.debounceTimers.values()) { clearTimeout(t); }
    this.debounceTimers.clear();
  }

  private schedule(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }
    const t = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.process(filePath);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(filePath, t);
  }

  private async process(filePath: string): Promise<void> {
    try {
      const session = await this.provider.parseSessionFile(filePath);
      if (!session) { return; }

      const realInteractions = session.interactions.filter(i => !i.isCompactionEvent);
      if (realInteractions.length === 0) { return; }

      const last = realInteractions[realInteractions.length - 1];
      const lastTs = last.timestamp instanceof Date
        ? last.timestamp.getTime()
        : new Date(last.timestamp as unknown as string).getTime();

      if (Date.now() - lastTs > LIVE_THRESHOLD_MS) { return; }

      const score = computeContextRotScore(session);
      const lastInputTokens = last.inputTokens + last.cacheReadTokens;

      const info: LiveContextInfo = {
        sessionTitle: session.title,
        lastInputTokens,
        contextLimitTokens: CONTEXT_LIMIT_TOKENS,
        contextPct: Math.min(100, Math.round(lastInputTokens / CONTEXT_LIMIT_TOKENS * 100)),
        healthLabel: score.label,
        healthScore: score.score,
        turnsCount: score.turnsCount,
        totalSessionTokens: session.totalTokens,
        cacheEfficiencyPct: score.cacheEfficiencyRate,
        lastUpdatedAt: Date.now(),
      };
      this.activeSessions.set(filePath, info);
      this.onUpdate(this.sortedSessions());

      const existing = this.expireTimers.get(filePath);
      if (existing) { clearTimeout(existing); }
      const t = setTimeout(() => {
        this.activeSessions.delete(filePath);
        this.expireTimers.delete(filePath);
        this.onUpdate(this.sortedSessions());
      }, EXPIRE_AFTER_MS);
      this.expireTimers.set(filePath, t);
    } catch { /* ignore parse errors */ }
  }

  private sortedSessions(): LiveContextInfo[] {
    return [...this.activeSessions.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }
}
