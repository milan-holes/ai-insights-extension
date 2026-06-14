import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pricingData from '../data/modelPricing.json'
import { designTokensCss } from './designSystem'

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.cs',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini',
  '.md', '.mdx', '.txt', '.rst',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.gql', '.proto',
])

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.nuxt/**,**/.output/**,**/.data/**,**/*.vsix,**/*.lock,**/package-lock.json,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.ico,**/*.woff,**/*.woff2,**/*.ttf,**/*.eot}'

export class TokenCalculatorProvider {
  static readonly viewType = 'aiInsights.tokenCalculator'
  private static currentPanel: vscode.WebviewPanel | undefined

  static createPanel(context: vscode.ExtensionContext): void {
    if (TokenCalculatorProvider.currentPanel) {
      TokenCalculatorProvider.currentPanel.reveal()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      TokenCalculatorProvider.viewType,
      'Token Calculator',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    )

    const nonce = crypto.randomBytes(16).toString('hex')
    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'tokenCalculator.css'))
    const jsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'tokenCalculator.js'))
    panel.webview.html = TokenCalculatorProvider.buildHTML(nonce, cssUri, jsUri, panel.webview)

    panel.webview.onDidReceiveMessage(
      async (msg: { type: string, path?: string }) => {
        if (!TokenCalculatorProvider.currentPanel) return

        if (msg.type === 'ready') {
          const files = await listWorkspaceFiles()
          panel.webview.postMessage({ type: 'file_list', files })
        }
        else if (msg.type === 'get_file' && msg.path) {
          const content = await readWorkspaceFile(msg.path)
          panel.webview.postMessage({ type: 'file_content', path: msg.path, content })
        }
        else if (msg.type === 'get_all_files') {
          const files = await listWorkspaceFiles()
          panel.webview.postMessage({ type: 'all_files_start', total: files.length })
          for (const file of files) {
            const content = await readWorkspaceFile(file.path)
            panel.webview.postMessage({ type: 'file_content', path: file.path, content })
          }
          panel.webview.postMessage({ type: 'all_files_done' })
        }
        else if (msg.type === 'get_open_files') {
          const openFiles = getOpenEditorFiles()
          panel.webview.postMessage({ type: 'open_files_start', total: openFiles.length })
          for (const file of openFiles) {
            const content = await readWorkspaceFile(file.path)
            panel.webview.postMessage({ type: 'file_content', path: file.path, content })
          }
          panel.webview.postMessage({ type: 'open_files_done', files: openFiles })
        }
      },
      undefined,
      context.subscriptions,
    )

    panel.onDidDispose(() => { TokenCalculatorProvider.currentPanel = undefined }, null, context.subscriptions)
    TokenCalculatorProvider.currentPanel = panel
  }

  private static buildHTML(nonce: string, cssUri: vscode.Uri, jsUri: vscode.Uri, webview: vscode.Webview): string {
    const pricingJson = JSON.stringify(pricingData.pricing)
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style nonce="${nonce}">${designTokensCss()}</style>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div class="tc-header">
  <span class="tc-title">Token Calculator</span>
  <span class="tc-subtitle">Estimate input tokens before sending to an AI provider</span>
</div>
<div class="tc-layout">
  <div class="tc-left">
    <div class="tc-pane-label">Codebase files</div>
    <div class="tc-controls">
      <input id="file-search" type="text" class="tc-search" placeholder="Search files..." autocomplete="off" spellcheck="false">
      <button id="btn-open-files" class="tc-btn tc-btn-open">Open files</button>
      <button id="btn-add-all" class="tc-btn">Add all</button>
      <button id="btn-clear" class="tc-btn">Clear</button>
    </div>
    <div id="file-list" class="tc-file-list">
      <div class="tc-empty">Loading files...</div>
    </div>
  </div>
  <div class="tc-right">
    <div class="tc-pane-label">Prompt</div>
    <textarea id="prompt" class="tc-prompt" placeholder="Paste your prompt or system message here..."></textarea>
    <div id="prompt-quality" class="tc-prompt-quality"></div>

    <div class="tc-pane-label tc-mt">Context window</div>
    <div class="tc-switcher">
      <button class="tc-sw-btn active" data-provider="copilot">GitHub Copilot</button>
      <button class="tc-sw-btn" data-provider="anthropic">Claude</button>
      <button class="tc-sw-btn" data-provider="openai">OpenAI</button>
      <button class="tc-sw-btn" data-provider="google">Google</button>
    </div>
    <div id="tc-model-list" class="tc-model-list"></div>
  </div>
</div>
<script nonce="${nonce}">window.TC_PRICING=${pricingJson};</script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`
  }
}

async function listWorkspaceFiles(): Promise<Array<{ path: string }>> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]
  if (!wsFolder) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uris: any[] = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 10000)
  return uris
    .filter((uri) => {
      const ext = path.extname(uri.fsPath).toLowerCase()
      const base = path.basename(uri.fsPath).toLowerCase()
      return TEXT_EXTENSIONS.has(ext) || base === 'dockerfile' || base === 'makefile'
    })
    .map(uri => ({ path: vscode.workspace.asRelativePath(uri) as string }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function getOpenEditorFiles(): Array<{ path: string }> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]
  if (!wsFolder) return []

  const seen = new Set<string>()
  const result: Array<{ path: string }> = []

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue
      const uri = tab.input.uri
      if (!uri.fsPath.startsWith(wsFolder.uri.fsPath)) continue
      const ext = path.extname(uri.fsPath).toLowerCase()
      const base = path.basename(uri.fsPath).toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext) && base !== 'dockerfile' && base !== 'makefile') continue
      const rel = vscode.workspace.asRelativePath(uri) as string
      if (!seen.has(rel)) {
        seen.add(rel)
        result.push({ path: rel })
      }
    }
  }

  return result
}

async function readWorkspaceFile(relativePath: string): Promise<string> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]
  if (!wsFolder) return ''
  try {
    const uri = vscode.Uri.joinPath(wsFolder.uri, relativePath)
    const bytes = await vscode.workspace.fs.readFile(uri)
    const text = Buffer.from(bytes).toString('utf8')
    return text.length > 500_000 ? `${text.slice(0, 500_000)}\n[...truncated at 500KB]` : text
  }
  catch {
    return ''
  }
}
