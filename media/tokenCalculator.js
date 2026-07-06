// @ts-check
;(function () {
  const vscode = acquireVsCodeApi()

  /** @type {Record<string, {displayName:string,provider:string,copilotOfficial:boolean,inputCostPerMillion:number,outputCostPerMillion:number,cachedInputCostPerMillion?:number,cacheCreationCostPerMillion?:number,category:string}>} */
  const PRICING = (typeof window !== 'undefined' && window.TC_PRICING) ? window.TC_PRICING : {}

  const CHARS_PER_TOKEN = 3.5
  const USD_PER_CREDIT  = 0.01

  // Different providers use different tokenizers - approximate chars/token per family
  const CHARS_PER_TOKEN_BY_PROVIDER = {
    anthropic: 3.5,  // Claude tokenizer
    openai:    4.0,  // tiktoken cl100k_base / o200k_base
    google:    3.8,  // Gemini SentencePiece
    xai:       4.0,  // Grok (tiktoken-compatible)
  }

  const CONTEXT_WINDOWS = {
    'claude-haiku-4.5':  200_000, 'claude-sonnet-4':   200_000,
    'claude-sonnet-4.5': 200_000, 'claude-sonnet-4.6': 200_000,
    'claude-opus-4.5':   200_000, 'claude-opus-4.6':   200_000, 'claude-opus-4.7': 200_000,
    'gpt-4.1':           1_048_576,
    'gpt-5-mini':        128_000, 'gpt-5.2':      128_000, 'gpt-5.2-codex': 128_000,
    'gpt-5.3-codex':     128_000, 'gpt-5.4':      128_000, 'gpt-5.4-mini':  128_000,
    'gpt-5.4-nano':      128_000, 'gpt-5.5':      128_000,
    'gemini-2.5-pro':    1_048_576, 'gemini-3-flash': 1_048_576, 'gemini-3.1-pro': 1_048_576,
    'grok-code-fast-1':  131_072,
  }
  const DEFAULT_CONTEXT = 128_000

  /** @type {Map<string, string>} path -> content */
  const fileContents = new Map()
  /** @type {Set<string>} */
  const selectedPaths = new Set()
  /** @type {Array<{path: string}>} */
  let allFiles = []

  // TreeNode: { name:string, path:string, children:Map<string,TreeNode>, files:string[] }
  /** @type {{name:string,path:string,children:Map<any,any>,files:string[]}|null} */
  let treeRoot = null
  /** @type {Set<string>} collapsed folder paths */
  const collapsedFolders = new Set()

  let addingAll      = false
  let addAllPending  = 0
  let addingOpen     = false
  let activeProvider = 'copilot'

  const elSearch        = /** @type {HTMLInputElement}    */ (document.getElementById('file-search'))
  const elFileList      = /** @type {HTMLDivElement}      */ (document.getElementById('file-list'))
  const elPrompt        = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'))
  const elPromptQuality = /** @type {HTMLDivElement}      */ (document.getElementById('prompt-quality'))
  const elBtnOpenFiles  = /** @type {HTMLButtonElement}   */ (document.getElementById('btn-open-files'))
  const elBtnAddAll     = /** @type {HTMLButtonElement}   */ (document.getElementById('btn-add-all'))
  const elBtnClear      = /** @type {HTMLButtonElement}   */ (document.getElementById('btn-clear'))
  const elModelList     = /** @type {HTMLDivElement}      */ (document.getElementById('tc-model-list'))

  // ── Utilities ────────────────────────────────────────────

  function estimateTokens(text) { return Math.round(text.length / CHARS_PER_TOKEN) }

  function fmtTokens(n) {
    if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000)     return `~${(n / 1_000).toFixed(1)}K`
    return `~${n}`
  }

  function fmtTok(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  function fmtCtx(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function getFileChars() {
    let chars = 0
    for (const p of selectedPaths) { const c = fileContents.get(p); if (c) chars += c.length }
    return chars
  }

  function getTotalChars() {
    let chars = 0
    for (const p of selectedPaths) { const c = fileContents.get(p); if (c) chars += c.length }
    chars += elPrompt.value.length
    return chars
  }

  // ── Tree ─────────────────────────────────────────────────

  function buildTree(files) {
    const root = { name: '', path: '', children: new Map(), files: [] }
    for (const f of files) {
      const parts = f.path.split('/')
      let node = root
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]
        if (!node.children.has(seg)) {
          node.children.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), children: new Map(), files: [] })
        }
        node = node.children.get(seg)
      }
      node.files.push(f.path)
    }
    return root
  }

  function findNode(root, path) {
    if (!path) return root
    let node = root
    for (const seg of path.split('/')) {
      node = node.children.get(seg)
      if (!node) return null
    }
    return node
  }

  function getSubtreeFiles(node) {
    const out = [...node.files]
    for (const child of node.children.values()) out.push(...getSubtreeFiles(child))
    return out
  }

  /** @returns {'none'|'some'|'all'} */
  function getFolderState(node) {
    const files = getSubtreeFiles(node)
    if (!files.length) return 'none'
    const n = files.filter(f => selectedPaths.has(f)).length
    return n === 0 ? 'none' : n === files.length ? 'all' : 'some'
  }

  function renderTreeNode(node, depth) {
    let html = ''
    const guides = Array.from({length: depth}, () => '<span class="tc-guide"></span>').join('')
    const dirs   = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const files  = [...node.files].sort((a, b) => {
      const na = a.split('/').pop() || ''; const nb = b.split('/').pop() || ''
      return na.localeCompare(nb)
    })

    for (const dir of dirs) {
      const collapsed   = collapsedFolders.has(dir.path)
      const state       = getFolderState(dir)
      const checkedAttr = state === 'all'  ? ' checked' : ''
      const indetAttr   = state === 'some' ? ' data-indet' : ''
      html += `<div class="tc-tree-row tc-tree-dir" data-path="${escHtml(dir.path)}">
        ${guides}<span class="tc-tree-arrow${collapsed ? '' : ' open'}">&#x203A;</span>
        <input type="checkbox" class="tc-dir-cb" data-path="${escHtml(dir.path)}"${checkedAttr}${indetAttr}>
        <span class="tc-dir-name">${escHtml(dir.name)}</span>
      </div>`
      if (!collapsed) html += renderTreeNode(dir, depth + 1)
    }

    for (const filePath of files) {
      const name    = filePath.split('/').pop() || filePath
      const checked = selectedPaths.has(filePath)
      const tok     = fileContents.has(filePath) ? estimateTokens(fileContents.get(filePath) || '') : null
      html += `<div class="tc-tree-row tc-tree-file${checked ? ' tc-sel' : ''}" data-path="${escHtml(filePath)}">
        ${guides}<span class="tc-file-gap"></span>
        <input type="checkbox" class="tc-file-cb" data-path="${escHtml(filePath)}"${checked ? ' checked' : ''}>
        <span class="tc-file-name" title="${escHtml(filePath)}">${escHtml(name)}</span>
        <span class="tc-file-tokens">${tok !== null ? fmtTokens(tok) : ''}</span>
      </div>`
    }
    return html
  }

  function renderFlatFile(filePath) {
    const checked = selectedPaths.has(filePath)
    const tok     = fileContents.has(filePath) ? estimateTokens(fileContents.get(filePath) || '') : null
    return `<div class="tc-tree-row tc-tree-file${checked ? ' tc-sel' : ''}" data-path="${escHtml(filePath)}" style="padding-left:8px">
      <input type="checkbox" class="tc-file-cb" data-path="${escHtml(filePath)}"${checked ? ' checked' : ''}>
      <span class="tc-file-name" title="${escHtml(filePath)}">${escHtml(filePath)}</span>
      <span class="tc-file-tokens">${tok !== null ? fmtTokens(tok) : ''}</span>
    </div>`
  }

  function renderFileList() {
    if (!treeRoot) { elFileList.innerHTML = '<div class="tc-empty">Loading files...</div>'; return }

    const query     = elSearch.value.toLowerCase().trim()
    const scrollTop = elFileList.scrollTop

    if (query) {
      const matches = allFiles.filter(f => f.path.toLowerCase().includes(query))
      elFileList.innerHTML = matches.length
        ? matches.map(f => renderFlatFile(f.path)).join('')
        : '<div class="tc-empty">No files match search.</div>'
    } else {
      const html = renderTreeNode(treeRoot, 0)
      elFileList.innerHTML = html || '<div class="tc-empty">No text files found in workspace.</div>'
      elFileList.querySelectorAll('[data-indet]').forEach(cb => { /** @type {HTMLInputElement} */ (cb).indeterminate = true })
    }

    elFileList.scrollTop = scrollTop
  }

  function refreshRowBadge(filePath) {
    const row = elFileList.querySelector(`.tc-tree-file[data-path="${CSS.escape(filePath)}"]`)
    if (!row) return
    const badge = row.querySelector('.tc-file-tokens')
    if (badge) badge.textContent = fmtTokens(estimateTokens(fileContents.get(filePath) || ''))
  }

  // ── File/folder toggle handlers ───────────────────────────

  function handleFileToggle(filePath, checked) {
    if (!filePath) return
    if (checked) {
      selectedPaths.add(filePath)
      if (!fileContents.has(filePath)) vscode.postMessage({ type: 'get_file', path: filePath })
    } else {
      selectedPaths.delete(filePath)
    }
    renderFileList()
    updateStats()
  }

  function handleFolderToggle(folderPath, shouldSelect) {
    if (!treeRoot || !folderPath) return
    const node = findNode(treeRoot, folderPath)
    if (!node) return
    const files = getSubtreeFiles(node)
    for (const f of files) {
      if (shouldSelect) {
        selectedPaths.add(f)
        if (!fileContents.has(f)) vscode.postMessage({ type: 'get_file', path: f })
      } else {
        selectedPaths.delete(f)
      }
    }
    renderFileList()
    updateStats()
  }

  // ── Models ────────────────────────────────────────────────

  function getModelsForProvider(provider) {
    return Object.entries(PRICING)
      .filter(([, m]) => {
        if (provider === 'copilot')   return m.copilotOfficial === true
        if (provider === 'anthropic') return m.provider === 'anthropic' && m.category !== 'Legacy'
        if (provider === 'openai')    return m.provider === 'openai'    && m.category !== 'Legacy'
        if (provider === 'google')    return m.provider === 'google'    && m.category !== 'Legacy'
        return false
      })
      .sort(([, a], [, b]) => a.inputCostPerMillion - b.inputCostPerMillion)
  }

  function renderModels() {
    if (!elModelList) return
    const fileChars   = getFileChars()
    const promptChars = elPrompt.value.length
    const isCopilot   = activeProvider === 'copilot'
    const models      = getModelsForProvider(activeProvider)
    elModelList.classList.toggle('has-credits', isCopilot)

    if (!models.length) { elModelList.innerHTML = '<div class="tc-empty">No models available.</div>'; return }

    const header = `<div class="tc-col-header${isCopilot ? ' has-credits' : ''}">
      <span class="tc-col-lbl">Model</span>
      <span class="tc-col-lbl">Context</span>
      <span class="tc-col-lbl">~Tokens</span>
      ${isCopilot ? '<span class="tc-col-lbl">Credits</span>' : ''}
      <span class="tc-col-lbl">Input cost</span>
    </div>`

    const rows = models.map(([id, m]) => {
      const ctx        = CONTEXT_WINDOWS[id] || DEFAULT_CONTEXT
      const cpt        = CHARS_PER_TOKEN_BY_PROVIDER[m.provider] || CHARS_PER_TOKEN
      const fileToks   = Math.round(fileChars / cpt)
      const promptToks = Math.round(promptChars / cpt)
      const tokens     = fileToks + promptToks
      const rawPct     = (tokens / ctx) * 100
      const barPct     = Math.min(rawPct, 100)
      const usdCost    = (tokens / 1_000_000) * m.inputCostPerMillion
      const fillColor = rawPct < 50 ? 'var(--primary)' : rawPct < 75 ? 'var(--stage-3)' : rawPct < 90 ? 'var(--stage-2)' : 'var(--stage-1)'
      const track     = 'rgba(255,255,255,0.08)'
      const fillPct   = tokens > 0 ? Math.max(barPct, 1.5) : 0
      const barBg     = fillPct === 0
        ? track
        : `linear-gradient(to right,${fillColor} ${fillPct.toFixed(1)}%,${track} ${fillPct.toFixed(1)}%)`
      const ctxCls  = tokens === 0 ? 'tc-ctx-zero' : rawPct < 70 ? 'tc-ctx-ok' : rawPct < 90 ? 'tc-ctx-warn' : 'tc-ctx-crit'
      const pctStr  = rawPct > 999 ? '>999%' : `${rawPct.toFixed(rawPct < 100 ? 1 : 0)}%`
      const credits = isCopilot ? `<span class="tc-model-credits">${(usdCost / USD_PER_CREDIT).toFixed(2)} cr</span>` : ''

      const detailParts = []
      if (fileChars > 0)   detailParts.push(`<span>f ${fmtTok(fileToks)}</span>`)
      if (promptChars > 0) detailParts.push(`<span>p ${fmtTok(promptToks)}</span>`)
      const detail = detailParts.length ? `<div class="tc-tok-detail">${detailParts.join('')}</div>` : ''

      return `<div class="tc-model">
        <span class="tc-model-name" title="${escHtml(id)} · ${fmtCtx(ctx)} ctx · ~${cpt} chars/tok">${escHtml(m.displayName)}</span>
        <div class="tc-ctx-cell">
          <div class="tc-bar-wrap" style="background:${barBg}"></div>
          <span class="tc-ctx-pct ${ctxCls}">${pctStr}</span>
        </div>
        <div class="tc-tok-cell">
          <span class="tc-tok-total">${fmtTokens(tokens)}</span>
          ${detail}
        </div>
        ${credits}
        <span class="tc-model-cost">$${usdCost.toFixed(4)}</span>
      </div>`
    }).join('')

    elModelList.innerHTML = header + rows
  }

  // ── Prompt quality ────────────────────────────────────────

  function analyzePrompt(text) {
    const trimmed = text.trim()
    if (!trimmed) return null
    const words = trimmed.split(/\s+/)
    const wc    = words.length
    const lc    = trimmed.toLowerCase()
    const issues = [], goods = []
    let score = 0

    if (wc < 5)        { issues.push('too short'); score -= 3 }
    else if (wc < 15)  { issues.push('add more context'); score -= 1 }
    else if (wc > 600) { issues.push('very long - split tasks'); score -= 1 }
    else               { score += 1 }

    if (/^(create|build|add|fix|update|refactor|implement|write|generate|explain|show|find|check|make|remove|delete|convert|help|analyze|review|summarize|list|test)\b/i.test(trimmed) || trimmed.includes('?')) {
      goods.push('clear ask'); score += 1
    } else {
      issues.push('unclear ask')
    }

    if (['something', 'stuff', 'things', 'do this', 'fix this', 'make it', 'that thing', 'make work', 'it works'].filter(t => lc.includes(t)).length >= 2) {
      issues.push('vague language'); score -= 2
    }

    if (/`[^`]+`|\b\w+\.\w+\(|\b\w+\(\)/.test(trimmed)) { goods.push('references code'); score += 2 }

    if ((lc.match(/\b(also|additionally|and then|another thing)\b/g) || []).length >= 2) {
      issues.push('multiple tasks - split up'); score -= 1
    }

    if (selectedPaths.size > 0) {
      goods.push(`${selectedPaths.size} file${selectedPaths.size > 1 ? 's' : ''} added`)
    } else if (/\bfile\b|\bcode\b|\bfunction\b|\bclass\b/.test(lc)) {
      issues.push('no files added'); score -= 1
    }

    const grade = score >= 3 ? 'good' : score >= 1 ? 'fair' : score >= -1 ? 'weak' : 'poor'
    return { grade, issues, goods }
  }

  function updatePromptQuality() {
    if (!elPromptQuality) return
    const result = analyzePrompt(elPrompt.value)
    if (!result) { elPromptQuality.innerHTML = ''; return }
    const { grade, issues, goods } = result
    const label = { good: 'Good', fair: 'Fair', weak: 'Weak', poor: 'Vague' }[grade]
    const all   = [...goods, ...issues].slice(0, 4)
    elPromptQuality.innerHTML =
      `<span class="tc-pq-dot pq-${grade}"></span>` +
      `<span class="tc-pq-label pq-${grade}">${label}</span>` +
      (all.length ? `<span class="tc-pq-sep">·</span><span class="tc-pq-tips">${escHtml(all.join(' · '))}</span>` : '')
  }

  function updateStats() {
    renderModels()
    updatePromptQuality()
  }

  // ── Event delegation on file list ─────────────────────────

  elFileList.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target)

    // Dir row (not checkbox): toggle collapse
    const dirRow = target.closest('.tc-tree-dir')
    if (dirRow && !target.classList.contains('tc-dir-cb')) {
      const p = /** @type {HTMLElement} */ (dirRow).dataset.path || ''
      if (collapsedFolders.has(p)) collapsedFolders.delete(p)
      else collapsedFolders.add(p)
      renderFileList()
      return
    }

    // File row (not checkbox): toggle checkbox
    const fileRow = target.closest('.tc-tree-file')
    if (fileRow && !target.classList.contains('tc-file-cb')) {
      const cb = /** @type {HTMLInputElement|null} */ (fileRow.querySelector('.tc-file-cb'))
      if (cb) { cb.checked = !cb.checked; handleFileToggle(/** @type {HTMLElement} */(fileRow).dataset.path || '', cb.checked) }
    }
  })

  elFileList.addEventListener('change', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target)
    if (target.classList.contains('tc-file-cb'))
      handleFileToggle(target.dataset.path || '', target.checked)
    else if (target.classList.contains('tc-dir-cb'))
      handleFolderToggle(target.dataset.path || '', target.checked)
  })

  // ── Static listeners ──────────────────────────────────────

  elSearch.addEventListener('input', renderFileList)

  elBtnOpenFiles.addEventListener('click', () => {
    if (addingOpen) return
    addingOpen = true
    elBtnOpenFiles.disabled = true
    elBtnOpenFiles.textContent = 'Loading...'
    vscode.postMessage({ type: 'get_open_files' })
  })

  elBtnAddAll.addEventListener('click', () => {
    if (addingAll) return
    addingAll = true
    elBtnAddAll.disabled = true
    elBtnAddAll.textContent = 'Loading...'
    vscode.postMessage({ type: 'get_all_files' })
  })

  elBtnClear.addEventListener('click', () => {
    selectedPaths.clear()
    renderFileList()
    updateStats()
  })

  elPrompt.addEventListener('input', updateStats)

  document.querySelectorAll('.tc-sw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tc-sw-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeProvider = /** @type {HTMLElement} */ (btn).dataset.provider || 'copilot'
      renderModels()
    })
  })

  // ── Extension messages ────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data

    if (msg.type === 'file_list') {
      allFiles = msg.files
      treeRoot = buildTree(allFiles)
      renderFileList()
      updateStats()
    }

    else if (msg.type === 'file_content') {
      fileContents.set(msg.path, msg.content)
      refreshRowBadge(msg.path)
      if (selectedPaths.has(msg.path)) updateStats()

      if (addingAll || addingOpen) {
        selectedPaths.add(msg.path)
        const row = elFileList.querySelector(`.tc-tree-file[data-path="${CSS.escape(msg.path)}"]`)
        if (row) {
          row.classList.add('tc-sel')
          const cb = /** @type {HTMLInputElement|null} */ (row.querySelector('.tc-file-cb'))
          if (cb) cb.checked = true
        }
        if (addingAll) addAllPending = Math.max(0, addAllPending - 1)
        updateStats()
      }
    }

    else if (msg.type === 'all_files_start') {
      addAllPending = msg.total
      for (const f of allFiles) selectedPaths.add(f.path)
      renderFileList()
    }

    else if (msg.type === 'all_files_done') {
      addingAll = false
      addAllPending = 0
      elBtnAddAll.disabled = false
      elBtnAddAll.textContent = 'Add all'
      updateStats()
    }

    else if (msg.type === 'open_files_start') {
      // content arrives via file_content messages (addingOpen flag routes them)
    }

    else if (msg.type === 'open_files_done') {
      for (const f of (msg.files || [])) selectedPaths.add(f.path)
      addingOpen = false
      elBtnOpenFiles.disabled = false
      const count = (msg.files || []).length
      elBtnOpenFiles.textContent = count ? `Open files (${count})` : 'Open files'
      renderFileList()
      updateStats()
    }
  })

  vscode.postMessage({ type: 'ready' })
})()
