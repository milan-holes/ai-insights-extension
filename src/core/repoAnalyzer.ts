import * as fs from 'fs';
import * as path from 'path';

export type Language = 'typescript' | 'javascript' | 'vue' | 'php' | 'python' | 'csharp' | 'vbnet' | 'fsharp';

export interface ModuleInfo {
  filePath: string;
  relativePath: string;
  folder: string;
  rawImports: string[];
  resolvedImports: string[];
  exports: string[];
  linesOfCode: number;
  language: Language;
  description?: string;
}

export interface RepoGraph {
  modules: ModuleInfo[];
  mermaidDiagram: string;
  handoffMarkdown: string;
  rootPath: string;
  generatedAt: string;
  truncated?: boolean;
}

const EXT_TO_LANG: Record<string, Language> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.vue': 'vue',
  '.php': 'php',
  '.py': 'python',
  '.cs': 'csharp',
  '.vb': 'vbnet',
  '.fs': 'fsharp',
};

const SUPPORTED_EXTS = new Set(Object.keys(EXT_TO_LANG));

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'out', 'build',
  '__pycache__', 'vendor', '.venv', 'venv', 'bin', 'obj',
]);

export const LANG_LABELS: Record<Language, string> = {
  typescript: 'TS', javascript: 'JS', vue: 'Vue',
  php: 'PHP', python: 'Py', csharp: 'C#', vbnet: 'VB', fsharp: 'F#',
};

function detectLanguage(filePath: string): Language {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? 'javascript';
}

function extractVueScript(content: string): string {
  const m = /<script(?:[^>]*)>([\s\S]*?)<\/script>/i.exec(content);
  return m ? m[1] : '';
}

function extractImports(content: string, language: Language): string[] {
  const imports: string[] = [];

  if (language === 'typescript' || language === 'javascript') {
    for (const m of content.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)) { imports.push(m[1]); }
    for (const m of content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) { imports.push(m[1]); }
    for (const m of content.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) { imports.push(m[1]); }
    return imports.filter(i => i.startsWith('.'));
  }

  if (language === 'vue') {
    const script = extractVueScript(content);
    for (const m of script.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)) { imports.push(m[1]); }
    for (const m of script.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) { imports.push(m[1]); }
    return imports.filter(i => i.startsWith('.'));
  }

  if (language === 'php') {
    for (const m of content.matchAll(/(?:require|require_once|include|include_once)\s*\(?['"]([^'"]+)['"]\)?/g)) {
      imports.push(m[1]);
    }
    return imports.filter(i => !i.startsWith('http'));
  }

  if (language === 'python') {
    for (const m of content.matchAll(/^from\s+(\.[\w.]*)\s+import/gm)) { imports.push(m[1]); }
    return imports;
  }

  return []; // .NET: namespace-based, no resolvable file-level imports
}

