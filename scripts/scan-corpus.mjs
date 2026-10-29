import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addCorpusCase, CorpusRunError, listCorpusCases, readCorpusBytes, readCorpusJson, storeCorpusRun, verifyCorpus } from './scan-corpus-core.mjs';
import { compareScanResults } from './scan-case-results.mjs';

const USAGE = `Usage:
  npm run corpus -- add <files...> [--name name] [--kind video|images|replay] [--root path]
  npm run corpus -- list [--root path]
  npm run corpus -- verify [case-id] [--root path]
  npm run corpus -- record-run <case-id> <report.json> [--root path]
  npm run corpus -- compare <reference.json> <actual.json> [--scope full|partial]
  npm run corpus -- replay-state <report.json|trace.json>
  npm run corpus -- <import-human|list-human|verify-human|compare-human> ...

Input order and repeated images are preserved. Input hashes verify stored bytes, not recognition accuracy.
Baseline and human-verified expected results are never generated automatically.
record-run archives original report bytes; completed runs remain unverified observations.
compare checks reference equality, not recognition accuracy. Mismatches exit with code 2.
replay-state reapplies display/observation state events, not OCR or the live scheduler.
Without a captured grid hash, state replay is not a verified comparison.`;

export async function runCorpusCli(args, write = text => process.stdout.write(`${text}\n`)) {
  if (!args.length || args[0] === '--help' || args[0] === 'help') { write(USAGE); return 0; }
  const [command, ...rest] = args;
  const humanCommands={'import-human':'import','list-human':'list','verify-human':'verify','compare-human':'compare'};
  if(Object.hasOwn(humanCommands,command)){
    const {runHumanExpectedCli}=await import('./scan-human-expected.mjs');
    return runHumanExpectedCli([humanCommands[command],...rest],write);
  }
  if (!['add', 'list', 'verify', 'record-run', 'compare', 'replay-state'].includes(command)) throw new Error('Unknown corpus command. Use --help.');
  const options = {};
  const files = [];
  let literal = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!literal && value === '--') { literal = true; continue; }
    if (!literal && value.startsWith('--')) {
      const allowed = command === 'replay-state' ? [] : command === 'compare' ? ['--scope'] : ['--root', ...(command === 'add' ? ['--name', '--kind'] : [])];
      if (!allowed.includes(value)) throw new Error('Unknown option for this corpus command.');
      if (index + 1 === rest.length || rest[index + 1].startsWith('--') || Object.hasOwn(options, value.slice(2))) throw new Error('Missing or repeated option value.');
      options[value.slice(2)] = rest[++index];
    } else files.push(value);
  }
  if (command === 'add') {
    const result = await addCorpusCase(files, options);
    write(JSON.stringify({ created: result.created, id: result.manifest.id, name: result.manifest.name,
      kind: result.manifest.kind, inputs: result.manifest.inputs.length }));
  } else if (command === 'list') {
    if (files.length) throw new Error('list does not accept input paths.');
    write(JSON.stringify(await listCorpusCases(options), null, 2));
  } else if (command === 'verify') {
    if (files.length > 1) throw new Error('verify accepts at most one case ID.');
    write(JSON.stringify(await verifyCorpus({ ...options, id: files[0] })));
  } else if (command === 'record-run') {
    if (files.length !== 2) throw new Error('record-run requires a case ID and one report JSON.');
    write(JSON.stringify(await storeCorpusRun(await readCorpusBytes(files[1]), { ...options, id: files[0] })));
  } else if (command === 'compare') {
    if (files.length !== 2) throw new Error('compare requires a reference JSON and an actual JSON.');
    if (options.scope !== undefined && !['full', 'partial'].includes(options.scope)) throw new Error('Comparison scope must be full or partial.');
    const reference = await readCorpusJson(files[0]);
    const actual = await readCorpusJson(files[1]);
    const comparison = compareScanResults(reference, actual, options);
    write(JSON.stringify({ ...comparison, interpretation: 'Reference equality only; not recognition accuracy.' }, null, 2));
    return comparison.same ? 0 : 2;
  } else {
    if (files.length !== 1) throw new Error('replay-state requires one report JSON or trace JSON.');
    const report = await readCorpusJson(files[0]);
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid state replay input.');
    const isReport = Object.hasOwn(report, 'execution');
    let expectedHash = null;
    const expectedComponents = {};
    if (isReport && Object.hasOwn(report, 'executionExpected')) {
      const expected = report.executionExpected;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Invalid captured state hash.');
      for (const [component, key] of [['grid', 'gridHash'], ['inventory', 'inventoryHash'], ['input', 'inputHash'], ['unknownLifecycle', 'unknownHash'], ['freshness', 'freshnessHash']]) {
        if (!Object.hasOwn(expected, key)) continue;
        if (typeof expected[key] !== 'string' || !/^[a-f0-9]{64}$/.test(expected[key])) throw new Error('Invalid captured state hash.');
        expectedComponents[component] = expected[key];
      }
      expectedHash = expectedComponents.grid ?? null;
    }
    // Keep the TypeScript loader optional for the existing plain-Node commands.
    const { replayRunStateTrace } = await import('../dev/run-state-trace.ts');
    const replay = await replayRunStateTrace(new Blob([JSON.stringify(isReport ? report.execution : report)]), new AbortController().signal);
    const componentChecks = Object.fromEntries(Object.entries(expectedComponents).map(([component, hash]) =>
      [component, { expectedHash: hash, matchesCapturedState: replay[component]?.supported === true &&
        (component !== 'input' || replay.input.settled) && (component !== 'freshness' || replay.freshness.complete) &&
        replay[component].hash === hash }]));
    // A new report must not hide a missing/failed fifth checkpoint by declaring
    // only the four older hashes. Legacy traces have no freshness seed.
    if (isReport && replay.freshness.supported && !Object.hasOwn(componentChecks, 'freshness'))
      componentChecks.freshness = { expectedHash: null, matchesCapturedState: false };
    const matchesCapturedState = Object.keys(componentChecks).length === 0 ? null :
      Object.values(componentChecks).every(check => check.matchesCapturedState);
    write(JSON.stringify({ scope: 'display-and-observation-state', ...replay, expectedHash, componentChecks, matchesCapturedState,
      interpretation: 'not OCR/live scheduler/recognition accuracy' }, null, 2));
    return matchesCapturedState === false ? 2 : 0;
  }
  return 0;
}

// Importing the command in tests or another tool performs no filesystem operations.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCorpusCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Native filesystem errors contain personal absolute paths; keep terminal failures concise.
    process.stderr.write(`Corpus: ${error instanceof CorpusRunError ? error.message : error.code ? `filesystem operation failed (${error.code})` : error.message}\n`);
    process.exitCode = 1;
  });
}
