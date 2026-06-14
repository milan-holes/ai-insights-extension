/**
 * Visual Studio Copilot Chat session log adapter.
 *
 * Visual Studio stores Copilot Chat sessions as MessagePack-encoded binary files
 * inside each project's .vs folder:
 *   <project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
 *
 * Discovery (two strategies, results merged):
 *   1. Log files  — %LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log
 *      Each log line matching /Updating session file '([^']+)'/ gives a path.
 *   2. Filesystem — scan home dir + common dev roots (repos/, code/, src/, etc.)
 *      for .vs directories, then look for copilot-chat/{hash}/sessions/{uuid} inside.
 *
 * WSL2 support: the extension runs in Linux (WSL2) but Visual Studio is a Windows-
 * only app. Both strategies are also run against the mounted Windows filesystem at
 * /mnt/c/Users/<winUser>/ so sessions are discovered without needing Windows env vars.
 *
 * File format: 1-byte version prefix (0x01) + MessagePack object stream:
 *   objects[0]        session header  { Name, TimeCreated, TimeUpdated, … }
 *   objects[1,3,5,…]  user requests   { CorrelationId, Content, Model.ModelId, … }
 *   objects[2,4,6,…]  AI responses    { Content, Model[version, {Id}], … }
 *
 * Token counts are ESTIMATED (~0.25 tokens/char) — VS does not store API token counts.
 *
 * Source reference:
 *   .others/ai-engineering-fluency/vscode-extension/src/visualstudio.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { decodeMulti, decode } from '@msgpack/msgpack';
import { BaseProvider } from './base';
import { calculateCost } from '../core/costEstimation';
import { Session, Interaction } from '../types';

const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'bin', 'obj', 'out', 'dist', 'build', 'target',
  'packages', 'vendor', '__pycache__', '.tox', '.venv', 'venv', 'env',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  '$Recycle.Bin', 'System Volume Information', 'Recovery',
  'AppData', 'Application Data',   // skip roaming profiles during home scan
]);

export class VisualStudioProvider extends BaseProvider {
  readonly id = 'visualStudio' as const;
  readonly displayName = 'Visual Studio';

  getSessionDirectories(): string[] {
    return this.buildScanRoots().map(r => r + ' (.vs/**/copilot-chat)');
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  async discoverSessionFiles(): Promise<string[]> {
    const seen = new Set<string>();
    const files: string[] = [];

    this.discoverFromLogs(seen, files);
    this.discoverFromFilesystem(seen, files);

    return files;
  }

  /** Parse VS temp chat log files to find "Updating session file '...'" entries. */
  private discoverFromLogs(seen: Set<string>, out: string[]): void {
    const pattern = /Updating session file '([^']+)'/;
    for (const logDir of this.logDirs()) {
      if (!fs.existsSync(logDir)) { continue; }
      try {
        for (const name of fs.readdirSync(logDir)) {
          if (!name.endsWith('.chat.log')) { continue; }
          try {
            const content = fs.readFileSync(path.join(logDir, name), 'utf-8');
            for (const line of content.split('\n')) {
              const m = pattern.exec(line);
              if (!m) { continue; }
              const p = this.normalizePath(m[1]);
              if (seen.has(p)) { continue; }
              seen.add(p);
              try { if (fs.existsSync(p)) { out.push(p); } } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  /** Recursively scan dev roots for .vs/<sol>/copilot-chat/<hash>/sessions/<file>. */
  private discoverFromFilesystem(seen: Set<string>, out: string[]): void {
    for (const root of this.buildScanRoots()) {
      this.scanForVsDirs(root, 0, root === os.homedir() ? 7 : 5, seen, out);
    }
  }

  private scanForVsDirs(dir: string, depth: number, max: number, seen: Set<string>, out: string[]): void {
    if (depth > max) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (SCAN_SKIP_DIRS.has(entry.name)) { continue; }
      if (entry.name.startsWith('.') && entry.name !== '.vs') { continue; }

      const full = path.join(dir, entry.name);
      if (entry.name === '.vs') {
        this.findSessionsInVsDir(full, seen, out);
      } else {
        this.scanForVsDirs(full, depth + 1, max, seen, out);
      }
    }
  }

  private findSessionsInVsDir(vsDir: string, seen: Set<string>, out: string[]): void {
    try {
      for (const sol of fs.readdirSync(vsDir, { withFileTypes: true })) {
        if (!sol.isDirectory()) { continue; }
        const copilotDir = path.join(vsDir, sol.name, 'copilot-chat');
        let hashes: fs.Dirent[];
        try { hashes = fs.readdirSync(copilotDir, { withFileTypes: true }); } catch { continue; }

        for (const hash of hashes) {
          if (!hash.isDirectory()) { continue; }
          const sessionsDir = path.join(copilotDir, hash.name, 'sessions');
          let sessionFiles: fs.Dirent[];
          try { sessionFiles = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { continue; }

          for (const sf of sessionFiles) {
            if (!sf.isFile()) { continue; }
            const full = path.join(sessionsDir, sf.name);
            if (seen.has(full)) { continue; }
            seen.add(full);
            out.push(full);
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── Parsing ─────────────────────────────────────────────────────────────────

  async parseSessionFile(filePath: string): Promise<Session | null> {
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length < 2) { return null; }
      // Skip 1-byte version prefix, then decode the MessagePack object stream
      const objects = Array.from(decodeMulti(buf.slice(1)) as Iterable<any>);
      if (objects.length === 0) { return null; }
      return this.buildSession(filePath, objects);
    } catch { return null; }
  }

  private buildSession(filePath: string, objects: any[]): Session | null {
    const header = objects[0] as any;
    if (!header) { return null; }

    const timeCreated = header?.TimeCreated ? new Date(header.TimeCreated as string) : new Date();
    const timeUpdated = header?.TimeUpdated ? new Date(header.TimeUpdated as string) : timeCreated;
    const sessionTitle = this.extractTitle(objects);

    const interactions: Interaction[] = [];
    const totalDurationMs = Math.max(timeUpdated.getTime() - timeCreated.getTime(), 0);
    const numPairs = Math.floor((objects.length - 1) / 2);

    for (let i = 1; i < objects.length; i += 2) {
      const reqObj = objects[i]?.[1];        // odd index = user request
      const respObj = objects[i + 1]?.[1];   // even index = AI response
      if (!reqObj && !respObj) { continue; }

      // Distribute timestamps evenly across the session duration
      const pairIdx = Math.floor((i - 1) / 2);
      const tsFraction = numPairs > 1 ? pairIdx / (numPairs - 1) : 0;
      const ts = new Date(timeCreated.getTime() + tsFraction * totalDurationMs);

      const reqText = this.extractTextFromContent(reqObj?.Content) +
                      this.extractContextText(reqObj?.Context);
      const respText = this.extractTextFromContent(respObj?.Content);

      const reqModel = reqObj ? this.getModelId(reqObj, true) : null;
      const respModel = respObj ? this.getModelId(respObj, false) : null;
      const model = respModel || reqModel || 'copilot-vs';

      const inputTokens = this.estimateTokens(reqText, 0.25);
      const outputTokens = this.estimateTokens(respText, 0.25);

      interactions.push({
        timestamp: ts,
        model,
        inputTokens,
        outputTokens,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens,
        effectiveContextTokens: inputTokens,
        mode: 'chat',
        toolCalls: [],
        promptPreview: reqText.substring(0, 200) || undefined,
      });
    }

    if (interactions.length === 0) { return null; }

    const sessionId = path.basename(filePath);
    const workspace = this.extractWorkspace(filePath);

    return {
      id: `vs-${sessionId}`,
      provider: 'visualStudio',
      providerName: 'Visual Studio',
      startTime: timeCreated,
      endTime: timeUpdated,
      interactions,
      totalTokens: interactions.reduce((s, i) => s + i.totalTokens, 0),
      totalInputTokens: interactions.reduce((s, i) => s + i.inputTokens, 0),
      totalOutputTokens: interactions.reduce((s, i) => s + i.outputTokens, 0),
      totalThinkingTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      models: [...new Set(interactions.map(i => i.model))],
      workspace,
      sourceFile: filePath,
      title: sessionTitle,
      estimatedCostUsd: interactions.reduce((sum, i) => sum + calculateCost(i.model, i.inputTokens, i.outputTokens, 0, 0), 0),
      peakEffectiveContextTokens: interactions.reduce((m, i) => Math.max(m, i.effectiveContextTokens), 0),
    };
  }

  // ── MessagePack field helpers ───────────────────────────────────────────────

  /** Extract first user message text (used as session title, ≤80 chars). */
  private extractTitle(objects: any[]): string | undefined {
    const req = objects.find((_: any, i: number) => i > 0 && i % 2 === 1);
    const text = this.extractTextFromContent(req?.[1]?.Content).trim();
    if (!text) { return undefined; }
    return text.length > 80 ? text.substring(0, 80) + '…' : text;
  }

  /** Concatenate text from VS Content array: [[type, {Content: string}], …] */
  private extractTextFromContent(contentArr: any): string {
    if (!Array.isArray(contentArr)) { return ''; }
    return contentArr
      .map((c: any) => (c?.[1] && typeof c[1].Content === 'string' ? c[1].Content : ''))
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Extract context text from VS request Context array.
   * Each item has a ValueContainer whose payload may be a nested MessagePack blob.
   */
  private extractContextText(contextArr: any): string {
    if (!Array.isArray(contextArr)) { return ''; }
    const parts: string[] = [];
    for (const item of contextArr) {
      const vc = item?.ValueContainer;
      if (!Array.isArray(vc) || vc.length < 2) { continue; }
      const vcRaw = vc[1];
      if (!vcRaw || typeof vcRaw !== 'object') { continue; }
      const keys = Object.keys(vcRaw);
      if (keys.length === 0) { continue; }
      if (!isNaN(Number(keys[0]))) {
        // Numeric-keyed object = byte array → nested MessagePack blob
        try {
          const numKeys = keys.map(Number).sort((a, b) => a - b);
          const bytes = Buffer.from(numKeys.map(k => (vcRaw as Record<number, number>)[k]));
          const inner = decode(bytes) as any;
          const innerData = Array.isArray(inner) ? inner[1] : inner;
          if (innerData?.Content && typeof innerData.Content === 'string') {
            parts.push(innerData.Content);
          }
        } catch { /* ignore */ }
      } else if (typeof vcRaw.Content === 'string') {
        parts.push(vcRaw.Content);
      }
    }
    return parts.join('\n');
  }

  /** Extract model ID from a decoded VS message object. */
  private getModelId(msgObj: any, isRequest: boolean): string | null {
    if (!msgObj) { return null; }
    if (isRequest) { return msgObj.Model?.ModelId || null; }
    // Response: Model = [version, { Id, Name, … }]
    const m = msgObj.Model;
    if (Array.isArray(m) && m.length >= 2 && m[1]?.Id) { return m[1].Id as string; }
    return null;
  }

  // ── Path helpers ─────────────────────────────────────────────────────────────

  /**
   * Returns log directories to scan for VS .chat.log files.
   * Covers native Windows (%LOCALAPPDATA%) and WSL2 (/mnt/c/…).
   */
  private logDirs(): string[] {
    const dirs: string[] = [];

    // Native Windows
    if (os.platform() === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      dirs.push(path.join(local, 'Temp', 'VSGitHubCopilotLogs'));
    }

    // WSL2: mounted Windows filesystem
    const wslDirs = this.wslWindowsUserDirs();
    for (const winHome of wslDirs) {
      dirs.push(path.join(winHome, 'AppData', 'Local', 'Temp', 'VSGitHubCopilotLogs'));
    }

    return dirs;
  }

  /**
   * Returns filesystem roots to scan for .vs directories.
   * Covers native Windows home + common dev roots, and WSL2 equivalents.
   */
  private buildScanRoots(): string[] {
    const roots: string[] = [];

    if (os.platform() === 'win32') {
      roots.push(os.homedir());
      for (const drive of ['C', 'D']) {
        for (const name of ['repos', 'code', 'src', 'projects', 'dev']) {
          const p = `${drive}:\\${name}`;
          try { if (fs.existsSync(p)) { roots.push(p); } } catch { /* ok */ }
        }
      }
    }

    // WSL2: scan mounted Windows user home + common dev roots
    const wslDirs = this.wslWindowsUserDirs();
    for (const winHome of wslDirs) {
      roots.push(winHome);
      // Also scan C:\repos, C:\code etc. via the mounted drive
      const cDrive = '/mnt/c';
      for (const name of ['repos', 'code', 'src', 'projects', 'dev']) {
        const p = path.join(cDrive, name);
        try { if (fs.existsSync(p)) { roots.push(p); } } catch { /* ok */ }
      }
    }

    return roots;
  }

  /**
   * On WSL2, Windows user home directories are accessible at /mnt/c/Users/<name>/.
   * Returns the list of such paths that actually exist.
   */
  private wslWindowsUserDirs(): string[] {
    const dirs: string[] = [];
    if (os.platform() === 'win32') { return dirs; }
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

  /** Convert a Windows absolute path (possibly from a log file) to a local-accessible path. */
  private normalizePath(p: string): string {
    if (os.platform() !== 'win32' && /^[A-Za-z]:\\/.test(p)) {
      // Windows path on WSL2 → /mnt/c/...
      const drive = p[0].toLowerCase();
      return `/mnt/${drive}/` + p.slice(3).replace(/\\/g, '/');
    }
    return p;
  }

  /** Extract solution/project name from the session file path. */
  private extractWorkspace(filePath: string): string {
    // Pattern: .vs/<solution-dir>/copilot-chat/<hash>/sessions/<file>
    const norm = filePath.replace(/\\/g, '/');
    const m = norm.match(/\/\.vs\/([^/]+)\/copilot-chat\//);
    return m ? m[1] : 'Visual Studio';
  }
}
