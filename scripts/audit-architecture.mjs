import {mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['src', 'dev', 'tests', 'scripts'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'work', '.git']);
const SCANNER_SUBFOLDERS = new Set([
  'capture', 'acquisition', 'recognition', 'session', 'reproduction', 'persistence', 'ui', 'orchestration', 'evaluation',
]);

function toPosix(path) {
  return path.split(sep).join('/');
}

function relativePath(path) {
  return toPosix(relative(ROOT, path));
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function importClauseIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
}

function exportDeclarationIsTypeOnly(node) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
}

/** Extract module edges with a type-only flag. Type-only edges do not create runtime cycles. */
export function extractImportEdges(source, fileName = 'source.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const edges = [];
  const add = (specifier, typeOnly) => {
    if (typeof specifier !== 'string' || !specifier.length) return;
    if (edges.some(edge => edge.specifier === specifier && edge.typeOnly === typeOnly)) return;
    edges.push({specifier, typeOnly});
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text, importClauseIsTypeOnly(node));
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text, exportDeclarationIsTypeOnly(node));
      }
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(first)) {
        add(first.text, false);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(first)) {
        add(first.text, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edges;
}

/** Extract module specifiers used by import, export-from, dynamic import and require. */
export function extractImports(source, fileName = 'source.ts') {
  return [...new Set(extractImportEdges(source, fileName).map(edge => edge.specifier))];
}

/** Resolve a relative module specifier against the repository file set. */
export function resolveImport(fromFile, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  const clean = specifier.split('?')[0].split('#')[0];
  if (!clean) return null;
  const base = resolve(ROOT, dirname(fromFile), clean);
  const candidates = [base];
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(join(base, `index${extension}`));
  for (const candidate of candidates) {
    const path = relativePath(candidate);
    if (fileSet.has(path)) return path;
  }
  return null;
}

export function classifyLayer(path) {
  const value = toPosix(path);
  if (value.startsWith('src/app/')) return 'app';
  if (value.startsWith('src/domain/')) return 'domain';
  if (value.startsWith('src/data/')) return 'data';
  if (value === 'src/features/card-scanner/public.ts') return 'scanner:public';
  if (value.startsWith('src/shared/')) return 'shared';
  if (value.startsWith('src/features/card-scanner/')) {
    const sub = value.slice('src/features/card-scanner/'.length).split('/')[0];
    return SCANNER_SUBFOLDERS.has(sub) ? `scanner:${sub}` : 'scanner:other';
  }
  if (value.startsWith('src/features/')) {
    const parts = value.split('/');
    return parts.length > 3 ? `feature:${parts[2]}` : 'src:other';
  }
  if (value.startsWith('src/')) return 'src:other';
  if (value.startsWith('dev/')) return 'dev';
  if (value.startsWith('tests/')) return 'tests';
  if (value.startsWith('scripts/')) return 'scripts';
  return 'unknown';
}

/** Tarjan strongly connected components; every SCC larger than one node is a cycle. */
export function findCycles(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  const strongConnect = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue;
      if (!indices.has(target)) {
        strongConnect(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node), indices.get(target)));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    for (;;) {
      const item = stack.pop();
      onStack.delete(item);
      component.push(item);
      if (item === node) break;
    }
    if (component.length > 1) cycles.push(component.sort());
    else if ((graph.get(node) ?? []).includes(node)) cycles.push(component);
  };
  for (const node of graph.keys()) if (!indices.has(node)) strongConnect(node);
  return cycles;
}

function extensionOf(specifier) {
  const clean = specifier.split('?')[0].split('#')[0];
  const extension = extname(clean);
  return extension || '(none)';
}

