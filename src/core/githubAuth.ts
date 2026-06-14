import * as vscode from 'vscode';

export interface ConnectedGitHubUser {
  login: string;
  planName: string;
  monthlyBudgetUsd: number;
}

interface GitHubUser {
  login: string;
  name: string | null;
  plan?: { name: string };
}

const PLAN_BUDGET: Record<string, number> = {
  free: 0,
  pro: 10,
  team: 19,
  enterprise: 39,
};

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Business',
  enterprise: 'Enterprise',
};

const PLAN_PICKS = [
  { label: 'Free', description: '$0/month - limited completions & chat', plan: 'free' },
  { label: 'Pro', description: '$10/month - unlimited completions, 300 premium requests', plan: 'pro' },
  { label: 'Business', description: '$19/user/month', plan: 'team' },
  { label: 'Enterprise', description: '$39/user/month', plan: 'enterprise' },
];

export async function connectGitHubAndDetectPlan(): Promise<ConnectedGitHubUser | undefined> {
  let session: vscode.AuthenticationSession;
  try {
    // forceNewSession lets the user pick a different account (e.g. org account vs personal).
    session = await vscode.authentication.getSession('github', ['read:user'], { forceNewSession: true });
  } catch {
    vscode.window.showErrorMessage('AI Insights: GitHub sign-in was cancelled or failed.');
    return undefined;
  }

  let user: GitHubUser;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AI-Insights-VSCode-Extension',
      },
    });
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    user = await res.json() as GitHubUser;
  } catch (err) {
    vscode.window.showErrorMessage(`AI Insights: Could not reach GitHub API - ${err}`);
    return undefined;
  }

  let planName: string;

  if (user.plan?.name) {
    planName = user.plan.name.toLowerCase();
  } else {
    // plan field requires elevated OAuth scope - fall back to manual pick
    const picked = await vscode.window.showQuickPick(
      PLAN_PICKS,
      { title: `Connected as @${user.login} - Select your Copilot plan` },
    );
    if (!picked) { return undefined; }
    planName = (picked as typeof PLAN_PICKS[0]).plan;
  }

  const budget = PLAN_BUDGET[planName] ?? 10;
  const label = PLAN_LABELS[planName] ?? planName;

  const config = vscode.workspace.getConfiguration('aiInsights');
  await config.update('copilotPlanBudget', budget, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `AI Insights: Connected as @${user.login} (GitHub ${label}). Budget set to $${budget}/month.`,
  );

  return { login: user.login, planName, monthlyBudgetUsd: budget };
}

export async function getGitHubAccessToken(options: { forceNewSession?: boolean } = {}): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['read:user'],
      { createIfNone: true, forceNewSession: options.forceNewSession ?? false },
    );
    return session.accessToken;
  } catch {
    vscode.window.showErrorMessage('AI Insights: GitHub sign-in is required for team server sharing.');
    return undefined;
  }
}
