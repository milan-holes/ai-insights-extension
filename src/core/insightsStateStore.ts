import * as fs from 'fs';
import * as path from 'path';

interface InsightsState {
  dismissed: string[];
  /** insight id -> epoch ms until which it stays hidden */
  snoozedUntil: Record<string, number>;
}

const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export class InsightsStateStore {
  private readonly filePath: string;
  private data: InsightsState = { dismissed: [], snoozedUntil: {} };

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'insights-state.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = { dismissed: parsed.dismissed ?? [], snoozedUntil: parsed.snoozedUntil ?? {} };
      }
    } catch {
      this.data = { dismissed: [], snoozedUntil: {} };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* ignore write errors */ }
  }

  getDismissed(): Set<string> {
    return new Set(this.data.dismissed);
  }

  getSnoozedUntil(): Record<string, number> {
    return { ...this.data.snoozedUntil };
  }

  dismiss(id: string): void {
    if (!this.data.dismissed.includes(id)) {
      this.data.dismissed = [...this.data.dismissed, id];
      this.save();
    }
  }

  snooze(id: string): void {
    this.data.snoozedUntil = { ...this.data.snoozedUntil, [id]: Date.now() + SNOOZE_DURATION_MS };
    this.save();
  }
}
