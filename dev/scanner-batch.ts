/** DEV-only orchestration. Runners own pixels/reports and resolve successful runs
 * after normal cleanup and immutable archiving. Failed/cancelled runs may return
 * under a known quarantine; this driver never starts their successor. Only compact
 * metadata is retained, with no guarantee about native OS resource release. */
export const MAX_SCANNER_BATCH_JOBS = 32;
export const MAX_SCANNER_BATCH_BYTES = 256 * 1024;
export const MAX_SCANNER_BATCH_SUMMARY_BYTES = 4 * 1024;

export interface ScannerBatchJob {
  caseId: string;
  variant: 'baseline' | 'gray' | 'fractional' | 'contrast';
  mode: 'offline' | 'live';
}

export interface ScannerBatchRunSummary {
  completed: boolean;
  outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'source-changed' | 'source-unverified';
  expected: number | null;
  read: number;
  review: number;
  unknown: number;
  /** Hash of canonical card semantic fields, excluding images/timing/diagnostics. */
  cardFieldsHash: string;
  sourceStart: string;
  sourceEnd: string;
  emptySeed: true;
  archive: { ref: string; sha256: string } | null;
  elapsedMs: number;
  /** Includes input load, engine preparation, operation and known cleanup;
   * excludes source hashing and archiving. Never compare across modes. */
  elapsedKind: 'offline-preparation-and-processing' | 'live-preparation-playback-and-drain';
}

export interface ScannerBatchRun {
  index: number;
  job: ScannerBatchJob;
  summary: ScannerBatchRunSummary;
  executionSucceeded: boolean;
  quantityMatches: boolean | null;
  /** Program observation only; not human-verified correctness. */
  clean: boolean;
}

export interface ScannerBatchComparison {
  caseId: string;
  mode: ScannerBatchJob['mode'];
  sourceDigest: string;
  baselineIndex: number;
  variant: Exclude<ScannerBatchJob['variant'], 'baseline'>;
  variantIndex: number;
  cardFieldsEqual: boolean;
  quantity: {
    baseline: { expected: number | null; read: number; matches: boolean | null };
    variant: { expected: number | null; read: number; matches: boolean | null };
  };
  review: { baseline: number; variant: number };
  unknown: { baseline: number; variant: number };
}

export interface ScannerBatchDiagnostic {
  code: 'cancelled' | 'runner-error' | 'malformed-summary' | 'summary-too-large' |
    'nonempty-seed' | 'source-changed' | 'run-incomplete' | 'archive-missing' | 'aggregate-limit';
  index: number;
  message: string;
}

export interface ScannerBatchResult {
  version: 2;
  /** Execution completion is independent of recognition/quantity results. */
  status: 'completed' | 'partial' | 'cancelled';
  clean: boolean;
  sourceDigest: string | null;
  jobs: ScannerBatchJob[];
  runs: ScannerBatchRun[];
  comparisons: ScannerBatchComparison[];
  diagnostics: ScannerBatchDiagnostic[];
}

export interface ScannerBatchProgress {
  phase: 'starting' | 'settled' | 'finished';
  activeIndex: number | null;
  result: ScannerBatchResult;
}

export interface ScannerBatchOptions {
  /** Successful runs settle after normal cleanup/archive. Failed/cancelled runs
   * may settle under a known quarantine and cannot be followed by another job. */
  run: (job: ScannerBatchJob, signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  /** At most two calls/job plus one final call. Snapshots are detached. Observer
   * failures are ignored; asynchronous observers never delay execution. */
  onProgress?: (progress: ScannerBatchProgress) => void | Promise<void>;
}

const HASH = /^[a-f0-9]{64}$/;
const SUMMARY_FIELDS = ['completed', 'outcome', 'expected', 'read', 'review', 'unknown',
  'cardFieldsHash', 'sourceStart', 'sourceEnd', 'emptySeed', 'archive', 'elapsedMs', 'elapsedKind'];
const OUTCOMES = ['completed', 'cancelled', 'failed', 'interrupted', 'source-changed', 'source-unverified'];
const encoder = new TextEncoder();
// A 512-code-unit error can expand to 3072 ASCII bytes when JSON escaped.
const DIAGNOSTIC_RESERVE_BYTES = 4096;

class SummaryError extends Error {
  readonly code: ScannerBatchDiagnostic['code'];
  constructor(code: ScannerBatchDiagnostic['code'], message: string) { super(message); this.code = code; }
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)))
    throw new Error(`${label} has missing or unsupported fields.`);
  const copied: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error(`${label}.${key} must be a data field.`);
    copied[key] = descriptor.value;
  }
  return copied;
}

