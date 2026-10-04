# Proposed Metrics - AI Insights Extension

> **Strategic context**: GitHub Copilot is moving from flat-rate premium request units to
> **token-based AI Credit billing effective June 1, 2026**
> ([announcement](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)).
> Token consumption now has a direct dollar cost. This extension is positioned to be the
> primary visibility layer for individuals and teams managing that spend - making the
> metrics below critical business value, not just nice-to-have analytics.

---

## Billing change - what it means for this extension

| Old model | New model (June 1, 2026) |
|-----------|--------------------------|
| Flat premium request units (PRUs) - chat and 8-hour agent run cost the same | Token-based: input + output + cached tokens × per-model rate |
| No financial incentive to optimise prompt length or model choice | Every token counts; model selection and caching directly affect spend |
| Code completions and chat billed the same way | Code completions **free**; chat and agent sessions consume credits |
| No overage risk for most users | Monthly credit cap; overage optional per admin setting |

**Included monthly credits by plan:**

| Plan | Monthly credits |
|------|----------------|
| Copilot Pro | $10 |
| Copilot Pro+ | $39 |
| Copilot Business | $19 / user |
| Copilot Enterprise | $39 / user |

---

## Current metric gaps (summary)

The extension already tracks tokens, cost, environmental impact, and provider/model/repository breakdowns well. What it **lacks** given the billing change:

- No budget vs. spend awareness (burn rate, remaining credits, overage risk)
- No billable vs. free interaction split (chat/agent vs. completions)
- No cache efficiency as a cost-saving metric
- No anomaly / runaway-session detection
- No month-end spend forecast
- No cross-provider ROI comparison (cost per useful output unit)
- No session depth or complexity cost drivers
- No team-level cost attribution

---

## Proposed metrics by category

### 1. Credit Budget Management
*Priority: P0 - foundational for usage-based billing era*

| Metric | Description | Formula / Source |
|--------|-------------|-----------------|
| **Daily Credit Burn Rate** | Average dollars spent per active day | `totalCost / activeDaysLast30` |
| **Month-to-Date Spend** | Credits consumed since 1st of current month | Sum of `estimatedCost` for MTD sessions |
| **Credits Remaining** | Credits left in current billing cycle | `planBudget - mtdSpend` (user-configured plan) |
| **Days Until Budget Exhausted** | At current burn rate, when do credits run out? | `creditsRemaining / dailyBurnRate` |
| **Projected Month-End Spend** | Extrapolation of MTD spend to end of month | `mtdSpend / daysElapsed × daysInMonth` |
| **Overage Risk Score** | % probability of exceeding plan by month end | `projectedSpend / planBudget × 100` - flagged >90% |
| **Budget Utilization %** | MTD spend as percentage of plan | `mtdSpend / planBudget × 100` |

**UI requirements:**
- Progress bar widget on dashboard showing MTD spend / budget
- Color bands: green <50%, amber 50–80%, red >80%
- "Days remaining at this rate" numeric callout
- Configurable plan budget in extension settings (`aiInsights.copilotPlanBudget`)

---

### 2. Billable vs. Free Interaction Tracking
*Priority: P0 - Copilot completions are free; chat/agent are not*

| Metric | Description | Notes |
|--------|-------------|-------|
| **Free Interactions** | Code completion invocations (no token cost) | Copilot only; requires new completion event capture |
| **Billable Interactions** | Chat + agent + code review interactions | All current tracked interactions |
| **Billable Session Ratio** | % of Copilot sessions that are chat/agent | `billableSessions / totalSessions` |
| **Completion-to-Chat Ratio** | How much "free" vs "paid" usage a user gets | Completion count / chat interaction count |
| **Per-Interaction Cost** | Average credit cost of a single billable exchange | `estimatedCost / billableInteractions` |
| **Highest-Cost Session** | The single most expensive session (MTD) | Max `estimatedCost` per session |

**Note on completions**: Copilot's VS Code extension fires `onDidAcceptCompletionItem` events.
Hooking this (or reading completion logs if available) would add a free-interaction count
without changing cost math.

---

### 3. Cache Efficiency (Cost-Saving Indicator)
*Priority: P1 - cached tokens cost ~10× less; directly reduces spend*

| Metric | Description | Formula |
|--------|-------------|---------|
| **Cache Hit Rate** | % of input tokens served from cache | `cacheReadTokens / inputTokens × 100` |
| **Cache Savings ($)** | Dollars saved by cache reads vs. full-price input | `cacheReadTokens × (inputRate - cachedRate) / 1M` |
| **Cache Efficiency Trend** | Cache hit rate over last 30 days (daily) | Per-day `cacheReadTokens / inputTokens` |
| **Cache Write/Read Ratio** | How often cached content is reused | `cacheReadTokens / cacheWriteTokens` - high = efficient |
| **Prompt Reuse Score** | Sessions with >1 cache read / total sessions | Proxy for how often similar prompts are sent |
| **Potential Cache Savings** | Estimated savings if hit rate reached 40% | `((0.40 - currentHitRate) × inputTokens) × (inputRate - cachedRate) / 1M` |

