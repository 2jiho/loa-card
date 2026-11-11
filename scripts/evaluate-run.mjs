import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseCaseLabel, canonicalLabelJson} from '../src/features/card-scanner/evaluation/labels.ts';
import {evaluateCase} from '../src/features/card-scanner/evaluation/metrics.ts';
import {toEvaluationRun} from '../src/features/card-scanner/evaluation/run-result.ts';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : 'work/evaluation/report.json';
  if (positional.length !== 2) {
    throw new Error('usage: node --import tsx scripts/evaluate-run.mjs <label.json> <run-result.json> [--out report.json]');
  }
  const [labelPath, runPath] = positional;
  const rawLabel = readJson(labelPath);
  const label = parseCaseLabel(rawLabel);
  const run = toEvaluationRun(readJson(runPath));
  const report = evaluateCase(label, run);
  const output = {
    kind: 'loacard-evaluation-report',
    version: 1,
    generatedAt: new Date().toISOString(),
    label: {
      file: labelPath,
      rawSha256: sha256(readFileSync(labelPath)),
      canonicalSha256: sha256(canonicalLabelJson(label)),
      sourceVersion: rawLabel.version,
      caseId: label.caseId,
      scope: label.scope,
      cards: label.cards.length,
    },
    run: {
      file: runPath,
      rawSha256: sha256(readFileSync(runPath)),
      expected: run.expected,
      cards: run.cards.length,
      unidentified: run.unidentified,
      unresolvedObservations: run.unresolvedObservations,
      discardedObservations: run.discardedObservations,
      recognitionNeeded: run.recognitionNeeded,
    },
    report,
  };
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    caseId: report.caseId,
    scope: report.scope,
    verdict: report.verdict,
    reasons: report.reasons,
    fields: {
      name: `${report.fields.name.exact}/${report.fields.name.readable}`,
      awakening: `${report.fields.awakening.exact}/${report.fields.awakening.readable}`,
      extraCopies: `${report.fields.extraCopies.exact}/${report.fields.extraCopies.readable}`,
    },
    readableButMissed: report.readableButMissed,
    falseConfirm: report.falseConfirm,
    review: report.review,
    readableReview: report.readableReview,
    unlabeled: report.unlabeled,
    missingResultCards: report.missingResultCards.length,
    unlabeledResultCards: report.unlabeledResultCards.length,
    out,
  }, null, 2));
  process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'incomplete' ? 3 : 2);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
