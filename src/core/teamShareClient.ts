import { AggregatedMetrics } from '../types';

export interface TeamShareSnapshot {
  generatedAt: string;
  source: {
    extension: string;
    workspaceName: string;
    machineId: string;
    appName: string;
  };
  metrics: AggregatedMetrics;
}

export interface TeamShareUploadResult {
  dashboardUrl: string;
  snapshotId: string;
  expiresAt?: string;
}

export class TeamShareClient {
  async uploadSnapshot(
    endpointUrl: string,
    githubToken: string,
    snapshot: TeamShareSnapshot,
  ): Promise<TeamShareUploadResult> {
    const baseUrl = endpointUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/snapshots`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(snapshot),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }

    const result = await response.json() as Partial<TeamShareUploadResult>;
    if (!result.dashboardUrl || !result.snapshotId) {
      throw new Error('Team server returned an invalid upload response.');
    }

    return {
      dashboardUrl: result.dashboardUrl,
      snapshotId: result.snapshotId,
      expiresAt: result.expiresAt,
    };
  }
}
