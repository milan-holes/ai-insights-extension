const excludedCommands = new Set([
  'showDiagnostics', 'showSettings', 'showAbTest', 'startSharing', 'stopSharing',
  'updateSetting', 'runAbTest', 'stopAbTest', 'cleanupWorktrees', 'cleanupOrphaned',
]);

export function isExcludedDesktopCommand(command: unknown): boolean {
  return typeof command === 'string' && excludedCommands.has(command.replace(/^aiInsights\./, ''));
}

export const excludedDesktopControls = [
  '[data-nav="showDiagnostics"]', '[data-nav="showAbTest"]',
  '[data-post="startSharing"]', '[data-post="stopSharing"]',
  '#btnShare', '#sharePanel', '#shareHelpModal', '#qrModal',
].join(',');
