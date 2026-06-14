import { Session } from '../types';
import {
  ContextRotAnalysis,
  ContextTimelinePoint,
  ContextBudgetAllocation,
  ContextGrowthCurve,
  SessionSiblingRef,
  OverloadSignal,
  FreshSessionBrief,
  OptimizationProposal,
} from '../types';

/** Backward-compatible score shape (subset of ContextRotAnalysis) */
export type ContextRotScore = Pick<
  ContextRotAnalysis,
  | 'score' | 'label' | 'turnsCount' | 'sessionAgeMinutes' | 'inputBloatFactor' | 'outputDeclineFactor'
  | 'contextRunway' | 'cacheEfficiencyRate' | 'contextQualityScore'
>;

/**
 * Fast, lightweight health score — backward-compatible entry point used by
 * sessionsView to render the per-row badge.
 */
export function computeContextRotScore(session: Session): ContextRotScore {
  const a = computeContextRotAnalysis(session);
  return {
    score: a.score,
    label: a.label,
    turnsCount: a.turnsCount,
    sessionAgeMinutes: a.sessionAgeMinutes,
    inputBloatFactor: a.inputBloatFactor,
    outputDeclineFactor: a.outputDeclineFactor,
    contextRunway: a.contextRunway,
    cacheEfficiencyRate: a.cacheEfficiencyRate,
    contextQualityScore: a.contextQualityScore,
  };
}

/**
 * Full workbench analysis: score + timeline + overload signals +
 * rehydration checklist + fresh-session brief + Tier-1/3 context metrics.
 */
