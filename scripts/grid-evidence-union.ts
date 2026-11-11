import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {mergeScanEvidence} from '../src/features/card-scanner/session/scan-evidence-union';
import type {EvidenceCard} from '../src/features/card-scanner/session/scan-evidence-union';

/** Reproducible merge of the fixed-grid artwork proof manifest and one scanner
 * run. Usage: node --import tsx scripts/grid-evidence-union.ts <manifest> <run> <output> */
const [manifestPath, runPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !runPath || !outputPath) {
  console.error('Usage: node --import tsx scripts/grid-evidence-union.ts <manifest.json> <run.json> <output.json>');
  process.exitCode = 2;
} else {
  try {
    await main(manifestPath, runPath, outputPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function displayPath(path: string) {
  const value = relative(process.cwd(), path).replaceAll('\\', '/');
  if (!value || value.startsWith('../')) throw Error('Evidence inputs must stay inside the repository working directory');
  return value;
}
function hashText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
function evidenceCards(value: unknown, label: string): EvidenceCard[] {
  if (!Array.isArray(value)) throw Error(`Missing ${label} cards`);
  return value.map(card => {
    if (!card || typeof card !== 'object') throw Error(`Invalid ${label} card`);
    const {id, name} = card as {id?: unknown; name?: unknown};
    if (typeof id !== 'string' || typeof name !== 'string') throw Error(`Invalid ${label} card`);
    return {id, name};
  });
}
async function main(manifestPath: string, runPath: string, outputPath: string) {
  const manifestFile = displayPath(manifestPath);
  const runFile = displayPath(runPath);
  const manifestText = await readFile(manifestPath, 'utf8');
  const runText = await readFile(runPath, 'utf8');
  const manifest = JSON.parse(manifestText) as {
    version?: unknown; kind?: unknown; expected?: unknown;
    union?: unknown; input?: {caseId?: unknown; sha256?: unknown};
  };
  if (manifest.version !== 1 || manifest.kind !== 'grid-video-reconstruction')
    throw Error('Not a version 1 grid-video-reconstruction manifest');
  const run = JSON.parse(runText) as {
    result?: {expected?: unknown; cards?: unknown};
  };
  const result = run.result;
  if (!result || typeof result !== 'object') throw Error('Scanner run has no result');
  const runExpected = result.expected;
  if (!Number.isSafeInteger(runExpected) || (runExpected as number) <= 0)
    throw Error('Scanner run has an invalid expected count');
  if (manifest.expected !== runExpected)
    throw Error(`Expected count mismatch: manifest ${String(manifest.expected)} vs run ${String(runExpected)}`);
  const merged = mergeScanEvidence({
    expected: runExpected as number,
    proof: evidenceCards(manifest.union, 'proof'),
    scanner: evidenceCards(result.cards, 'scanner'),
  });
  const artifact = {
    version: 1,
    kind: 'grid-scanner-evidence-union',
    inputs: {
      manifest: {
        file: manifestFile, sha256: hashText(manifestText), bytes: Buffer.byteLength(manifestText),
        caseId: manifest.input?.caseId ?? null, inputSha256: manifest.input?.sha256 ?? null,
      },
      run: {
        file: runFile, sha256: hashText(runText), bytes: Buffer.byteLength(runText),
      },
    },
    ...merged,
  };
  const text = JSON.stringify(artifact);
  await writeFile(outputPath, text, 'utf8');
  console.log(JSON.stringify({
    output: displayPath(outputPath), sha256: hashText(text), bytes: Buffer.byteLength(text),
    expected: merged.expected, proof: merged.proofCount, scanner: merged.scannerCount,
    union: merged.unionCount, missing: merged.missingCount, excess: merged.excessCount,
    coversExpected: merged.coversExpected,
    proofOnly: merged.proofOnly.map(card => `${card.id} ${card.name}`),
    scannerOnly: merged.scannerOnly.length,
  }, null, 2));
}
