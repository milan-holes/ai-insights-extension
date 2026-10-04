import * as fs from 'fs';
import { aggregateSessions } from '../core/sessionAggregator';
import { CacheManager } from '../core/cacheManager';
import { computeInsights, Insight } from '../core/insightsEngine';
import { SessionSnapshotStore } from '../core/sessionSnapshotStore';
import { CopilotProvider } from '../providers/copilot';
import { AntigravityProvider } from '../providers/antigravity';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import { JetBrainsAIProvider } from '../providers/jetbrainsAI';
import { VisualStudioProvider } from '../providers/visualStudio';
import { BaseProvider } from '../providers/base';
import { AggregatedMetrics, ProviderId, Session } from '../types';
import {
  aggregationConfig,
  loadStandaloneConfig,
  saveStandaloneConfig,
  StandaloneConfig,
  STANDALONE_PROVIDER_IDS,
} from './config';

export interface ProviderDiagnostic {
  id: ProviderId;
  displayName: string;
  enabled: boolean;
  sessionFilesFound: number;
  sessionDirs: string[];
  lastError?: string;
}

export interface StandaloneRefreshResult {
  generatedAt: string;
  config: StandaloneConfig;
  sessions: Session[];
  metrics: AggregatedMetrics;
  insights: Insight[];
  providers: ProviderDiagnostic[];
  storageDir: string;
}

const PARSE_YIELD_EVERY = 20;

export class StandaloneInsightsService {
  private config: StandaloneConfig;
  private readonly cacheManager = new CacheManager();
  private snapshotStore: SessionSnapshotStore;

  constructor(private readonly storageDir: string) {
    this.config = loadStandaloneConfig(storageDir);
    this.cacheManager.load(storageDir);
    this.snapshotStore = new SessionSnapshotStore(storageDir, this.config.providers.copilot.maxSessionSnapshots);
  }

  getConfig(): StandaloneConfig {
    return this.config;
  }

  getCacheStats(): { entries: number; hitRate: number } {
    return this.cacheManager.getStats();
  }

  saveConfig(config: StandaloneConfig): StandaloneConfig {
    this.config = config;
    saveStandaloneConfig(this.storageDir, this.config);
    this.snapshotStore.setMaxSnapshots(this.config.providers.copilot.maxSessionSnapshots);
    return this.config;
  }

  async refresh(): Promise<StandaloneRefreshResult> {
    const providers = this.createProviders();
    const diagnostics = this.initialDiagnostics(providers);
    const sessions: Session[] = [];
    const cutoff = this.sessionCutoff();
    const liveCopilotIds = new Set<string>();
    const seenFiles = new Set<string>();
    let sinceYield = 0;

    for (const provider of providers) { provider.beginScan(); }
    this.snapshotStore.beginScan();

    for (const provider of providers) {
      const diag = diagnostics.find(d => d.id === provider.id);
      let files: string[] = [];
      try {
        files = await provider.discoverSessionFiles();
        if (diag) { diag.sessionFilesFound = files.length; }
      } catch (err) {
        if (diag) { diag.lastError = String(err); }
        continue;
      }
      await yieldToHost();

      for (const file of files) {
        let stats: fs.Stats;
        try { stats = fs.statSync(file); } catch { continue; }
        if (stats.mtime < cutoff) { continue; }
        seenFiles.add(file);

        if (!this.cacheManager.needsUpdate(file, stats.mtimeMs)) {
          const cached = this.cacheManager.get(file);
          if (cached) {
            if (cached.provider === 'copilot') { liveCopilotIds.add(cached.id); }
            if (isSessionRecent(cached, cutoff)) { sessions.push(cached); }
          }
          continue;
        }

        try {
          const session = await provider.parseSessionFile(file, stats);
          this.cacheManager.set(file, session, stats.mtimeMs);
          if (session) {
            if (session.provider === 'copilot') {
              liveCopilotIds.add(session.id);
              this.snapshotStore.save(session);
            }
            if (isSessionRecent(session, cutoff)) { sessions.push(session); }
          }
        } catch (err) {
          if (diag) { diag.lastError = String(err); }
        }

        if (++sinceYield >= PARSE_YIELD_EVERY) {
          sinceYield = 0;
          await yieldToHost();
        }
      }
    }

    for (const snap of this.snapshotStore.loadAll()) {
      if (!liveCopilotIds.has(snap.id) && isSessionRecent(snap, cutoff)) {
        sessions.push(snap);
      }
    }

    this.snapshotStore.prune(cutoff);
    this.snapshotStore.flush();
    this.cacheManager.pruneMissing(seenFiles);
    this.cacheManager.flush();

    const deduped = dedupeSessions(sessions);
    const metrics = aggregateSessions(deduped, aggregationConfig(this.config));
    const insights = computeInsights({ metrics }, new Set(), {}, 6);

    return {
      generatedAt: new Date().toISOString(),
      config: this.config,
      sessions: deduped.sort((a, b) => b.endTime.getTime() - a.endTime.getTime()),
      metrics,
      insights,
      providers: diagnostics,
      storageDir: this.storageDir,
    };
  }

  private createProviders(): BaseProvider[] {
    const cfg = this.config.providers;
    const providers: BaseProvider[] = [];
    if (cfg.copilot.enabled) {
      providers.push(new CopilotProvider(
        cfg.copilot.inputTokenMultiplier,
        cfg.copilot.cacheEstimationEnabled,
        cfg.copilot.cacheEstimationConvention,
        cfg.copilot.additionalSessionPaths,
      ));
    }
    if (cfg.antigravity.enabled) { providers.push(new AntigravityProvider(cfg.antigravity.additionalSessionPaths)); }
    if (cfg.claudeCode.enabled) { providers.push(new ClaudeCodeProvider(cfg.claudeCode.additionalSessionPaths)); }
    if (cfg.codex.enabled) { providers.push(new CodexProvider(cfg.codex.additionalSessionPaths)); }
    if (cfg.jetbrainsAI.enabled) { providers.push(new JetBrainsAIProvider(cfg.jetbrainsAI.additionalSessionPaths)); }
    if (cfg.visualStudio.enabled) { providers.push(new VisualStudioProvider(cfg.visualStudio.additionalSessionPaths)); }
    return providers;
  }

  private initialDiagnostics(providers: BaseProvider[]): ProviderDiagnostic[] {
    const enabled = new Map(providers.map(p => [p.id, p]));
    return STANDALONE_PROVIDER_IDS.map(id => {
      const provider = enabled.get(id);
      return {
        id,
        displayName: provider?.displayName ?? displayNameForProvider(id),
        enabled: !!provider,
        sessionFilesFound: 0,
        sessionDirs: provider?.getSessionDirectories() ?? [],
      };
    });
  }

  private sessionCutoff(): Date {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.sessionLookbackDays);
    return cutoff;
  }
}

function displayNameForProvider(id: ProviderId): string {
  switch (id) {
    case 'copilot': return 'GitHub Copilot';
    case 'antigravity': return 'Antigravity';
    case 'claudeCode': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'jetbrainsAI': return 'Copilot (JetBrains)';
    case 'visualStudio': return 'Visual Studio';
  }
}

function isSessionRecent(session: Session, cutoff: Date): boolean {
  return session.endTime >= cutoff;
}

function dedupeSessions(sessions: Session[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const session of sessions) {
    const key = `${session.provider}:${session.id}`;
    const existing = byKey.get(key);
    if (!existing || session.endTime > existing.endTime || session.totalTokens > existing.totalTokens) {
      byKey.set(key, session);
    }
  }
  return [...byKey.values()];
}

function yieldToHost(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
