/**
 * Rolls up compaction accounting and marathon-session detection across all sessions.
 * Reuses contextRot.ts's existing 'long_turn_chain' overload signal for marathon
 * detection instead of redefining the turn-count/session-age thresholds.
 */
import { Session, SessionHygieneSummary } from '../types';
import { computeContextRotAnalysis } from './contextRot';

export function computeSessionHygieneSummary(sessions: Session[]): SessionHygieneSummary {
  let manualCompactions = 0;
  let autoCompactions = 0;
  let tokensReclaimed = 0;
  let marathonSessions = 0;
  let longestMarathonMinutes = 0;

  for (const sess of sessions) {
    for (const i of sess.interactions) {
      if (!i.isCompactionEvent) { continue; }
      if (i.compactionTrigger === 'manual') { manualCompactions += 1; } else { autoCompactions += 1; }
      if (i.preCompactionTokens !== undefined && i.postCompactionTokens !== undefined) {
        tokensReclaimed += Math.max(0, i.preCompactionTokens - i.postCompactionTokens);
      }
    }

    const analysis = computeContextRotAnalysis(sess);
    if (analysis.overloadSignals.some(s => s.type === 'long_turn_chain')) {
      marathonSessions += 1;
      const minutes = (sess.endTime.getTime() - sess.startTime.getTime()) / 60000;
      longestMarathonMinutes = Math.max(longestMarathonMinutes, minutes);
    }
  }

  return {
    manualCompactions,
    autoCompactions,
    tokensReclaimed,
    marathonSessions,
    longestMarathonMinutes: Math.round(longestMarathonMinutes),
  };
}
