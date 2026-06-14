/**
 * Shared design system for all AI Insights webviews.
 *
 * Canonical palette taken from the Replay view (blue-slate dark theme).
 * EVERY webview must include `designTokensCss()` inside its <style> block
 * instead of defining its own `:root` variables, so all views share one
 * background and color scheme. See wiki/design-system.md.
 *
 * A view may override a token AFTER including this block when it has a
 * deliberate brand accent (e.g. Claude account view overrides --primary
 * with Claude orange) — overrides must be additive, never a forked :root.
 */

/** Design tokens: colors, fonts. Paste first inside every view's <style>. */
export function designTokensCss(): string {
  return `:root{
  /* Surfaces (darkest → most elevated) */
  --bg-base:#0f1218;
  --bg-surface:#161b22;
  --bg-surface-high:#1c2230;
  --border:rgba(255,255,255,.08);
  /* Text */
  --text-primary:#e5e2e1;
  --text-secondary:rgba(193,198,215,.55);
  /* Accent */
  --primary:#007AFF;
  --primary-hover:#005ecc;
  --primary-glow:rgba(0,122,255,.2);
  /* Severity / heat ramp (1 = worst … 4 = best) */
  --stage-1:#f38ba8;
  --stage-2:#fab387;
  --stage-3:#f9e2af;
  --stage-4:#39FF14;
  /* Semantic aliases */
  --danger:var(--stage-1);
  --warning:var(--stage-3);
  --success:var(--stage-4);
  --green:var(--stage-4);
  /* Typography */
  --font-primary:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;
  --font-data:'SF Mono','Fira Code','Consolas',monospace;
  --font-mono:var(--font-data);
}`;
}

/** Universal reset + body base shared by all views. Views add layout-specific body rules separately. */
export function baseResetCss(): string {
  return `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg-base);color:var(--text-primary);font-family:var(--font-primary);font-size:13px;}`;
}
