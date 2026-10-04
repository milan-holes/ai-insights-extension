/**
 * File cache manager - tracks file modifications to avoid re-parsing.
 *
 * Backed by a JSON file in the extension's global storage so a VS Code restart
 * (or a second window) does not have to re-read and re-parse every session log.
 * Parsing ~30MB of Copilot logs costs several seconds of blocking I/O, and that
 * cost used to be paid on every activation because the cache was memory-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CacheEntry, Session, Interaction } from '../types';

const MAX_CACHE_SIZE = 1000;
const CACHE_FILE = 'session-parse-cache.json';
const CACHE_VERSION = 1;

interface SerializedInteraction extends Omit<Interaction, 'timestamp'> {
  timestamp: string;
}

interface SerializedSession extends Omit<Session, 'startTime' | 'endTime' | 'interactions'> {
  startTime: string;
  endTime: string;
  interactions: SerializedInteraction[];
}

interface SerializedEntry {
  filePath: string;
  lastModified: number;
  lastProcessed: number;
  sessionData: SerializedSession | null;
}

interface CacheFile {
  version: number;
  entries: SerializedEntry[];
}

export class CacheManager {
  private cache = new Map<string, CacheEntry>();
  private filePath: string | null = null;
  /** Set when an entry changed, so flush() can skip writing an unchanged cache. */
  private dirty = false;

  /**
   * Point the cache at a storage directory and load any previously persisted
   * entries. Safe to call once at activation; without it the cache stays
   * memory-only and behaves exactly as before.
   */
  load(storageDir: string): void {
    this.filePath = path.join(storageDir, CACHE_FILE);
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) { return; }
      for (const entry of parsed.entries) {
        this.cache.set(entry.filePath, {
          filePath: entry.filePath,
          lastModified: entry.lastModified,
          lastProcessed: entry.lastProcessed,
          sessionData: entry.sessionData ? this.deserialize(entry.sessionData) : null,
        });
      }
    } catch {
      // First run, or a corrupt/outdated cache file - start empty.
    }
  }

  /** Persist the cache. No-op when nothing changed or no storage dir was set. */
  flush(): void {
    if (!this.filePath || !this.dirty) { return; }
    const data: CacheFile = {
      version: CACHE_VERSION,
      entries: [...this.cache.values()].map(e => ({
        filePath: e.filePath,
        lastModified: e.lastModified,
        lastProcessed: e.lastProcessed,
        sessionData: e.sessionData ? this.serialize(e.sessionData) : null,
      })),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
      this.dirty = false;
    } catch {
      // Cache is an optimization - a failed write must not break a refresh.
    }
  }

  /**
   * Check if a file needs re-parsing based on modification time.
   * Pass `mtimeMs` when the caller already stat'd the file to avoid a second stat.
   */
  needsUpdate(filePath: string, mtimeMs?: number): boolean {
    const entry = this.cache.get(filePath);
    if (!entry) { return true; }
    if (mtimeMs !== undefined) { return mtimeMs > entry.lastModified; }
    try {
      return fs.statSync(filePath).mtimeMs > entry.lastModified;
    } catch { return true; }
  }

  /**
   * Store parsed session data for a file.
   * Pass `mtimeMs` when the caller already stat'd the file to avoid a second stat.
   */
  set(filePath: string, session: Session | null, mtimeMs?: number): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entries
      const entries = [...this.cache.entries()];
      entries.sort((a, b) => a[1].lastProcessed - b[1].lastProcessed);
      for (let i = 0; i < entries.length / 4; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
    let lastModified = mtimeMs;
    if (lastModified === undefined) {
      try { lastModified = fs.statSync(filePath).mtimeMs; } catch { return; }
    }
    this.cache.set(filePath, {
      filePath, lastModified,
      lastProcessed: Date.now(), sessionData: session,
    });
    this.dirty = true;
  }

  /** Get cached session data. */
  get(filePath: string): Session | null | undefined {
    const entry = this.cache.get(filePath);
    return entry?.sessionData;
  }

  /** Drop entries whose source file no longer exists, so the cache cannot grow forever. */
  pruneMissing(knownFiles: Set<string>): void {
    for (const key of this.cache.keys()) {
      if (!knownFiles.has(key)) {
        this.cache.delete(key);
        this.dirty = true;
      }
    }
  }

  /** Get cache statistics. */
  getStats(): { entries: number; hitRate: number } {
    return { entries: this.cache.size, hitRate: 0 };
  }

  /** Clear all cached data. */
  clear(): void {
    this.cache.clear();
    this.dirty = true;
  }

  private serialize(session: Session): SerializedSession {
    return {
      ...session,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime.toISOString(),
      interactions: session.interactions.map(i => ({ ...i, timestamp: i.timestamp.toISOString() })),
    };
  }

  private deserialize(session: SerializedSession): Session {
    return {
      ...session,
      startTime: new Date(session.startTime),
      endTime: new Date(session.endTime),
      interactions: session.interactions.map(i => ({ ...i, timestamp: new Date(i.timestamp) })),
    };
  }
}