**UI requirements:**
- Cache hit rate gauge on the dashboard header row
- "You saved $X this month via caching" callout
- Daily cache efficiency sparkline in charts tab

---

### 4. Cost-per-Output ROI
*Priority: P1 - helps users understand value per dollar*

| Metric | Description | Formula |
|--------|-------------|---------|
| **Output Tokens per Dollar** | Useful output received per credit spent | `outputTokens / estimatedCost` |
| **Input Efficiency Ratio** | Output tokens per input token | `outputTokens / inputTokens` - high = efficient prompts |
| **Thinking Token Overhead** | Thinking tokens as % of total (cost with no direct output) | `thinkingTokens / totalTokens × 100` |
| **Cost per Session** | Average cost of a single session | `estimatedCost / sessions` |
| **Cost per Interaction** | Average cost of a single request-response | `estimatedCost / interactions` |
| **Highest-Cost Model** | Model consuming the most credit this month | Max by `modelBreakdown[model] × modelRate` |
| **Model Cost Comparison** | Side-by-side cost for same token volume across models | Table: model → cost per 1M tokens → user's actual spend |

---

### 5. Cross-Provider ROI & Switching Analysis
*Priority: P1 - helps teams choose the right tool for each task*

| Metric | Description | Notes |
|--------|-------------|-------|
| **Cost per Provider** | Total MTD spend broken down by Copilot / Claude Code / Antigravity | Already tracked; needs explicit MTD slice |
| **Output-per-Dollar by Provider** | Which provider delivers more output tokens per dollar | `outputTokens / estimatedCost` per provider |
| **Model Substitution Savings** | Estimated savings if premium model switched to cheaper equivalent | Needs model mapping table (e.g., claude-opus → claude-sonnet delta) |
| **Provider Overlap Score** | Days where >1 provider is used (potential redundancy) | Count of days with `providerCount > 1` |
| **Cheapest Provider for Task Type** | For agent vs. chat, which provider is cheapest per output token | Grouped by `modeBreakdown` + cost |
| **Plan Break-Even Analysis** | At what monthly spend does upgrading plans save money? | `proPrice + overage vs. proPlusPrice` crossover |

---

### 6. Anomaly & Risk Detection
*Priority: P1 - prevents surprise bills; critical for enterprise controls*

| Metric | Description | Threshold |
|--------|-------------|-----------|
| **Usage Anomaly Score** | Z-score of today's spend vs. 30-day daily average | Flag if Z > 2.0 (spending 2σ above normal) |
| **Runaway Session Flag** | Sessions exceeding configurable token or cost limit | Default: >100K tokens or >$1.00 per session |
| **Daily Spend Spike** | Days where spend >2× the 30-day average | Visual highlight in daily chart |
| **Consecutive High-Use Days** | Streak of days above 80% of daily-budget pace | Alert if ≥3 consecutive days |
| **Budget Burn Acceleration** | Is burn rate increasing week-over-week? | `week2BurnRate / week1BurnRate > 1.2` = accelerating |
| **First Overage Warning** | First session that would exceed monthly credit budget | Real-time flag when `mtdSpend + sessionCost > planBudget` |

**UI requirements:**
- Warning banner on dashboard when anomaly detected
- Badge on extension status bar when overage risk >80%
- Configurable thresholds in settings: `aiInsights.alertThresholds`

---

### 7. Session Depth & Complexity Drivers
*Priority: P1 - explains what is driving costs*

| Metric | Description | Formula |
|--------|-------------|---------|
| **Average Session Depth** | Mean interactions per session | `totalInteractions / totalSessions` |
| **Session Complexity Score** | Weighted: depth × tool calls × thinking token ratio | Composite; normalised 0–100 |
| **Long Sessions (>30 min)** | Count and cost of sessions >30 minutes | Filter sessions by `endTime - startTime > 30min` |
| **Tool-Heavy Sessions** | Sessions with >5 tool calls (agentic deep-dives) | Filter `session.toolCallCount > 5` |
| **Context Window Pressure** | Sessions where inputTokens >50K (approaching limits) | Flag sessions near context limits |
| **Thinking Token Sessions** | Sessions using extended thinking - higher cost | Sessions where `thinkingTokens > 0` |
| **Multi-Model Sessions** | Sessions that switched models mid-session | `session.models.length > 1` |

---

### 8. Forecast & Planning
*Priority: P1 - critical for budget planning at individual and team level*

| Metric | Description | Formula |
|--------|-------------|---------|
| **Month-End Spend Forecast** | Extrapolated total for current billing month | `mtdSpend / daysElapsed × daysInMonth` |
| **Annual Spend Projection** | Full-year projection from last 30 days | `last30DayCost × 12.17` (already computed, surface explicitly) |
| **Plan Efficiency Score** | % of plan credits actually used last month | `lastMonthCost / planBudget × 100` |
| **Upgrade Break-Even Point** | Monthly spend at which next plan tier saves money | Requires plan tier config; compare `plan + overage vs. nextPlan` |
| **Team Cost Multiplier** | If N users have this profile, projected team spend | `userSpend × teamSize` (user-configured `aiInsights.teamSize`) |
| **Savings from Optimisation** | Delta if user improved cache hit rate + reduced thinking tokens | Scenario modelling: current vs. optimised |

