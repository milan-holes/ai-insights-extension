import { designTokensCss, baseResetCss } from '../webview/designSystem';

document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = `${designTokensCss()}${baseResetCss()}
    .loading-banner{padding:16px 24px;border-bottom:1px solid var(--border);color:var(--text-secondary)}
    .loading-bar{height:3px;background:var(--primary-glow);overflow:hidden}
    .loading-bar::after{content:'';display:block;width:40%;height:100%;background:var(--primary);animation:scan 1.4s infinite}
    @keyframes scan{from{transform:translateX(-100%)}to{transform:translateX(350%)}}
    @media(prefers-reduced-motion:reduce){.loading-bar::after{animation:none}}`;
  document.head.appendChild(style);
  document.getElementById('app')!.innerHTML = '<div class="loading-bar"></div><div class="loading-banner">Loading AI Insights...</div>';
});
