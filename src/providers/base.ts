/**
 * Abstract base class for AI provider adapters.
 * Each provider (Copilot, Antigravity, Claude Code) implements this
 * to discover and parse their session log files into a unified Session format.
 */

import * as os from 'os';
import { Session, ProviderId } from '../types';

export abstract class BaseProvider {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;

  /**
   * Discover all session log file paths for this provider.
   * Returns absolute paths to files that should be parsed.
   */
  abstract discoverSessionFiles(): Promise<string[]>;

  /**
   * Parse a single session file into our unified Session format.
   * Returns null if the file cannot be parsed or is invalid.
   */
  abstract parseSessionFile(filePath: string): Promise<Session | null>;

  /**
   * Get all session directories this provider checks.
   * Used for diagnostic reporting.
   */
  abstract getSessionDirectories(): string[];

  /**
   * Collect all sessions from discovered files.
   */
  async collectSessions(): Promise<Session[]> {
    const files = await this.discoverSessionFiles();
    const sessions: Session[] = [];

    for (const file of files) {
      try {
        const session = await this.parseSessionFile(file);
        if (session) {
          sessions.push(session);
        }
      } catch (err) {
        // Log but don't fail - other sessions may still work
        console.warn(`[AI Insights] Failed to parse ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * Estimate token count from text length using character-to-token ratio.
   */
  protected estimateTokens(text: string, ratio: number = 0.25): number {
    if (!text) { return 0; }
    return Math.round(text.length * ratio);
  }

  /**
   * Get today's date as YYYY-MM-DD string.
   */
  protected getToday(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Check if a date is within the last N days.
   */
  protected isWithinDays(date: Date, days: number): boolean {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return date >= cutoff;
  }

  /**
   * Expand a leading ~ to the user's home directory, for user-supplied additional session paths.
   */
  protected expandHome(p: string): string {
    return p.replace(/^~/, os.homedir());
  }
}
