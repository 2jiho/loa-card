import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectViolations, formatViolation, isAllowedEdge} from '../scripts/check-architecture.mjs';

const policy = {
  allowed: {
    app: ['app', 'root', 'feature', 'scanner', 'domain', 'data', 'shared'],
    root: ['app', 'root', 'feature', 'scanner', 'domain', 'data', 'shared'],
    feature: ['domain', 'data', 'shared'],
    domain: ['domain'],
    data: ['domain', 'data'],
    shared: ['shared'],
    dev: ['*'],
    tests: ['*'],
    scripts: ['*'],
  },
  scannerSubfolders: {
    capture: ['capture', 'domain', 'data', 'shared'],
    acquisition: ['capture', 'acquisition', 'domain', 'data', 'shared'],
    recognition: ['acquisition', 'recognition', 'domain', 'data', 'shared'],
    session: ['capture', 'acquisition', 'recognition', 'session', 'domain', 'data', 'shared'],
    reproduction: ['capture', 'acquisition', 'recognition', 'session', 'reproduction', 'persistence', 'domain', 'data', 'shared'],
    persistence: ['session', 'persistence', 'domain', 'data', 'shared'],
    ui: ['session', 'ui', 'domain', 'data', 'shared'],
  },
};

test('root and app may compose feature internals during migration', () => {
  assert.equal(isAllowedEdge('src:other', 'scanner:other', 'src/features/card-scanner/orchestration/scanner.ts', policy), true);
  assert.equal(isAllowedEdge('app', 'feature:growth', 'src/features/growth/GrowthPlanner.tsx', policy), true);
});

test('cross-feature imports require the target public entry', () => {
  assert.equal(isAllowedEdge('feature:growth', 'scanner:other', 'src/features/card-scanner/public.ts', policy), true);
  assert.equal(isAllowedEdge('feature:growth', 'scanner:other', 'src/features/card-scanner/recognition/recognizer.ts', policy), false);
  assert.equal(isAllowedEdge('feature:growth', 'feature:raid', 'src/features/raid/public.ts', policy), true);
  assert.equal(isAllowedEdge('feature:growth', 'feature:raid', 'src/features/raid/RaidSetCard.tsx', policy), false);
  assert.equal(isAllowedEdge('feature:growth', 'feature:growth', 'src/features/growth/optimizer.ts', policy), true);
});

test('scanner subfolder rules keep ui a leaf and orchestration the root', () => {
  assert.equal(isAllowedEdge('scanner:recognition', 'scanner:acquisition', 'src/features/card-scanner/acquisition/x.ts', policy), true);
  assert.equal(isAllowedEdge('scanner:recognition', 'scanner:ui', 'src/features/card-scanner/ui/x.tsx', policy), false);
  assert.equal(isAllowedEdge('scanner:capture', 'scanner:session', 'src/features/card-scanner/session/x.ts', policy), true);
  assert.equal(isAllowedEdge('scanner:other', 'scanner:recognition', 'src/features/card-scanner/recognition/x.ts', policy), false);
  assert.equal(isAllowedEdge('scanner:public', 'scanner:recognition', 'src/features/card-scanner/recognition/x.ts', policy), true);
  assert.equal(isAllowedEdge('scanner:orchestration', 'scanner:ui', 'src/features/card-scanner/ui/x.tsx', policy), true);
  assert.equal(isAllowedEdge('scanner:ui', 'scanner:orchestration', 'src/features/card-scanner/orchestration/x.ts', policy), false);
});

test('domain, data and shared have one-way dependencies', () => {
  assert.equal(isAllowedEdge('domain', 'feature:growth', 'src/features/growth/optimizer.ts', policy), false);
  assert.equal(isAllowedEdge('data', 'domain', 'src/domain/cards.ts', policy), true);
  assert.equal(isAllowedEdge('data', 'feature:growth', 'src/features/growth/optimizer.ts', policy), false);
  assert.equal(isAllowedEdge('shared', 'shared', 'src/shared/ui/CardName.tsx', policy), true);
  assert.equal(isAllowedEdge('shared', 'domain', 'src/domain/cards.ts', policy), false);
});

test('a forbidden runtime edge is a violation and type-only cross-layer imports are not', () => {
  const result = collectViolations([
    {
      path: 'src/features/growth/complete-growth.ts', bytes: 1,
      imports: ['src/features/card-scanner/recognition/recognizer.ts', 'src/features/card-scanner/public.ts'],
      runtimeImports: ['src/features/card-scanner/recognition/recognizer.ts'],
      typeImports: ['src/features/card-scanner/public.ts'],
      externalImports: [], unresolvedImports: [],
    },
  ], policy);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, 'layer-edge');
  assert.match(result.violations[0].to, /recognizer\.ts$/u);
  assert.equal(result.warnings.length, 0);
  assert.match(formatViolation(result.violations[0]), /layer-edge/u);
});

test('runtime cycles are violations and type-only cycles are warnings', () => {
  const result = collectViolations([
    {
      path: 'src/a.ts', bytes: 1,
      imports: ['src/b.ts'], runtimeImports: ['src/b.ts'], typeImports: [],
      externalImports: [], unresolvedImports: [],
    },
    {
      path: 'src/b.ts', bytes: 1,
      imports: ['src/a.ts'], runtimeImports: ['src/a.ts'], typeImports: [],
      externalImports: [], unresolvedImports: [],
    },
    {
      path: 'src/c.ts', bytes: 1,
      imports: ['src/d.ts'], runtimeImports: [], typeImports: ['src/d.ts'],
      externalImports: [], unresolvedImports: [],
    },
    {
      path: 'src/d.ts', bytes: 1,
      imports: ['src/c.ts'], runtimeImports: [], typeImports: ['src/c.ts'],
      externalImports: [], unresolvedImports: [],
    },
  ], policy);
  assert.equal(result.violations.filter(item => item.rule === 'runtime-cycle').length, 1);
  assert.equal(result.warnings.filter(item => item.rule === 'type-only-cycle').length, 1);
  assert.match(formatViolation(result.violations[0]), /runtime-cycle/u);
});