function extractExports(content: string, language: Language, filePath: string): string[] {
  const seen = new Set<string>();
  const add = (name: string | undefined) => { if (name) { seen.add(name); } };

  if (language === 'typescript') {
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:(?:default\s+)?(?:function|class|abstract\s+class)|interface|type|const|enum)\s+(\w+)/g)) {
      add(m[1]);
    }
  } else if (language === 'javascript') {
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g)) {
      add(m[1]);
    }
    for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const name of m[1].matchAll(/(\w+)/g)) { add(name[1]); }
    }
    for (const m of content.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/g)) {
      for (const key of m[1].matchAll(/(\w+)\s*:/g)) { add(key[1]); }
    }
  } else if (language === 'vue') {
    const script = extractVueScript(content);
    const nameMatch = script.match(/name\s*:\s*['"](\w+)['"]/);
    add(nameMatch ? nameMatch[1] : path.basename(filePath, '.vue'));
    for (const m of script.matchAll(/export\s+(?:default\s+)?(?:function|const|class)\s+(\w+)/g)) { add(m[1]); }
  } else if (language === 'php') {
    for (const m of content.matchAll(/^(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/gm)) { add(m[1]); }
    for (const m of content.matchAll(/^function\s+(\w+)\s*\(/gm)) { add(m[1]); }
  } else if (language === 'python') {
    for (const m of content.matchAll(/^class\s+(\w+)/gm)) { add(m[1]); }
    for (const m of content.matchAll(/^def\s+([^_]\w*)\s*\(/gm)) { add(m[1]); }
    for (const m of content.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=/gm)) { add(m[1]); }
  } else if (language === 'csharp') {
    for (const m of content.matchAll(/\b(?:public|internal)\b[^;{(]*\b(?:class|interface|enum|struct|record)\s+(\w+)/g)) { add(m[1]); }
  } else if (language === 'vbnet') {
    for (const m of content.matchAll(/\b(?:Public|Friend)\b[^\r\n]*\b(?:Class|Interface|Enum|Structure|Module)\s+(\w+)/g)) { add(m[1]); }
  } else if (language === 'fsharp') {
    for (const m of content.matchAll(/^(?:type|let(?:\s+rec)?|module)\s+(\w+)/gm)) { add(m[1]); }
  }

  return [...seen];
}

function resolveImport(
  rawImport: string,
  sourceFile: string,
  language: Language,
  absToModule: Map<string, ModuleInfo>,
): ModuleInfo | undefined {
  const dir = path.dirname(sourceFile);

  if (language === 'python') {
    const dotMatch = rawImport.match(/^(\.+)([\w.]*)/);
    if (!dotMatch) { return undefined; }
    const dots = dotMatch[1].length;
    const rest = dotMatch[2].replace(/\./g, '/');
    let base = dir;
    for (let i = 1; i < dots; i++) { base = path.dirname(base); }
    const candidate = rest ? path.join(base, rest) : path.join(base, '__init__');
    return absToModule.get(candidate + '.py');
  }

  if (language === 'php') {
    const candidate = path.resolve(dir, rawImport);
    return absToModule.get(candidate) ?? absToModule.get(candidate.replace(/\.php$/, '') + '.php');
  }

  // JS / TS / Vue: try all supported extensions + index variants
  const base = path.resolve(dir, rawImport);
  const direct = absToModule.get(base);
  if (direct) { return direct; }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue']) {
    const m = absToModule.get(base + ext);
    if (m) { return m; }
    const idx = absToModule.get(path.join(base, 'index' + ext));
    if (idx) { return idx; }
  }
  return undefined;
}

export async function analyzeRepo(rootPath: string): Promise<RepoGraph> {
  const sourceFiles = findSourceFiles(rootPath);
  const truncated = sourceFiles.length >= MAX_FILES;

  const modules: ModuleInfo[] = [];
  const absToModule = new Map<string, ModuleInfo>();

  for (const abs of sourceFiles) {
    const rel = path.relative(rootPath, abs).replace(/\\/g, '/');
    const content = await fs.promises.readFile(abs, 'utf8');
    const linesOfCode = content.split('\n').length;
    const language = detectLanguage(abs);
    const rawImports = extractImports(content, language);
    const exports = extractExports(content, language, abs);

    const mod: ModuleInfo = {
      filePath: abs,
      relativePath: rel,
      folder: folderLabel(rel),
      rawImports,
      resolvedImports: [],
      exports,
      linesOfCode,
      language,
    };
    modules.push(mod);
    absToModule.set(abs, mod);
    absToModule.set(abs.replace(/\.[^.]+$/, ''), mod);
  }

  for (const mod of modules) {
    for (const imp of mod.rawImports) {
      const target = resolveImport(imp, mod.filePath, mod.language, absToModule);
      if (target && target !== mod && !mod.resolvedImports.includes(target.relativePath)) {
        mod.resolvedImports.push(target.relativePath);
      }
    }
  }

  const mermaidDiagram = buildMermaid(modules);

  return { modules, mermaidDiagram, handoffMarkdown: '', rootPath, generatedAt: new Date().toISOString(), truncated };
}

const MAX_FILES = 800;
const MAX_FILE_BYTES = 512 * 1024;

function findSourceFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir) || results.length >= MAX_FILES) { return results; }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (results.length >= MAX_FILES) { break; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findSourceFiles(full, results);
      }
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext) && !entry.name.endsWith('.d.ts')) {
        try {
          const { size } = fs.statSync(full);
          if (size <= MAX_FILE_BYTES) { results.push(full); }
        } catch { /* skip unreadable */ }
      }
    }
  }
  return results;
}

function folderLabel(rel: string): string {
  const parts = rel.split('/');
  if (parts.length < 2) { return 'root'; }
  if (parts[0] === 'src' && parts.length >= 3) { return parts[1]; }
  return parts[0];
}

function nodeId(rel: string): string {
  return 'n_' + rel.replace(/[/\\.\-]/g, '_').replace(/__+/g, '_');
}

function shortName(rel: string): string {
  return path.basename(rel);
}

function buildMermaid(modules: ModuleInfo[]): string {
  const folders = new Map<string, ModuleInfo[]>();
  for (const m of modules) {
    const list = folders.get(m.folder) ?? [];
    list.push(m);
    folders.set(m.folder, list);
  }

  const lines: string[] = ['graph LR'];

  for (const [folder, mods] of [...folders.entries()].sort()) {
    const label = folder.charAt(0).toUpperCase() + folder.slice(1);
    lines.push(`  subgraph ${label}`);
    for (const m of mods) {
      lines.push(`    ${nodeId(m.relativePath)}["${shortName(m.relativePath)}"]`);
    }
    lines.push('  end');
  }

  const seen = new Set<string>();
  for (const m of modules) {
    for (const dep of m.resolvedImports) {
      const edge = `  ${nodeId(m.relativePath)} --> ${nodeId(dep)}`;
      if (!seen.has(edge)) {
        seen.add(edge);
        lines.push(edge);
      }
    }
  }

  return lines.join('\n');
}
