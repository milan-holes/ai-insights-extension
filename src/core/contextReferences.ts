/**
 * Detects explicit context-anchoring syntax within a user prompt: chat variables/
 * participants (#file, @workspace, ...) that deliberately point the model at specific
 * context rather than relying on ambient/injected context.
 */
import { Session, ContextEngagement } from '../types';

const CONTEXT_REF_PATTERNS: Record<string, RegExp> = {
  file: /#file\b/gi,
  selection: /#selection\b/gi,
  codebase: /#codebase\b/gi,
  changes: /#changes\b/gi,
  terminalLastCommand: /#terminalLastCommand\b/gi,
  terminalSelection: /#terminalSelection\b/gi,
  problems: /#problems\b/gi,
  workspace: /@workspace\b/gi,
  terminal: /@terminal\b/gi,
  vscode: /@vscode\b/gi,
};

/** Counts occurrences of each known context-reference token type in a prompt's text. */
export function extractContextRefs(text: string | undefined | null): Record<string, number> | undefined {
  if (!text) { return undefined; }
  let counts: Record<string, number> | undefined;
  for (const [type, pattern] of Object.entries(CONTEXT_REF_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      counts = counts || {};
      counts[type] = matches.length;
    }
  }
  return counts;
}

/** Rolls up context-reference usage across all sessions/interactions. */
export function computeContextEngagement(sessions: Session[]): ContextEngagement {
  const byType: Record<string, number> = {};
  let totalRefs = 0;
  let interactionsWithRefs = 0;
  let interactionsWithPrompt = 0;

  for (const sess of sessions) {
    for (const i of sess.interactions) {
      if (i.isCompactionEvent) { continue; }
      if (i.promptPreview === undefined && i.contextRefs === undefined) { continue; }
      interactionsWithPrompt += 1;
      if (i.contextRefs) {
        interactionsWithRefs += 1;
        for (const [type, count] of Object.entries(i.contextRefs)) {
          byType[type] = (byType[type] || 0) + count;
          totalRefs += count;
        }
      }
    }
  }

  return {
    totalRefs,
    byType,
    interactionsWithRefs,
    refRate: interactionsWithPrompt > 0 ? interactionsWithRefs / interactionsWithPrompt : 0,
  };
}