export function summarize(records) {
  const fileSet = new Set(records.map(record => record.path));
  const graphFor = key => new Map(records.map(record =>
    [record.path, (record[key] ?? record.imports).filter(path => fileSet.has(path))]));
  const runtimeCycles = findCycles(graphFor('runtimeImports'));
  const allCycles = findCycles(graphFor('imports'));
  const runtimeKeys = new Set(runtimeCycles.map(cycle => cycle.join('\0')));
  const typeOnlyCycles = allCycles.filter(cycle => !runtimeKeys.has(cycle.join('\0')));
  const byLayer = {};
  const crossFeatureEdges = [];
  const scannerEdges = [];
  const externalCounts = new Map();
  const unresolvedCounts = new Map();
  for (const record of records) {
    const layer = classifyLayer(record.path);
    const entry = byLayer[layer] ?? {files: 0, bytes: 0};
    entry.files += 1;
    entry.bytes += record.bytes;
    byLayer[layer] = entry;
    for (const target of record.imports) {
      const from = classifyLayer(record.path);
      const to = classifyLayer(target);
      if (from.startsWith('feature:') && to.startsWith('feature:') && from !== to) {
        crossFeatureEdges.push({from: record.path, to: target, fromLayer: from, toLayer: to});
      }
      if (from.startsWith('scanner:') && to.startsWith('scanner:') && from !== to) {
        scannerEdges.push({from: record.path, to: target, fromLayer: from, toLayer: to});
      }
    }
    for (const specifier of record.externalImports ?? []) {
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      externalCounts.set(packageName, (externalCounts.get(packageName) ?? 0) + 1);
    }
    for (const specifier of record.unresolvedImports ?? []) {
      const extension = extensionOf(specifier);
      unresolvedCounts.set(extension, (unresolvedCounts.get(extension) ?? 0) + 1);
    }
  }
  const topFiles = [...records]
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map(record => ({path: record.path, bytes: record.bytes, layer: classifyLayer(record.path)}));
  return {
    generatedAt: new Date().toISOString(),
    fileCount: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.bytes, 0),
    byLayer,
    topFiles,
    cycles: runtimeCycles,
    typeOnlyCycles,
    crossFeatureEdges: crossFeatureEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    scannerEdges: scannerEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    externalImports: [...externalCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({name, count})),
    unresolvedRelativeImports: [...unresolvedCounts].sort((a, b) => b[1] - a[1]).map(([extension, count]) => ({extension, count})),
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

export function renderMarkdown(result) {
  const layers = Object.entries(result.byLayer).sort((a, b) => b[1].bytes - a[1].bytes);
  const cycles = result.cycles.slice(0, 20).map((cycle, index) => `${index + 1}. ${cycle.join(' → ')}`);
  const typeCycles = (result.typeOnlyCycles ?? []).slice(0, 20).map((cycle, index) => `${index + 1}. ${cycle.join(' → ')}`);
  const cross = result.crossFeatureEdges.slice(0, 20).map(edge => `${edge.from} → ${edge.to}`);
  const scanner = result.scannerEdges.slice(0, 20).map(edge => `${edge.from} → ${edge.to}`);
  return [
    '# 구조 감사',
    '',
    `- 생성: ${result.generatedAt}`,
    `- 파일: ${result.fileCount}`,
    `- 전체 크기: ${formatBytes(result.totalBytes)}`,
    '- 이 문서는 감사 결과이며 의존 규칙 강제는 Step 3에서 추가한다.',
    '- 경로는 저장소 상대 경로만 사용한다.',
    '',
    '## 레이어별 규모',
    '',
    table(['레이어', '파일', '크기'], layers.map(([layer, value]) => [layer, value.files, formatBytes(value.bytes)])),
    '',
    '## 큰 파일 20개',
    '',
    table(['파일', '크기', '레이어'], result.topFiles.map(file => [file.path, formatBytes(file.bytes), file.layer])),
    '',
    '## 런타임 순환 의존',
    '',
    `- 발견: ${result.cycles.length}`,
    ...(cycles.length ? cycles : ['- 없음']),
    '',
    '## 타입 전용 순환',
    '',
    `- 발견: ${(result.typeOnlyCycles ?? []).length}`,
    ...(typeCycles.length ? typeCycles : ['- 없음']),
    '',
    '## 기능 간 의존',
    '',
    `- 발견: ${result.crossFeatureEdges.length}`,
    ...(cross.length ? cross.map(item => `- ${item}`) : ['- 없음']),
    '',
    '## 스캐너 내부 의존',
    '',
    `- 발견: ${result.scannerEdges.length}`,
    ...(scanner.length ? scanner.map(item => `- ${item}`) : ['- 없음']),
    '',
    '## 외부 패키지',
    '',
    table(['패키지', 'import 수'], result.externalImports.map(item => [item.name, item.count])),
    '',
    '## 해석하지 못한 상대 import',
    '',
    table(['확장자', '수'], result.unresolvedRelativeImports.map(item => [item.extension, item.count])),
    '',
    '## 한계',
    '',
    '- import 그래프는 정적 분석이며, 런타임 동적 문자열 import와 Worker 메시지 결합은 포함하지 않는다.',
    '- 상대 import가 아닌 경로 별칭·가상 모듈은 별도 규칙이 필요하다.',
    '- 코퍼스 재실행 결과가 아니며, 인식 정확도를 뜻하지 않는다.',
    '',
  ].join('\n');
}

export function buildRecords() {
  const files = SOURCE_ROOTS.flatMap(root => {
    const directory = join(ROOT, root);
    try {
      return walk(directory);
    } catch {
      return [];
    }
  });
  const fileSet = new Set(files.map(relativePath));
  return files.map(file => {
    const path = relativePath(file);
    const source = readFileSync(file, 'utf8');
    const edges = extractImportEdges(source, file);
    const imports = new Set();
    const runtimeImports = new Set();
    const typeImports = new Set();
    const unresolvedImports = new Set();
    const externalImports = new Set();
    for (const edge of edges) {
      if (edge.specifier.startsWith('.')) {
        const resolved = resolveImport(path, edge.specifier, fileSet);
        if (resolved) {
          imports.add(resolved);
          (edge.typeOnly ? typeImports : runtimeImports).add(resolved);
        } else {
          unresolvedImports.add(edge.specifier);
        }
      } else if (!edge.specifier.startsWith('node:') && !edge.specifier.startsWith('data:') &&
                 !edge.specifier.startsWith('http:') && !edge.specifier.startsWith('https:') &&
                 !edge.specifier.startsWith('virtual:') && !edge.specifier.startsWith('/')) {
        externalImports.add(edge.specifier);
      }
    }
    return {
      path,
      bytes: statSync(file).size,
      imports: [...imports],
      runtimeImports: [...runtimeImports],
      typeImports: [...typeImports],
      unresolvedImports: [...unresolvedImports],
      externalImports: [...externalImports],
    };
  });
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const out = argumentValue(args, '--out') ?? 'work/architecture-audit.json';
  const markdown = argumentValue(args, '--md') ?? 'docs/architecture-audit.md';
  const result = summarize(buildRecords());
  const outPath = resolve(ROOT, out);
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  if (markdown !== 'none') {
    const markdownPath = resolve(ROOT, markdown);
    mkdirSync(dirname(markdownPath), {recursive: true});
    writeFileSync(markdownPath, renderMarkdown(result));
  }
  console.log(JSON.stringify({
    files: result.fileCount,
    bytes: result.totalBytes,
    cycles: result.cycles.length,
    typeOnlyCycles: result.typeOnlyCycles.length,
    crossFeatureEdges: result.crossFeatureEdges.length,
    scannerEdges: result.scannerEdges.length,
    out,
    markdown,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
