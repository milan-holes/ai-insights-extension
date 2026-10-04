import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuotaView, CopilotQuotaData, getQuotaPrediction } from '../src/core/copilotQuota';

const RESET = '2026-11-01T00:00:00Z';

function premium(entitlement: number, remaining: number) {
  return {
    quota_id: 'premium_interactions',
    entitlement,
    quota_remaining: remaining,
    remaining,
    unlimited: false,
    overage_permitted: false,
  };
}

describe('getQuotaPrediction', () => {
  it('uses cycle-to-date usage, not burst rates', () => {
    // 400 used, cycle started 2026-10-01, 2.5 days elapsed -> 160/day.
    const p = getQuotaPrediction(premium(6000, 5600), RESET, new Date('2026-10-03T12:00:00Z'));
    assert.ok(p);
    assert.equal(p.predictedDailyUsage, 160);
    assert.equal(p.daysUntilExhaustion, 35);
    assert.equal(p.willExhaustBeforeReset, false);
  });

  it('floors elapsed time at one day', () => {
    const p = getQuotaPrediction(premium(300, 200), RESET, new Date('2026-10-01T02:00:00Z'));
    assert.ok(p);
    assert.equal(p.predictedDailyUsage, 100);
    assert.equal(p.willExhaustBeforeReset, true);
  });

  it('returns null with no usage this cycle', () => {
    assert.equal(getQuotaPrediction(premium(300, 300), RESET, new Date('2026-10-10T00:00:00Z')), null);
  });
});

describe('buildQuotaView', () => {
  it('hides exhaustion when quota outlasts the reset', () => {
    const data: CopilotQuotaData = {
      login: 'u',
      copilot_plan: 'business',
      quota_snapshots: { premium_interactions: premium(6000, 5600) },
      quota_reset_date_utc: RESET,
    };
    const view = buildQuotaView(data);
    assert.ok(view);
    assert.equal(view.daysUntilExhaustion, null);
  });
});