---

### 9. Workspace & Repository Cost Attribution
*Priority: P2 - high value for enterprise cost-center billing*

| Metric | Description | Notes |
|--------|-------------|-------|
| **Cost per Repository** | Credit spend attributed to each workspace/project | Group `repositories` breakdown by cost |
| **Most Expensive Project** | Top-3 repos by MTD credit consumption | Already have repo token data; add cost calc |
| **Repository Trend** | Week-over-week cost change per repo | Compare last 7d vs prior 7d per repo |
| **Idle Workspace Cost** | Repos with sessions but minimal output (high input, low output) | `inputTokens / outputTokens > 20` per repo |
| **Cross-Repo Session Count** | Sessions touching multiple repos (multi-project agents) | Detect via `session.workspace` changes within time window |

---

### 10. Productivity & Quality Proxies
*Priority: P2 - harder to measure but differentiates the extension*

| Metric | Description | Notes |
|--------|-------------|-------|
| **Code Generation Rate** | Output tokens per hour of active session time | `outputTokens / activeHours` |
| **Context-to-Output Efficiency** | How much code is generated per unit of context provided | `outputTokens / inputTokens` - complements Input Efficiency Ratio |
| **Tool Success Proxy** | Ratio of tool-calling sessions vs. pure-chat (agentic adoption) | `agentSessions / totalSessions` |
| **Repeat Prompt Indicator** | Sessions in same repo within 30 min (likely iteration) | Detect by repo + time proximity |
| **Session Value Score** | Composite of output tokens + tools used + session length | Weighted composite; normalise 0–100 |
| **AI Dependency Index** | Sessions per working day (daily AI engagement) | `sessions / activeDaysLast30` |

---

## Implementation priority

| Priority | Category | Effort | Impact |
|----------|----------|--------|--------|
| P0 | Credit Budget Management | Medium | Critical - prevents bill shock |
| P0 | Billable vs. Free Tracking | Medium | Critical - Copilot completion events |
| P1 | Cache Efficiency | Low | High - cache data already collected |
| P1 | Cost-per-Output ROI | Low | High - derived from existing data |
| P1 | Anomaly & Risk Detection | Medium | High - enterprise safety net |
| P1 | Session Depth & Complexity | Low | Medium - existing session data |
| P1 | Forecast & Planning | Low | High - simple extrapolation |
| P1 | Cross-Provider ROI | Low | Medium - comparison view |
| P2 | Workspace Cost Attribution | Low | Medium - existing repo data |
| P2 | Productivity & Quality Proxies | High | Medium - needs new data signals |

---

## New settings required

```jsonc
// .vscode/settings.json or user settings
{
  // Copilot plan budget (USD/month) for budget tracking
  "aiInsights.copilotPlanBudget": 10,

  // Team size multiplier for cost forecasting
  "aiInsights.teamSize": 1,

  // Alert thresholds
  "aiInsights.alertThresholds": {
    "budgetWarningPct": 80,         // % of budget → amber warning
    "budgetCriticalPct": 95,        // % of budget → red alert
    "runawaySessionTokens": 100000, // tokens per session → flag
    "runawaySessionCost": 1.00      // USD per session → flag
  }
}
```

---

## New data signals needed

Some P0/P1 metrics require data not currently collected:

| Signal | Source | Collection method |
|--------|--------|-------------------|
| Code completion events | VS Code `onDidAcceptCompletionItem` API | Hook in `extension.ts` activation |
| Session wall-clock duration | `session.endTime - session.startTime` | Already available; expose in aggregation |
| Per-day cost by model | `dailyUsage[i].models` + pricing lookup | Cost calc on existing daily model breakdown |
| Current billing month start | UTC date math | `new Date(year, month, 1)` |
| Plan budget config | User settings | New `aiInsights.copilotPlanBudget` setting |

---

## Dashboard layout recommendation

```
┌─────────────────────────────────────────────────────────────┐
│  BUDGET HEALTH  [████████░░] 76% · $7.60 / $10.00           │
│  14 days left at current pace · Projected: $12.40 ⚠          │
├──────────────┬──────────────┬────────────────┬──────────────┤
│ Today        │ This Month   │ Cache Saved    │ vs. Last Mo  │
│ $0.43        │ $7.60        │ $1.20 (18%)    │ ▲ +12%       │
└──────────────┴──────────────┴────────────────┴──────────────┘
```

---

## Related wiki files

- [core/costEstimation.md](../core/costEstimation.md) - pricing engine
- [core/sessionAggregator.md](../core/sessionAggregator.md) - aggregation pipeline
- [providers/copilot.md](../providers/copilot.md) - Copilot data source
- [architecture.md](../architecture.md) - system overview
