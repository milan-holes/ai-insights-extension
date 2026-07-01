import * as vscode from 'vscode';
import { DiffMetrics } from '../types';

/**
 * Tracks GitHub Copilot code-diff outcomes: accepted, updated (modified before
 * applying), and declined.
 *
 * Detection strategy
 * ──────────────────
 * Copilot (inline-chat, Apply-in-Editor, workspace edits) presents proposed
 * code changes by opening a `TabInputTextDiff` whose *original* side holds a
 * virtual snapshot of the pre-change content (scheme ≠ "file:").  We detect
 * these tabs via `vscode.window.tabGroups.onDidChangeTabs`.
 *
 * When a tracked diff tab opens  → snapshot the current file content ("before").
 * When that tab closes:
 *   - content unchanged            → declined
 *   - content changed, matches the
 *     "modified" side exactly      → accepted (diff applied as-is)
 *   - content changed but differs  → updated (user edited before applying)
 *
 * Resets each VS Code session (same as AcceptanceTracker).
 */

function isCopilotDiffTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  if (!(input instanceof vscode.TabInputTextDiff)) { return false; }
  const origScheme = input.original.scheme.toLowerCase();
  // Copilot diffs use virtual URIs for the "original" side — not plain `file:` or `git:`.
  return origScheme !== 'file' && origScheme !== 'git' && origScheme !== 'git-index';
}

/** Opens a document, resolving with its text or null on failure. */
function safeOpenDocument(uri: vscode.Uri): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    vscode.workspace.openTextDocument(uri).then(
      (doc: vscode.TextDocument) => { resolve(doc.getText()); },
      () => { resolve(null); },
    );
  });
}

export class DiffTracker {
  private _shown = 0;
  private _accepted = 0;
  private _updated = 0;
  private _declined = 0;
  private readonly _since: Date;

  /**
   * uri-string of the modified file → { snapshot: content before diff opened,
   *                                      proposed: content from modified-side doc }
   */
  private readonly _pending = new Map<string, { snapshot: string; proposed: string | null }>();

  constructor() {
    this._since = new Date();
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(async (e) => {

        // ── Opened ──────────────────────────────────────────────────────────
        for (const tab of e.opened) {
          if (!isCopilotDiffTab(tab)) { continue; }
          const input = tab.input as vscode.TabInputTextDiff;
          const key = input.modified.toString();
          if (this._pending.has(key)) { continue; } // already tracking

          this._shown++;

          // proposed = what Copilot put in the modified-side doc
          let proposed: string | null = null;
          const liveDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
          if (liveDoc) {
            proposed = liveDoc.getText();
          } else {
            proposed = await safeOpenDocument(input.modified);
          }

          // snapshot = pre-edit content from the original-side virtual doc
          const snapshot = (await safeOpenDocument(input.original)) ?? '';

          this._pending.set(key, { snapshot, proposed });
        }

        // ── Closed ──────────────────────────────────────────────────────────
        for (const tab of e.closed) {
          if (!(tab.input instanceof vscode.TabInputTextDiff)) { continue; }
          const input = tab.input as vscode.TabInputTextDiff;
          const key = input.modified.toString();
          const entry = this._pending.get(key);
          if (!entry) { continue; }
          this._pending.delete(key);

          // Get the current document content (what the file looks like now)
          const currentDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
          const currentContent = currentDoc ? currentDoc.getText() : null;

          if (currentContent === null || currentContent === entry.snapshot) {
            // Content unchanged → user declined
            this._declined++;
          } else if (entry.proposed !== null && currentContent === entry.proposed) {
            // Content matches the Copilot proposal exactly → accepted as-is
            this._accepted++;
          } else {
            // Content changed but doesn't match the proposal exactly → user
            // edited the suggestion before applying it
            this._updated++;
          }
        }
      }),
    );
  }

  getStats(): DiffMetrics {
    const total = this._accepted + this._updated + this._declined;
    return {
      shown: this._shown,
      accepted: this._accepted,
      updated: this._updated,
      declined: this._declined,
      acceptanceRate: total > 0 ? this._accepted / total : 0,
      since: new Date(this._since),
    };
  }
}