function count(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function bytes(value: unknown) { return encoder.encode(JSON.stringify(value)).byteLength; }
function detached<T>(value: T): T { return structuredClone(value); }

function planJobs(input: readonly ScannerBatchJob[]): ScannerBatchJob[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SCANNER_BATCH_JOBS)
    throw new Error(`A scanner batch needs 1–${MAX_SCANNER_BATCH_JOBS} ordered jobs.`);
  const jobs: ScannerBatchJob[] = [], seen = new Set<string>();
  for (const value of input) {
    const item = record(value, ['caseId', 'variant', 'mode'], 'Job');
    if (!hash(item.caseId) || typeof item.variant !== 'string' || !['baseline', 'gray', 'fractional', 'contrast'].includes(item.variant) ||
      typeof item.mode !== 'string' || !['offline', 'live'].includes(item.mode)) throw new Error('Invalid scanner batch job.');
    const job = { caseId: item.caseId, variant: item.variant, mode: item.mode } as ScannerBatchJob;
    const key = `${job.caseId}:${job.variant}:${job.mode}`;
    if (seen.has(key)) throw new Error('Duplicate scanner batch job.');
    seen.add(key); jobs.push(job);
  }
  return jobs;
}

function summaryOf(value: unknown, job: ScannerBatchJob): ScannerBatchRunSummary {
  try {
    const item = record(value, SUMMARY_FIELDS, 'Run summary');
    // Bound strings before serialization; never stringify unknown reports/arrays.
    if (Object.values(item).some(field => typeof field === 'string' && field.length > 1024))
      throw new SummaryError('summary-too-large', 'Run summary contains an oversized string.');
    if (typeof item.completed !== 'boolean' || typeof item.outcome !== 'string' || !OUTCOMES.includes(item.outcome) ||
      item.completed !== (item.outcome === 'completed') ||
      (item.expected !== null && !count(item.expected)) || !count(item.read) || !count(item.review) || !count(item.unknown) ||
      !hash(item.cardFieldsHash) || !hash(item.sourceStart) || !hash(item.sourceEnd) ||
      typeof item.elapsedMs !== 'number' || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 ||
      item.elapsedKind !== (job.mode === 'offline' ? 'offline-preparation-and-processing' : 'live-preparation-playback-and-drain'))
      throw new Error('Run summary has invalid fields or a mismatched timing mode.');
    if (item.emptySeed !== true) throw new SummaryError('nonempty-seed', 'Every batch run must start with an empty inventory.');
    let archive: ScannerBatchRunSummary['archive'] = null;
    if (item.archive !== null) {
      const entry = record(item.archive, ['ref', 'sha256'], 'Archive reference');
      if (typeof entry.ref === 'string' && entry.ref.length > 1024)
        throw new SummaryError('summary-too-large', 'Archive reference is too large.');
      if (!hash(entry.sha256) || entry.ref !== `cases/${job.caseId}/runs/run-${entry.sha256}.json`)
        throw new Error('Run archive reference is not bound to this case and immutable hash.');
      archive = { ref: entry.ref as string, sha256: entry.sha256 };
    }
    const summary = { ...item, archive } as unknown as ScannerBatchRunSummary;
    if (bytes(summary) > MAX_SCANNER_BATCH_SUMMARY_BYTES)
      throw new SummaryError('summary-too-large', 'Run summary exceeds the metadata budget.');
    return summary;
  } catch (error) {
    if (error instanceof SummaryError) throw error;
    throw new SummaryError('malformed-summary', error instanceof Error ? error.message : 'Invalid run summary.');
  }
}

function comparisonsFor(runs: ScannerBatchRun[]): ScannerBatchComparison[] {
  const paired = new Map<string, { baseline?: ScannerBatchRun; gray?: ScannerBatchRun; fractional?: ScannerBatchRun; contrast?: ScannerBatchRun }>();
  for (const run of runs) {
    if (!run.executionSucceeded) continue;
    const key = `${run.job.caseId}:${run.job.mode}:${run.summary.sourceStart}`;
    const pair = paired.get(key) ?? {};
    pair[run.job.variant] = run;
    paired.set(key, pair);
  }
  const comparisons: ScannerBatchComparison[] = [];
  for (const pair of paired.values()) for (const variant of ['gray','fractional','contrast'] as const) {
    const baseline=pair.baseline, candidate=pair[variant];
    if (!baseline || !candidate) continue;
    const quantity = (run: ScannerBatchRun) => ({ expected: run.summary.expected, read: run.summary.read, matches: run.quantityMatches });
    comparisons.push({ caseId: baseline.job.caseId, mode: baseline.job.mode, sourceDigest: baseline.summary.sourceStart,
      baselineIndex: baseline.index, variant, variantIndex: candidate.index,
      cardFieldsEqual: baseline.summary.cardFieldsHash === candidate.summary.cardFieldsHash,
      quantity: { baseline: quantity(baseline), variant: quantity(candidate) },
      review: { baseline: baseline.summary.review, variant: candidate.summary.review },
      unknown: { baseline: baseline.summary.unknown, variant: candidate.summary.unknown } });
  }
  return comparisons;
}

