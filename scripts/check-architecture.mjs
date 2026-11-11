import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRecords, classifyLayer, findCycles} from './audit-architecture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function policyLayer(layer) {
  if (layer === 'src:other') return 'root';
  if (layer.startsWith('scanner:')) return 'scanner';
  if (layer.startsWith('feature:')) return 'feature';
  return layer;
}

function featureName(layer) {
  return layer.startsWith('feature:') ? layer.slice('feature:'.length) : null;
}

function scannerSub(layer) {
  return layer.startsWith('scanner:') ? layer.slice('scanner:'.length) : null;
}

function isPublicEntry(path, feature) {
  return path === `src/features/${feature}/public.ts`;
}

/** Pure edge policy used by the checker and its unit tests. */
export function isAllowedEdge(fromLayer, toLayer, toPath, policy) {
  const from = policyLayer(fromLayer);
  const to = policyLayer(toLayer);
  if (from === 'dev' || from === 'tests' || from === 'scripts') return true;
  if (from === 'scanner') {
    if (to === 'scanner') {
      const fromSub = scannerSub(fromLayer), toSub = scannerSub(toLayer);
      if (fromSub === 'public') return true;
      if (fromSub === toSub) return true;
      if (fromSub === 'other' || toSub === 'other') return false;
      if (toSub === 'public') return true;
      // UI is a leaf and orchestration is the composition root.
      if (toSub === 'ui') return fromSub === 'orchestration';
      if (toSub === 'orchestration') return false;
      return true;
    }
    if (to === 'feature') return isPublicEntry(toPath, featureName(toLayer));
    if (['domain', 'data', 'shared'].includes(to)) return true;
    return false;
  }
  if (from === 'feature') {
    if (to === 'scanner') return isPublicEntry(toPath, 'card-scanner');
    if (to === 'feature') {
      if (featureName(fromLayer) === featureName(toLayer)) return true;
      return isPublicEntry(toPath, featureName(toLayer));
    }
    if (['domain', 'data', 'shared'].includes(to)) return true;
    return false;
  }
  const allowed = policy.allowed?.[from];
  return Array.isArray(allowed) && (allowed.includes(to) || allowed.includes('*'));
}

function runtimeGraph(records) {
  const fileSet = new Set(records.map(record => record.path));
  return new Map(records.map(record =>
    [record.path, (record.runtimeImports ?? record.imports).filter(path => fileSet.has(path))]));
}

function allGraph(records) {
  const fileSet = new Set(records.map(record => record.path));
  return new Map(records.map(record => [record.path, record.imports.filter(path => fileSet.has(path))]));
}

/** Return layer violations plus runtime-cycle errors and type-only-cycle warnings. */
export function collectViolations(records, policy) {
  const violations = [];
  for (const record of records) {
    const fromLayer = classifyLayer(record.path);
    for (const target of (record.runtimeImports ?? record.imports)) {
      const toLayer = classifyLayer(target);
      if (!isAllowedEdge(fromLayer, toLayer, target, policy)) {
        violations.push({rule: 'layer-edge', from: record.path, to: target, fromLayer, toLayer});
      }
    }
  }
  const runtimeCycles = findCycles(runtimeGraph(records));
  for (const cycle of runtimeCycles) {
    violations.push({rule: 'runtime-cycle', from: cycle.join(' -> '), to: '', fromLayer: 'cycle', toLayer: 'cycle', cycle});
  }
  const runtimeKeys = new Set(runtimeCycles.map(cycle => cycle.join('\0')));
  const warnings = findCycles(allGraph(records))
    .filter(cycle => !runtimeKeys.has(cycle.join('\0')))
    .map(cycle => ({rule: 'type-only-cycle', cycle}));
  const seen = new Set();
  const unique = violations.filter(item => {
    const key = `${item.rule}\0${item.from}\0${item.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {violations: unique, warnings};
}

export function formatViolation(violation) {
  if (violation.rule === 'runtime-cycle') return `[runtime-cycle] ${violation.from}`;
  return `[${violation.rule}] ${violation.from} -> ${violation.to} (${violation.fromLayer} -> ${violation.toLayer})`;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const policyPath = argumentValue(args, '--policy') ?? 'scripts/architecture-policy.json';
  const out = argumentValue(args, '--out');
  const asJson = args.includes('--json');
  const policy = JSON.parse(readFileSync(resolve(ROOT, policyPath), 'utf8'));
  const records = buildRecords();
  const result = collectViolations(records, policy);
  const output = {
    generatedAt: new Date().toISOString(),
    fileCount: records.length,
    violations: result.violations,
    warnings: result.warnings,
    summary: {
      violations: result.violations.length,
      warnings: result.warnings.length,
      runtimeCycles: result.violations.filter(item => item.rule === 'runtime-cycle').length,
      typeOnlyCycles: result.warnings.length,
    },
  };
  if (out) {
    const outPath = resolve(ROOT, out);
    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`architecture: ${output.summary.violations} violation(s), ${output.summary.warnings} warning(s)`);
    for (const violation of output.violations) console.log(formatViolation(violation));
    for (const warning of output.warnings) console.log(`[warning:${warning.rule}] ${warning.cycle.join(' -> ')}`);
  }
  process.exit(output.violations.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