export function computeContextRotAnalysis(session: Session, allSessions: Session[] = []): ContextRotAnalysis {
  const interactions = session.interactions;
  const turnsCount = interactions.length;
  const sessionAgeMinutes =
    (session.endTime.getTime() - session.startTime.getTime()) / 60000;

  // ── Bloat / decline factors ────────────────────────────────────────────────
  let inputBloatFactor = 1;
  let outputDeclineFactor = 1;

  if (turnsCount >= 6) {
    const third = Math.floor(turnsCount / 3);
    const firstThird = interactions.slice(0, third);
    const lastThird = interactions.slice(turnsCount - third);

    const avgInFirst = avg(firstThird.map(i => i.inputTokens));
    const avgInLast = avg(lastThird.map(i => i.inputTokens));
    inputBloatFactor = avgInFirst > 0 ? avgInLast / avgInFirst : 1;

    const avgOutFirst = avg(firstThird.map(i => i.outputTokens));
    const avgOutLast = avg(lastThird.map(i => i.outputTokens));
    outputDeclineFactor = avgOutFirst > 0 ? avgOutLast / avgOutFirst : 1;
  }

  // ── Base score ─────────────────────────────────────────────────────────────
  // Use peak effective context (input + cacheRead + cacheWrite) — not totalInputTokens, which
  // is near-zero for cached Claude Code sessions and gives incorrect context-size signals.
  const peakEffectiveContext = session.peakEffectiveContextTokens
    ?? interactions.reduce((m, i) => Math.max(m, i.effectiveContextTokens ?? (i.inputTokens + i.cacheReadTokens + i.cacheWriteTokens)), 0);

  let score = 0;
  if (turnsCount > 80) { score += 2; }
  else if (turnsCount > 40) { score += 1; }

  if (sessionAgeMinutes > 120) { score += 2; }
  else if (sessionAgeMinutes > 60) { score += 1; }

  if (inputBloatFactor > 4) { score += 3; }
  else if (inputBloatFactor > 2) { score += 2; }
  else if (inputBloatFactor > 1.5) { score += 1; }

  if (outputDeclineFactor < 0.4) { score += 2; }
  else if (outputDeclineFactor < 0.65) { score += 1; }

  if (peakEffectiveContext > 160_000) { score += 2; }
  else if (peakEffectiveContext > 80_000) { score += 1; }

  score = Math.min(10, score);
  const label = score >= 7 ? 'stale' : score >= 4 ? 'warning' : 'healthy';

  // ── Per-turn timeline ──────────────────────────────────────────────────────
  const timeline: ContextTimelinePoint[] = interactions.map((inter, idx) => ({
    turnIndex: idx,
    inputTokens: inter.inputTokens,
    outputTokens: inter.outputTokens,
    thinkingTokens: inter.thinkingTokens,
    toolCallCount: inter.toolCalls?.length ?? 0,
    cacheHit: inter.cacheReadTokens > 0,
    timestamp:
      inter.timestamp instanceof Date
        ? inter.timestamp.toISOString()
        : String(inter.timestamp),
  }));

  // ── Heavy tool usage (called 3+ times total) ───────────────────────────────
  const toolFreq: Record<string, number> = {};
  for (const inter of interactions) {
    for (const tool of inter.toolCalls ?? []) {
      toolFreq[tool] = (toolFreq[tool] ?? 0) + 1;
    }
  }
  const heavyToolUsage = Object.entries(toolFreq)
    .filter(([, n]) => n >= 3)
    .sort(([, a], [, b]) => b - a)
    .map(([t]) => t);

  // ── Repeated prompt fragments ──────────────────────────────────────────────
  const repeatedPromptFragments = extractRepeatedFragments(interactions.map(i => i.promptPreview ?? ''));

  // ── Overload signals ───────────────────────────────────────────────────────
  const overloadSignals = detectOverloadSignals(
    session, turnsCount, sessionAgeMinutes, inputBloatFactor, outputDeclineFactor, peakEffectiveContext,
  );

  // ── Restart recommendation ─────────────────────────────────────────────────
  const criticalSignals = overloadSignals.filter(s => s.severity === 'high');
  const restartRecommended = score >= 7 || criticalSignals.length >= 2;
  const restartReason = restartRecommended
    ? buildRestartReason(score, criticalSignals)
    : '';

  // ── Rehydration checklist ──────────────────────────────────────────────────
  const rehydrationChecklist = buildRehydrationChecklist(
    session, overloadSignals, heavyToolUsage,
  );

  // ── Fresh session brief ────────────────────────────────────────────────────
  const freshSessionBrief = buildFreshSessionBrief(session, overloadSignals);

  // ── Tier-1 metrics ─────────────────────────────────────────────────────────
  const contextRunway = computeContextRunway(interactions);
  const growthCurve = classifyGrowthCurve(interactions.map(i => ({
    inputTokens: i.effectiveContextTokens ?? (i.inputTokens + i.cacheReadTokens + i.cacheWriteTokens),
  })));
  // Denominator includes cacheWriteTokens: the model processes cached-write content too,
  // so omitting it inflates cache efficiency toward ~100% in every cached session.
  const totalContextLoad = session.totalInputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens;
  const cacheEfficiencyRate = totalContextLoad > 0
    ? Math.round(session.totalCacheReadTokens / totalContextLoad * 100)
    : 0;
  const cacheThrashDetected = session.totalCacheWriteTokens > 0 &&
    session.totalCacheWriteTokens > session.totalCacheReadTokens * 2;
  const thinkingEfficiencyTrend = computeThinkingEfficiencyTrend(interactions);

  // Cache thrash signal
  if (cacheThrashDetected) {
    const ratio = session.totalCacheReadTokens > 0
      ? (session.totalCacheWriteTokens / session.totalCacheReadTokens).toFixed(1)
      : '∞';
    overloadSignals.push({
      type: 'cache_thrash',
      severity: session.totalCacheWriteTokens > session.totalCacheReadTokens * 5 ? 'high' : 'medium',
      message: 'Cache thrash detected',
      detail: `Wrote ${ratio}× more cache than read back — context changes too rapidly for cache to stabilize. Consider loading key files once at session start.`,
    });
  }

  // Thinking overload signal
  if (thinkingEfficiencyTrend === 'rising' && turnsCount >= 4) {
    const withThinking = interactions.filter(i => i.thinkingTokens > 0);
    if (withThinking.length >= 3) {
      overloadSignals.push({
        type: 'thinking_overload',
        severity: 'medium',
        message: 'Thinking overhead increasing',
        detail: 'The model is spending progressively more thinking tokens per output token — an early sign of context confusion before output collapse.',
      });
    }
  }

  // ── Tier-3 metrics ─────────────────────────────────────────────────────────
  const contextBudgetAllocation = computeContextBudgetAllocation(session);
  const lostInMiddleRisk = computeLostInMiddleRisk(session, turnsCount, cacheEfficiencyRate, peakEffectiveContext);

  if (lostInMiddleRisk > 60) {
    overloadSignals.push({
      type: 'lost_in_middle',
      severity: lostInMiddleRisk > 80 ? 'high' : 'medium',
      message: `Lost-in-the-middle risk ${lostInMiddleRisk}%`,
      detail: `At ${(peakEffectiveContext / 1000).toFixed(0)}K context tokens, models lose recall on content placed in the middle of the context window. Key instructions from early turns may be poorly attended to.`,
    });
  }

  const totalToolCalls = interactions.reduce((n, i) => n + (i.toolCalls?.length ?? 0), 0);
  const toolOverheadRatio = session.totalOutputTokens > 0
    ? totalToolCalls / (session.totalOutputTokens / 100)
    : 0;
  const contextQualityScore = computeContextQualityScore(
    cacheEfficiencyRate, toolOverheadRatio, growthCurve, lostInMiddleRisk,
  );

  const sessionSiblings = detectSessionSiblings(session, allSessions);
  const optimizationProposals = computeOptimizationProposals(session, repeatedPromptFragments);

  return {
    score,
    label,
    turnsCount,
    sessionAgeMinutes,
    inputBloatFactor,
    outputDeclineFactor,
    timeline,
    overloadSignals,
    repeatedPromptFragments,
    heavyToolUsage,
    restartRecommended,
    restartReason,
    rehydrationChecklist,
    freshSessionBrief,
    contextRunway,
    growthCurve,
    cacheEfficiencyRate,
    cacheThrashDetected,
    thinkingEfficiencyTrend,
    contextBudgetAllocation,
    lostInMiddleRisk,
    contextQualityScore,
    sessionSiblings,
    optimizationProposals,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (arr.length === 0) { return 0; }
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function detectOverloadSignals(
  session: Session,
  turnsCount: number,
  sessionAgeMinutes: number,
  inputBloatFactor: number,
  outputDeclineFactor: number,
  peakEffectiveContext: number = 0,
): OverloadSignal[] {
  const signals: OverloadSignal[] = [];

  // High input/output ratio
  const ioRatio = session.totalOutputTokens > 0
    ? session.totalInputTokens / session.totalOutputTokens
    : 0;
  if (ioRatio > 20) {
    signals.push({
      type: 'high_input_output_ratio',
      severity: 'high',
      message: 'Extreme input/output imbalance',
      detail: `${ioRatio.toFixed(0)}× more input than output — context is dominated by accumulated history rather than new generation.`,
    });
  } else if (ioRatio > 8) {
    signals.push({
      type: 'high_input_output_ratio',
      severity: 'medium',
      message: 'High input/output ratio',
      detail: `${ioRatio.toFixed(0)}× more input than output. Consider summarizing previous context before continuing.`,
    });
  }

  // Long turn chain
  if (turnsCount > 80) {
    signals.push({
      type: 'long_turn_chain',
      severity: 'high',
      message: `Very long session (${turnsCount} turns)`,
      detail: 'Sessions above 80 turns accumulate stale instructions, resolved tool errors, and outdated context that can mislead the model.',
    });
  } else if (turnsCount > 40) {
    signals.push({
      type: 'long_turn_chain',
      severity: 'medium',
      message: `Long session (${turnsCount} turns)`,
      detail: 'Sessions above 40 turns often carry diminishing returns. Consider a fresh session with a rehydration brief.',
    });
  }

  // Large static context — use peak effective context (input + cacheRead + cacheWrite) because
  // input_tokens alone is near-zero for cached Claude Code sessions and would never trigger.
  const ctxK = (peakEffectiveContext / 1000).toFixed(0);
  if (peakEffectiveContext > 160_000) {
    signals.push({
      type: 'large_static_context',
      severity: 'high',
      message: `Very large context (${ctxK}K tokens)`,
      detail: 'Peak context window exceeded 160K tokens. Model attention degrades on early instructions and key details may be lost in the middle.',
    });
  } else if (peakEffectiveContext > 80_000) {
    signals.push({
      type: 'large_static_context',
      severity: 'medium',
      message: `Large context (${ctxK}K tokens)`,
      detail: 'Peak context window exceeded 80K tokens. Monitor for the "lost in the middle" effect on early system prompts.',
    });
  }

  // Output collapse
  if (outputDeclineFactor < 0.4 && turnsCount >= 6) {
    signals.push({
      type: 'output_collapse',
      severity: 'high',
      message: 'Severe output collapse',
      detail: `Output in the last third of this session is ${(outputDeclineFactor * 100).toFixed(0)}% of the first third. The model may be stuck, refusing, or losing coherence.`,
    });
  } else if (outputDeclineFactor < 0.65 && turnsCount >= 6) {
    signals.push({
      type: 'output_collapse',
      severity: 'medium',
      message: 'Output quality declining',
      detail: `Output volume dropped to ${(outputDeclineFactor * 100).toFixed(0)}% of early-session levels. Consider restructuring the task or starting fresh.`,
    });
  }

  // Tool loop: any single tool called more than 5 times
  const toolFreq: Record<string, number> = {};
  for (const inter of session.interactions) {
    for (const tool of inter.toolCalls ?? []) {
      toolFreq[tool] = (toolFreq[tool] ?? 0) + 1;
    }
  }
  const loopedTools = Object.entries(toolFreq).filter(([, n]) => n > 5);
  if (loopedTools.length > 0) {
    const examples = loopedTools.slice(0, 2).map(([t, n]) => `${t} (×${n})`).join(', ');
    signals.push({
      type: 'tool_loop',
      severity: loopedTools.some(([, n]) => n > 10) ? 'high' : 'medium',
      message: 'Repeated tool calls detected',
      detail: `Tools called many times: ${examples}. This may indicate a stuck retry loop or a task that would benefit from a different approach.`,
    });
  }

  // Session age as a standalone low signal
  if (sessionAgeMinutes > 180) {
    signals.push({
      type: 'long_turn_chain',
      severity: 'medium',
      message: `Session running for ${Math.round(sessionAgeMinutes / 60 * 10) / 10}h`,
      detail: 'Very long session wall-clock time. Instructions added at the start may be poorly recalled.',
    });
  }

  return signals;
}

function extractRepeatedFragments(previews: string[]): string[] {
  const nonEmpty = previews.filter(p => p && p.trim().length > 20);
  const counts: Record<string, number> = {};

  // Use the first 40 chars of each preview as a fingerprint
  for (const p of nonEmpty) {
    const key = p.trim().slice(0, 40).toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([k]) => k);
}

function buildRestartReason(score: number, criticalSignals: OverloadSignal[]): string {
  if (criticalSignals.length > 0) {
    return criticalSignals[0].message;
  }
  if (score >= 9) { return 'Context is severely bloated — model quality will be poor.'; }
  if (score >= 7) { return 'Context health is stale — fresh session recommended.'; }
  return 'Multiple warning signals detected.';
}

function buildRehydrationChecklist(
  session: Session,
  signals: OverloadSignal[],
  heavyTools: string[],
): string[] {
  const items: string[] = [];

  // Always-present items
  items.push(`Open a new session in ${session.workspace ? session.workspace.split('/').pop() || session.workspace : 'the project'}`);

  // Goal from first interaction
  const firstPrompt = session.interactions[0]?.promptPreview;
  if (firstPrompt) {
    items.push(`Restate goal: "${firstPrompt.slice(0, 80).trim()}${firstPrompt.length > 80 ? '…' : ''}"`);
  }

  // If there were write tool calls, mention reviewing recent changes
  if (heavyTools.some(t => /edit|write|create|patch|modify/i.test(t))) {
    items.push('Review and include recent file changes (git diff or relevant files)');
  }

  // If output collapsed, mention what was last attempted
  if (signals.some(s => s.type === 'output_collapse')) {
    const lastPrompt = session.interactions[session.interactions.length - 1]?.promptPreview;
    if (lastPrompt) {
      items.push(`Last attempted: "${lastPrompt.slice(0, 80).trim()}${lastPrompt.length > 80 ? '…' : ''}"`);
    }
    items.push('Describe what was partially done and what remains');
  }

  // If tool loop, mention the approach to avoid
  if (signals.some(s => s.type === 'tool_loop')) {
    items.push('Describe the failed approach to avoid re-entering the same loop');
  }

  // If large context, suggest scoping
  if (signals.some(s => s.type === 'large_static_context')) {
    items.push('Limit initial context: include only the files directly relevant to the next step');
  }

  // Generic close
  items.push('Define the single next action to complete');

  return items;
}

function buildFreshSessionBrief(session: Session, signals: OverloadSignal[]): FreshSessionBrief {
  const interactions = session.interactions;

  const goal = interactions[0]?.promptPreview
    ? interactions[0].promptPreview.slice(0, 200)
    : 'No prompt preview available';

  // Infer write operations from tool call names
  const writeTriggers = new Set<string>();
  for (const inter of interactions) {
    for (const tool of inter.toolCalls ?? []) {
      if (/edit|write|create|patch|modify|insert|delete/i.test(tool)) {
        writeTriggers.add(tool);
      }
    }
  }
  const writeOperations = [...writeTriggers];

  // Last 3 user prompts (most recent first)
  const recentContext = interactions
    .slice(-4, -1)
    .reverse()
    .map(i => (i.promptPreview ?? '').slice(0, 120))
    .filter(Boolean);

  const nextAction = interactions[interactions.length - 1]?.promptPreview
    ? interactions[interactions.length - 1].promptPreview!.slice(0, 150)
    : '';

  const warnings = signals
    .filter(s => s.severity !== 'low')
    .map(s => s.message);

  return { goal, writeOperations, recentContext, nextAction, warnings };
}

function computeOptimizationProposals(
  session: Session,
  repeatedFragments: string[],
): OptimizationProposal[] {
  const interactions = session.interactions.filter(i => !i.isCompactionEvent);
  const proposals: OptimizationProposal[] = [];

  if (interactions.length === 0) { return proposals; }

  // Peak context window = largest (input + cacheRead) seen in any turn
  const peakCtx = Math.max(...interactions.map(i => i.inputTokens + i.cacheReadTokens));
  if (peakCtx === 0) { return proposals; }

  // ── Build tool frequency map ──────────────────────────────────────────────
  const toolFreq: Record<string, number> = {};
  for (const inter of interactions) {
    for (const t of inter.toolCalls ?? []) {
      const k = t.toLowerCase();
      toolFreq[k] = (toolFreq[k] ?? 0) + 1;
    }
  }

  // ── Build file-read frequency map ────────────────────────────────────────
  const fileReads: Record<string, number> = {};
  let totalReadCount = 0;
  for (const inter of interactions) {
    for (const fa of inter.fileAccesses ?? []) {
      if (fa.tool.toLowerCase() === 'read') {
        fileReads[fa.path] = (fileReads[fa.path] ?? 0) + 1;
        totalReadCount++;
      }
    }
  }

  const pct = (savings: number) => Math.min(95, Math.round(savings / peakCtx * 100));

  // ── 1. Caveman debugging ──────────────────────────────────────────────────
  const bashCount = toolFreq['bash'] ?? 0;
  if (bashCount >= 6) {
    const excessBash = bashCount - 3;
    // Each debug Bash output ≈ 90 tokens that accumulate in the context cache
    const savings = excessBash * 90;
    const sp = pct(savings);
    if (sp >= 1) {
      proposals.push({
        technique: 'caveman',
        title: 'Caveman debugging',
        description: 'Replace ad-hoc Bash print statements (echo, cat, grep for debugging) with structured assertions or a single diagnostic script. Each call\'s output stays in the context cache for every subsequent turn.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `Bash called ${bashCount}× — ~${excessBash} calls likely debug-print output`,
      });
    }
  }

  // ── 2. File re-reads ──────────────────────────────────────────────────────
  const rereadFiles = Object.entries(fileReads).filter(([, n]) => n >= 2);
  if (rereadFiles.length > 0) {
    const extraReads = rereadFiles.reduce((s, [, n]) => s + (n - 1), 0);
    // Each unnecessary re-read ≈ 400-token median file added back into context
    const savings = extraReads * 400;
    const sp = pct(savings);
    if (sp >= 1) {
      const examples = rereadFiles.slice(0, 2)
        .map(([p, n]) => `${p.split('/').pop()} (×${n})`).join(', ');
      proposals.push({
        technique: 'file_reread',
        title: 'Eliminate file re-reads',
        description: 'Files already loaded into context are being re-read in later turns. Pass file content once, or use targeted grep/sed for subsequent lookups instead of re-reading the full file.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `${rereadFiles.length} file(s) read more than once: ${examples}`,
      });
    }
  }

  // ── 3. TOON — full file vs. excerpt ──────────────────────────────────────
  if (totalReadCount >= 5) {
    // TOON: return only the relevant section (~40% of file). Saves 60% per read.
    const savings = totalReadCount * 240; // 400 avg × 0.6 reduction
    const sp = pct(savings);
    if (sp >= 2) {
      proposals.push({
        technique: 'toon',
        title: 'TOON — return excerpts, not full files',
        description: 'Use offset + limit parameters on Read, or run grep/sed, to return only the relevant portion of each file. A 500-line file read for a 10-line function wastes ~90% of its tokens.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `Read called ${totalReadCount}× — full file content loaded each time`,
      });
    }
  }

  // ── 4. Early compaction ───────────────────────────────────────────────────
  const hasCompaction = session.interactions.some(i => i.isCompactionEvent);
  if (!hasCompaction && peakCtx > 60_000) {
    // Turns where context was already > 60K could have run at ~8K post-compact
    const heavyTurns = interactions
      .filter(i => i.inputTokens + i.cacheReadTokens > 60_000).length;
    // Each such turn could have saved ~52K tokens (60K → 8K)
    const totalCtxConsumed = interactions
      .reduce((s, i) => s + i.inputTokens + i.cacheReadTokens, 0);
    const savings = heavyTurns * 52_000;
    const sp = totalCtxConsumed > 0
      ? Math.min(80, Math.round(savings / totalCtxConsumed * 100))
      : 0;
    if (sp >= 5) {
      proposals.push({
        technique: 'early_compact',
        title: 'Use /compact earlier',
        description: 'Running /compact before context exceeds 60K tokens compresses conversation history to ~8K, restoring full working memory. The model quality improves and cache costs drop immediately.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `${heavyTurns} turn(s) ran with >60K context — no compaction used this session`,
      });
    }
  }

  // ── 5. Output verbosity ───────────────────────────────────────────────────
  const avgOutput = interactions.length > 0
    ? interactions.reduce((s, i) => s + i.outputTokens, 0) / interactions.length
    : 0;
  if (avgOutput > 1200 && interactions.length >= 6) {
    // Cutting output by 25% reduces context growth proportionally
    const savings = Math.round(session.totalOutputTokens * 0.25);
    const sp = pct(savings);
    if (sp >= 2) {
      proposals.push({
        technique: 'output_trim',
        title: 'Reduce output verbosity',
        description: 'Each output token becomes input in the next turn and stays cached thereafter. Adding "respond concisely", "no preamble", or "skip explanation" to prompts reduces context growth per turn.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `Average ${Math.round(avgOutput).toLocaleString()} tokens output/turn (trim 25% → ${Math.round(avgOutput * 0.75).toLocaleString()})`,
      });
    }
  }

  // ── 6. Prompt deduplication ───────────────────────────────────────────────
  if (repeatedFragments.length >= 2) {
    // Each fragment ≈ 40 chars ≈ 10 tokens, appearing 2+ extra times
    const savings = repeatedFragments.length * 2 * 10;
    const sp = pct(savings);
    if (sp >= 1) {
      proposals.push({
        technique: 'prompt_dedupe',
        title: 'Deduplicate prompt context',
        description: 'Move standing instructions, file paths, or project context that appears in every prompt into CLAUDE.md or a system prompt. They\'re sent once and cached, not repeated per message.',
        estimatedSavings: savings,
        savingsPct: sp,
        evidence: `${repeatedFragments.length} repeated fragment(s) detected across user prompts`,
      });
    }
  }

  return proposals.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
}

// ── Tier-1 helpers ────────────────────────────────────────────────────────────

function computeContextRunway(interactions: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; effectiveContextTokens?: number }[]): number | null {
  const MODEL_LIMIT = 200_000;
  if (interactions.length < 4) { return null; }

  const recent = interactions.slice(-6);
  // Use effective context per turn (input + cacheRead + cacheWrite) — for cached sessions,
  // inputTokens alone is ~1-3 tokens and gives meaningless growth-rate estimates.
  const inputs = recent.map(i => i.effectiveContextTokens ?? (i.inputTokens + i.cacheReadTokens + i.cacheWriteTokens));
  const n = inputs.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = inputs.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * inputs[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) { return null; }

  const slope = (n * sumXY - sumX * sumY) / denom;
  if (slope <= 0) { return null; }

  const remaining = MODEL_LIMIT - inputs[inputs.length - 1];
  if (remaining <= 0) { return 0; }
  return Math.max(0, Math.round(remaining / slope));
}

function classifyGrowthCurve(interactions: { inputTokens: number }[]): ContextGrowthCurve {
  if (interactions.length < 3) { return 'linear'; }

  const inputs = interactions.map(i => i.inputTokens);
  const mean = avg(inputs);
  if (mean === 0) { return 'linear'; }

  if (inputs.some(v => v > mean * 3)) { return 'spike'; }

  const variance = inputs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / inputs.length;
  if (Math.sqrt(variance) / mean < 0.1) { return 'plateau'; }

  if (inputs.length >= 6) {
    const half = Math.floor(inputs.length / 2);
    const firstGrowth = (inputs[half - 1] - inputs[0]) / Math.max(1, inputs[0]);
    const secondGrowth = (inputs[inputs.length - 1] - inputs[half]) / Math.max(1, inputs[half]);
    if (secondGrowth > firstGrowth * 1.5 && secondGrowth > 0.4) { return 'exponential'; }
  }
  return 'linear';
}

function computeThinkingEfficiencyTrend(
  interactions: { thinkingTokens: number; outputTokens: number }[],
): 'rising' | 'stable' | 'falling' | 'none' {
  const withThinking = interactions.filter(i => i.thinkingTokens > 0);
  if (withThinking.length < 4) { return 'none'; }

  const third = Math.floor(withThinking.length / 3);
  const ratioOf = (arr: { thinkingTokens: number; outputTokens: number }[]) =>
    avg(arr.map(i => i.outputTokens > 0 ? i.thinkingTokens / i.outputTokens : 0));

  const firstRatio = ratioOf(withThinking.slice(0, third));
  if (firstRatio === 0) { return 'none'; }
  const change = ratioOf(withThinking.slice(withThinking.length - third)) / firstRatio;
  if (change > 1.5) { return 'rising'; }
  if (change < 0.7) { return 'falling'; }
  return 'stable';
}

// ── Tier-3 helpers ────────────────────────────────────────────────────────────

function computeContextBudgetAllocation(session: Session): ContextBudgetAllocation {
  const cachedTokens = session.totalCacheReadTokens;
  const freshInputTokens = Math.max(0, session.totalInputTokens - cachedTokens);
  const cacheWriteTokens = session.totalCacheWriteTokens;
  const outputTokens = session.totalOutputTokens;
  const thinkingTokens = session.totalThinkingTokens;

  const total = (cachedTokens + freshInputTokens + cacheWriteTokens + outputTokens + thinkingTokens) || 1;
  const pct = (n: number) => Math.round(n / total * 100);

  return {
    cachedTokens,
    freshInputTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens,
    cachedPct: pct(cachedTokens),
    freshInputPct: pct(freshInputTokens),
    cacheWritePct: pct(cacheWriteTokens),
    outputPct: pct(outputTokens),
    thinkingPct: pct(thinkingTokens),
  };
}

function computeLostInMiddleRisk(
  session: Session,
  turnsCount: number,
  cacheEfficiencyRate: number,
  peakEffectiveContext: number,
): number {
  // Use peak effective context (input + cacheRead + cacheWrite) — not totalInputTokens, which
  // is near-zero for cached Claude Code sessions and would never trigger this risk signal.
  const total = peakEffectiveContext > 0 ? peakEffectiveContext : session.totalInputTokens;
  if (total < 60_000) { return 0; }
  let risk = Math.min(100, (total - 60_000) / (200_000 - 60_000) * 100);
  if (turnsCount > 30) { risk = Math.min(100, risk * 1.2); }
  if (cacheEfficiencyRate > 60) { risk = Math.max(0, risk * 0.8); }
  return Math.round(risk);
}

function computeContextQualityScore(
  cacheEfficiencyRate: number,
  toolOverheadRatio: number,
  growthCurve: ContextGrowthCurve,
  lostInMiddleRisk: number,
): number {
  const cachePoints = Math.round(30 * cacheEfficiencyRate / 100);
  const toolPoints = Math.round(20 * Math.max(0, 1 - Math.min(1, toolOverheadRatio)));
  const curvePoints = growthCurve === 'plateau' ? 30 : growthCurve === 'linear' ? 20 : growthCurve === 'spike' ? 15 : 5;
  const limPoints = Math.round(20 * (1 - lostInMiddleRisk / 100));
  return Math.min(100, cachePoints + toolPoints + curvePoints + limPoints);
}

function detectSessionSiblings(session: Session, allSessions: Session[]): SessionSiblingRef[] {
  const firstPrompt = session.interactions[0]?.promptPreview?.trim().toLowerCase().slice(0, 60) ?? '';
  if (firstPrompt.length < 20 || allSessions.length === 0) { return []; }

  const sessionStart = session.startTime instanceof Date
    ? session.startTime.getTime()
    : new Date(session.startTime as unknown as string).getTime();

  return allSessions
    .filter(s => {
      if (s.id === session.id || s.workspace !== session.workspace) { return false; }
      const otherStart = s.startTime instanceof Date
        ? s.startTime.getTime()
        : new Date(s.startTime as unknown as string).getTime();
      if (Math.abs(otherStart - sessionStart) > 86_400_000) { return false; }
      const otherFirst = s.interactions[0]?.promptPreview?.trim().toLowerCase().slice(0, 60) ?? '';
      if (otherFirst.length < 20) { return false; }
      let common = 0;
      for (let i = 0; i < Math.min(firstPrompt.length, otherFirst.length); i++) {
        if (firstPrompt[i] === otherFirst[i]) { common++; } else { break; }
      }
      return common >= 40;
    })
    .slice(0, 5)
    .map(s => ({
      sessionId: s.id,
      startTime: s.startTime instanceof Date ? s.startTime.toISOString() : String(s.startTime),
      title: s.title,
    }));
}