/** Runs a validated, fixed plan sequentially. Cancellation awaits the active
 * runner's promise. Failed/cancelled runners may remain quarantined; neither can
 * launch the next job, and settlement does not guarantee native OS release.
 * Equal semantic hashes are a regression observation, never human truth or a
 * cross-mode latency guarantee. Original reports remain in their run archives. */
export async function runScannerBatch(input: readonly ScannerBatchJob[], options: ScannerBatchOptions): Promise<ScannerBatchResult> {
  const jobs = planJobs(input);
  if (typeof options.run !== 'function') throw new Error('A scanner batch runner is required.');
  const signal = options.signal ?? new AbortController().signal;
  const result: ScannerBatchResult = { version: 2, status: 'partial', clean: false, sourceDigest: null,
    jobs, runs: [], comparisons: [], diagnostics: [] };
  const notify = (phase: ScannerBatchProgress['phase'], activeIndex: number | null) => {
    if (!options.onProgress) return;
    try { void Promise.resolve(options.onProgress({ phase, activeIndex, result: detached(result) })).catch(() => {}); }
    catch { /* Diagnostic observers have no authority over batch state. */ }
  };
  const stop = (code: ScannerBatchDiagnostic['code'], index: number, message: string) => {
    result.status = code === 'cancelled' ? 'cancelled' : 'partial';
    result.diagnostics.push({ code, index, message: message.slice(0, 512) });
  };
  for (let index = 0; index < jobs.length; index++) {
    if (signal.aborted) { stop('cancelled', index, 'Batch cancelled before starting the next job.'); break; }
    notify('starting', index);
    if (signal.aborted) { stop('cancelled', index, 'Batch cancelled before starting the next job.'); break; }
    let summary: ScannerBatchRunSummary;
    try {
      const output = await options.run(detached(jobs[index]), signal);
      summary = summaryOf(output, jobs[index]);
    } catch (error) {
      const code = error instanceof SummaryError ? error.code : signal.aborted ? 'cancelled' : 'runner-error';
      stop(code, index, error instanceof Error ? error.message : 'Runner failed without an error message.');
      notify('settled', index); break;
    }
    // Pin only structurally valid summaries, including a valid failed execution.
    result.sourceDigest ??= summary.sourceStart;
    const stable = summary.sourceStart === result.sourceDigest && summary.sourceEnd === result.sourceDigest;
    const executionSucceeded = stable && summary.completed && summary.archive !== null && !signal.aborted;
    const quantityMatches = summary.expected === null ? null : summary.read === summary.expected;
    const run: ScannerBatchRun = { index, job: detached(jobs[index]), summary, executionSucceeded, quantityMatches,
      clean: executionSucceeded && quantityMatches === true && summary.review === 0 && summary.unknown === 0 };
    const candidateRuns = [...result.runs, run], comparisons = comparisonsFor(candidateRuns);
    if (bytes({ ...result, runs: candidateRuns, comparisons }) > MAX_SCANNER_BATCH_BYTES - DIAGNOSTIC_RESERVE_BYTES) {
      stop('aggregate-limit', index, 'Batch metadata exceeds the aggregate budget.');
      notify('settled', index); break;
    }
    result.runs = candidateRuns; result.comparisons = comparisons;
    if (!stable) stop('source-changed', index, 'Source digest changed within a run or across the batch.');
    else if (signal.aborted || summary.outcome === 'cancelled') stop('cancelled', index, 'Batch cancelled after the active runner settled.');
    else if (!summary.completed) stop('run-incomplete', index, `Run did not complete: ${summary.outcome}.`);
    else if (!summary.archive) stop('archive-missing', index, 'Run archive is unavailable; preserve the active report before continuing.');
    notify('settled', index);
    if (result.diagnostics.length) break;
  }
  if (!result.diagnostics.length) {
    if (signal.aborted) stop('cancelled', result.runs.length, 'Batch cancelled after the active runner settled.');
    else result.status = 'completed';
  }
  result.clean = result.status === 'completed' && result.runs.every(run => run.clean);
  notify('finished', null);
  return result;
}
