import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLayer,
  extractImportEdges,
  extractImports,
  findCycles,
  renderMarkdown,
  resolveImport,
  summarize,
} from '../scripts/audit-architecture.mjs';

test('static, export, dynamic and require imports are extracted', () => {
  const source = `
    import a from './a';
    import './side-effect';
    export {b} from './b';
    export * from './c';
    const d = import('./d');
    const e = require('./e');
    // import ignored from './comment';
    const text = "import alsoIgnored from './string'";
  `;
  assert.deepEqual(extractImports(source).sort(), [
    './a', './b', './c', './d', './e', './side-effect',
  ]);
});

test('type-only imports are marked separately from runtime imports', () => {
  const edges = extractImportEdges(`
    import type {A} from './a';
    import {type B} from './b';
    import {type C, D} from './c';
    export type {E} from './e';
    export {type F} from './f';
    import './side-effect';
    const g = import('./g');
  `);
  assert.deepEqual(edges, [
    {specifier: './a', typeOnly: true},
    {specifier: './b', typeOnly: true},
    {specifier: './c', typeOnly: false},
    {specifier: './e', typeOnly: true},
    {specifier: './f', typeOnly: true},
    {specifier: './side-effect', typeOnly: false},
    {specifier: './g', typeOnly: false},
  ]);
});

test('relative specifiers resolve with extensions and index files', () => {
  const files = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.tsx', 'src/d.mjs']);
  assert.equal(resolveImport('src/main.ts', './a', files), 'src/a.ts');
  assert.equal(resolveImport('src/main.ts', './b', files), 'src/b/index.ts');
  assert.equal(resolveImport('src/main.ts', './c', files), 'src/c.tsx');
  assert.equal(resolveImport('src/main.ts', './d', files), 'src/d.mjs');
  assert.equal(resolveImport('src/main.ts', './missing', files), null);
  assert.equal(resolveImport('src/main.ts', 'react', files), null);
});

test('two-node and three-node cycles are found', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['a']],
    ['c', ['d']],
    ['d', ['e']],
    ['e', ['c']],
    ['f', ['g']],
    ['g', []],
  ]);
  const cycles = findCycles(graph);
  assert.equal(cycles.length, 2);
  assert.ok(cycles.some(cycle => cycle.join(',') === 'a,b'));
  assert.ok(cycles.some(cycle => cycle.join(',') === 'c,d,e'));
});

test('non-cyclic graphs return no cycles', () => {
  const graph = new Map([
    ['a', ['b', 'c']],
    ['b', ['c']],
    ['c', []],
  ]);
  assert.deepEqual(findCycles(graph), []);
});

test('layer classification covers current and target paths', () => {
  assert.equal(classifyLayer('src/app/AppShell.tsx'), 'app');
  assert.equal(classifyLayer('src/domain/cards.ts'), 'domain');
  assert.equal(classifyLayer('src/data/catalog.ts'), 'data');
  assert.equal(classifyLayer('src/shared/ui/Button.tsx'), 'shared');
  assert.equal(classifyLayer('src/features/growth/optimizer.ts'), 'feature:growth');
  assert.equal(classifyLayer('src/features/live-results.ts'), 'src:other');
  assert.equal(classifyLayer('src/features/card-scanner/recognition/name/reader.ts'), 'scanner:recognition');
  assert.equal(classifyLayer('src/features/card-scanner/reproduction/replay.ts'), 'scanner:reproduction');
  assert.equal(classifyLayer('src/features/card-scanner/recognition/name-reader.ts'), 'scanner:recognition');
  assert.equal(classifyLayer('src/features/card-scanner/public.ts'), 'scanner:public');
  assert.equal(classifyLayer('src/features/card-scanner/evaluation/metrics.ts'), 'scanner:evaluation');
  assert.equal(classifyLayer('src/features/card-scanner/legacy-ish.ts'), 'scanner:other');
  assert.equal(classifyLayer('dev/evaluation/run.ts'), 'dev');
  assert.equal(classifyLayer('tests/contract/scan.test.ts'), 'tests');
  assert.equal(classifyLayer('scripts/audit.mjs'), 'scripts');
});

test('summary keeps relative paths and reports cycles and edges', () => {
  const result = summarize([
    {
      path: 'src/features/growth/x.ts', bytes: 30,
      imports: ['src/domain/y.ts'], externalImports: ['react'], unresolvedImports: [],
    },
    {
      path: 'src/domain/y.ts', bytes: 5,
      imports: [], externalImports: [], unresolvedImports: [],
    },
    {
      path: 'src/a.ts', bytes: 10,
      imports: ['src/b.ts'], externalImports: ['react', 'react-dom'], unresolvedImports: ['./styles.css'],
    },
    {
      path: 'src/b.ts', bytes: 20,
      imports: ['src/a.ts'], externalImports: [], unresolvedImports: ['./icon.svg'],
    },
    {
      path: 'src/features/raid/z.ts', bytes: 7,
      imports: ['src/features/growth/x.ts'], externalImports: [], unresolvedImports: [],
    },
  ]);
  assert.equal(result.fileCount, 5);
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0], ['src/a.ts', 'src/b.ts']);
  assert.equal(result.byLayer['feature:growth'].files, 1);
  assert.equal(result.byLayer.domain.files, 1);
  assert.equal(result.topFiles[0].path, 'src/features/growth/x.ts');
  assert.equal(result.crossFeatureEdges.length, 1);
  assert.equal(result.externalImports[0].name, 'react');
  assert.equal(result.unresolvedRelativeImports.length, 2);
  const json = JSON.stringify(result);
  assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\/|file:\/\//u.test(json), false);
});

test('type-only cycles are reported separately from runtime cycles', () => {
  const result = summarize([
    {
      path: 'src/a.ts', bytes: 1,
      imports: ['src/b.ts'], runtimeImports: [], typeImports: ['src/b.ts'],
      externalImports: [], unresolvedImports: [],
    },
    {
      path: 'src/b.ts', bytes: 1,
      imports: ['src/a.ts'], runtimeImports: [], typeImports: ['src/a.ts'],
      externalImports: [], unresolvedImports: [],
    },
  ]);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.typeOnlyCycles.length, 1);
  assert.deepEqual(result.typeOnlyCycles[0], ['src/a.ts', 'src/b.ts']);
});

test('markdown report is deterministic and has no absolute paths', () => {
  const result = summarize([
    {
      path: 'src/a.ts', bytes: 10,
      imports: [], externalImports: ['react'], unresolvedImports: [],
    },
  ]);
  const markdown = renderMarkdown(result);
  assert.match(markdown, /# 구조 감사/u);
  assert.match(markdown, /## 레이어별 규모/u);
  assert.match(markdown, /## 타입 전용 순환/u);
  assert.match(markdown, /src\/a\.ts/u);
  assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\/|file:\/\//u.test(markdown), false);
});
