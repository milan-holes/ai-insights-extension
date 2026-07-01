/**
 * Persistent snapshot store for Copilot session data.
 *
 * GitHub Copilot stores sessions as mutable JSON files that are deleted when
 * the user clears a chat. This store snapshots parsed Copilot sessions to disk
 * so analytics survive file deletions. Claude Code uses append-only JSONL and
 * does not need snapshotting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Session, Interaction } from '../types';

const SNAPSHOT_FILE = 'copilot-session-snapshots.json';
const DEFAULT_MAX_SNAPSHOTS = 2000;

interface SerializedInteraction extends Omit<Interaction, 'timestamp'> {
  timestamp: string;
}

interface SerializedSession extends Omit<Session, 'startTime' | 'endTime' | 'interactions'> {
  startTime: string;
  endTime: string;
  interactions: SerializedInteraction[];
}

interface SnapshotFile {
  version: number;
  snapshots: Record<string, SerializedSession>;
}

export class SessionSnapshotStore {
  private readonly filePath: string;
  private maxSnapshots: number;

  constructor(storageDir: string, maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS) {
    this.filePath = path.join(storageDir, SNAPSHOT_FILE);
    this.maxSnapshots = maxSnapshots;
  }

  /** Update the snapshot cap, e.g. when the user changes the setting at runtime. */
  setMaxSnapshots(maxSnapshots: number): void {
    this.maxSnapshots = maxSnapshots;
  }

  /** Persist a session. Overwrites any existing snapshot with the same id. */
  save(session: Session): void {
    const data = this.loadRaw();
    data.snapshots[session.id] = this.serialize(session);

    const ids = Object.keys(data.snapshots);
    if (ids.length > this.maxSnapshots) {
      const sorted = ids.sort(
        (a, b) =>
          new Date(data.snapshots[a].endTime).getTime() -
          new Date(data.snapshots[b].endTime).getTime(),
      );
      for (let i = 0; i < ids.length - this.maxSnapshots; i++) {
        delete data.snapshots[sorted[i]];
      }
    }

    this.write(data);
  }

  /** Return all stored snapshots as deserialized Session objects. */
  loadAll(): Session[] {
    const data = this.loadRaw();
    return Object.values(data.snapshots).map(s => this.deserialize(s));
  }

  /** Remove snapshots whose endTime is before cutoff. */
  prune(cutoff: Date): void {
    const data = this.loadRaw();
    let changed = false;
    for (const id of Object.keys(data.snapshots)) {
      if (new Date(data.snapshots[id].endTime) < cutoff) {
        delete data.snapshots[id];
        changed = true;
      }
    }
    if (changed) { this.write(data); }
  }

  private loadRaw(): SnapshotFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SnapshotFile;
      if (parsed?.version === 1 && parsed.snapshots) { return parsed; }
    } catch { /* first run or corrupt file — start fresh */ }
    return { version: 1, snapshots: {} };
  }

  private write(data: SnapshotFile): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
    } catch { /* ignore write failures — analytics degrade gracefully */ }
  }

  private serialize(session: Session): SerializedSession {
    return {
      ...session,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime.toISOString(),
      interactions: session.interactions.map(i => ({
        ...i,
        timestamp: i.timestamp instanceof Date
          ? i.timestamp.toISOString()
          : String(i.timestamp),
      })),
    };
  }

  private deserialize(s: SerializedSession): Session {
    return {
      ...s,
      startTime: new Date(s.startTime),
      endTime: new Date(s.endTime),
      interactions: s.interactions.map(i => ({
        ...i,
        timestamp: new Date(i.timestamp),
      })),
    };
  }
}
