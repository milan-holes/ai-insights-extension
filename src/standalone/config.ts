import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregationConfig, AlertThresholds, ProviderId } from '../types';
import { CopilotCacheConvention } from '../providers/copilot';

export interface StandaloneProviderConfig {
  enabled: boolean;
  additionalSessionPaths: string[];
}

export interface StandaloneClaudeConfig extends StandaloneProviderConfig {
  readLiveQuota: boolean;
}

export interface StandaloneCopilotConfig extends StandaloneProviderConfig {
  inputTokenMultiplier: number;
  cacheEstimationEnabled: boolean;
  cacheEstimationConvention: CopilotCacheConvention;
  maxSessionSnapshots: number;
}

export interface StandaloneConfig {
  sessionLookbackDays: number;
  copilotPlanBudget: number;
  teamSize: number;
  alertThresholds: AlertThresholds;
  providers: {
    copilot: StandaloneCopilotConfig;
    antigravity: StandaloneProviderConfig;
    claudeCode: StandaloneClaudeConfig;
    codex: StandaloneProviderConfig;
    jetbrainsAI: StandaloneProviderConfig;
    visualStudio: StandaloneProviderConfig;
  };
}

export const STANDALONE_PROVIDER_IDS: ProviderId[] = [
  'copilot',
  'antigravity',
  'claudeCode',
  'codex',
  'jetbrainsAI',
  'visualStudio',
];

export const DEFAULT_STANDALONE_CONFIG: StandaloneConfig = {
  sessionLookbackDays: 400,
  copilotPlanBudget: 10,
  teamSize: 1,
  alertThresholds: {
    budgetWarningPct: 80,
    budgetCriticalPct: 95,
    runawaySessionTokens: 100_000,
    runawaySessionCostUsd: 1,
  },
  providers: {
    copilot: {
      enabled: true,
      additionalSessionPaths: [],
      inputTokenMultiplier: 1,
      cacheEstimationEnabled: true,
      cacheEstimationConvention: 'inclusive',
      maxSessionSnapshots: 2000,
    },
    antigravity: { enabled: true, additionalSessionPaths: [] },
    claudeCode: { enabled: true, additionalSessionPaths: [], readLiveQuota: false },
    codex: { enabled: true, additionalSessionPaths: [] },
    jetbrainsAI: { enabled: true, additionalSessionPaths: [] },
    visualStudio: { enabled: true, additionalSessionPaths: [] },
  },
};

export function standaloneStorageDir(appName = 'ai-insights'): string {
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

export function configFilePath(storageDir: string): string {
  return path.join(storageDir, 'standalone-config.json');
}

export function loadStandaloneConfig(storageDir: string): StandaloneConfig {
  try {
    const raw = fs.readFileSync(configFilePath(storageDir), 'utf-8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig({});
  }
}

export function saveStandaloneConfig(storageDir: string, config: StandaloneConfig): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(configFilePath(storageDir), JSON.stringify(normalizeConfig(config), null, 2), 'utf-8');
}

export function aggregationConfig(config: StandaloneConfig): AggregationConfig {
  return {
    planBudget: config.copilotPlanBudget,
    teamSize: config.teamSize,
    alertThresholds: config.alertThresholds,
  };
}

function normalizeConfig(value: unknown): StandaloneConfig {
  const input = isRecord(value) ? value : {};
  const providers = isRecord(input.providers) ? input.providers : {};
  const defaults = DEFAULT_STANDALONE_CONFIG;

  return {
    sessionLookbackDays: positiveNumber(input.sessionLookbackDays, defaults.sessionLookbackDays),
    copilotPlanBudget: positiveNumber(input.copilotPlanBudget, defaults.copilotPlanBudget),
    teamSize: positiveNumber(input.teamSize, defaults.teamSize),
    alertThresholds: {
      budgetWarningPct: positiveNumber(
        isRecord(input.alertThresholds) ? input.alertThresholds.budgetWarningPct : undefined,
        defaults.alertThresholds.budgetWarningPct,
      ),
      budgetCriticalPct: positiveNumber(
        isRecord(input.alertThresholds) ? input.alertThresholds.budgetCriticalPct : undefined,
        defaults.alertThresholds.budgetCriticalPct,
      ),
      runawaySessionTokens: positiveNumber(
        isRecord(input.alertThresholds) ? input.alertThresholds.runawaySessionTokens : undefined,
        defaults.alertThresholds.runawaySessionTokens,
      ),
      runawaySessionCostUsd: positiveNumber(
        isRecord(input.alertThresholds) ? input.alertThresholds.runawaySessionCostUsd : undefined,
        defaults.alertThresholds.runawaySessionCostUsd,
      ),
    },
    providers: {
      copilot: normalizeCopilotProvider(providers.copilot, defaults.providers.copilot),
      antigravity: normalizeProvider(providers.antigravity, defaults.providers.antigravity),
      claudeCode: {
        ...normalizeProvider(providers.claudeCode, defaults.providers.claudeCode),
        readLiveQuota: booleanValue(isRecord(providers.claudeCode) ? providers.claudeCode.readLiveQuota : undefined, false),
      },
      codex: normalizeProvider(providers.codex, defaults.providers.codex),
      jetbrainsAI: normalizeProvider(providers.jetbrainsAI, defaults.providers.jetbrainsAI),
      visualStudio: normalizeProvider(providers.visualStudio, defaults.providers.visualStudio),
    },
  };
}

function normalizeCopilotProvider(value: unknown, defaults: StandaloneCopilotConfig): StandaloneCopilotConfig {
  const base = normalizeProvider(value, defaults);
  const input = isRecord(value) ? value : {};
  const convention = input.cacheEstimationConvention === 'exclusive' ? 'exclusive' : defaults.cacheEstimationConvention;
  return {
    ...base,
    inputTokenMultiplier: positiveNumber(input.inputTokenMultiplier, defaults.inputTokenMultiplier),
    cacheEstimationEnabled: booleanValue(input.cacheEstimationEnabled, defaults.cacheEstimationEnabled),
    cacheEstimationConvention: convention,
    maxSessionSnapshots: positiveNumber(input.maxSessionSnapshots, defaults.maxSessionSnapshots),
  };
}

function normalizeProvider(value: unknown, defaults: StandaloneProviderConfig): StandaloneProviderConfig {
  const input = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(input.enabled, defaults.enabled),
    additionalSessionPaths: stringArray(input.additionalSessionPaths),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
