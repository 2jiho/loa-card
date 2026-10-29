import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_EVENTS = 250_000;

/** Summarize recorded acquisition, identity, and active unknown facts by phase. */
export function analyzeRecordingImpact(report) {
  const chunks = report?.execution?.chunks;
  if (!Array.isArray(chunks) || chunks.length > 4096) throw new TypeError('Expected a bounded recorded execution trace.');
  const events = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.data !== 'string' || chunk.data.length > 32 * 1024 * 1024) throw new TypeError('Invalid trace chunk.');
    const lines = gunzipSync(Buffer.from(chunk.data, 'base64')).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (events.length >= MAX_EVENTS) throw new RangeError('Trace event limit exceeded.');
      events.push(JSON.parse(line));
    }
  }

  const phases = ['input', 'recovery'];
  const result = Object.fromEntries(phases.map(phase => [phase, {
    acquisitionEvents: 0, acquisitionFrames: 0, usableCrops: 0,
    acceptedIdentityEvents: 0, acceptedObservations: 0, uniqueCardIds: 0,
    unknownUpserts: 0, unknownGroups: 0, unknownRetires: 0, activeUnknownGroups: 0,
  }]));
  const acquisitionFrames = new Map(phases.map(phase => [phase, new Set()]));
  const acceptedObservations = new Map(phases.map(phase => [phase, new Set()]));
  const acceptedCardIds = new Map(phases.map(phase => [phase, new Set()]));
  const unknownGroups = new Map();
  const seenUnknownGroups = new Map(phases.map(phase => [phase, new Set()]));

  for (const event of events) {
    const value = event?.value;
    if (event?.type === 'acquisition-capture' && phases.includes(value?.phase)) {
      const phase = value.phase;
      const out = result[phase];
      out.acquisitionEvents += 1;
      if (Number.isSafeInteger(value.acquisitionFrameId)) acquisitionFrames.get(phase).add(value.acquisitionFrameId);
      if (value.quality?.usable === true) out.usableCrops += 1;
    } else if (event?.type === 'inventory-event' && value?.kind === 'identity-accepted' && phases.includes(value.source?.phase)) {
      const phase = value.source.phase;
      result[phase].acceptedIdentityEvents += 1;
      if (typeof value.source.observationId === 'string') acceptedObservations.get(phase).add(value.source.observationId);
      if (typeof value.id === 'string') acceptedCardIds.get(phase).add(value.id);
    } else if (event?.type === 'unknown-event' && value?.key?.kind === 'group') {
      const key = `${value.key.sessionId}:${value.key.group}`;
      if (value.kind === 'retire') {
        const priorPhase = unknownGroups.get(key);
        if (priorPhase) result[priorPhase].unknownRetires += 1;
        unknownGroups.delete(key);
      }
      else if (value.kind === 'upsert' && phases.includes(value.source?.phase)) {
        const phase = value.source.phase;
        result[phase].unknownUpserts += 1;
        seenUnknownGroups.get(phase).add(key);
        unknownGroups.set(key, phase);
      }
    }
  }

  for (const phase of phases) {
    result[phase].acquisitionFrames = acquisitionFrames.get(phase).size;
    result[phase].acceptedObservations = acceptedObservations.get(phase).size;
    result[phase].uniqueCardIds = acceptedCardIds.get(phase).size;
    result[phase].unknownGroups = seenUnknownGroups.get(phase).size;
  }
  const recoveryOnlyCardIds = [...acceptedCardIds.get('recovery')].filter(id => !acceptedCardIds.get('input').has(id)).sort();
  const recoveryOnlyCards = recoveryOnlyCardIds.length;
  for (const phase of unknownGroups.values()) result[phase].activeUnknownGroups += 1;
  return { traceComplete: report.execution.complete === true, events: events.length, phases: result,
    recoveryOnlyCards, recoveryOnlyCardIds,
    interpretation: 'Phase counts describe recorded work. Recovery adds observations; raw unknown totals across modes are not an accuracy or causal comparison.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('Usage: node scripts/analyze-recording-impact.mjs <run-report.json>\n');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(analyzeRecordingImpact(JSON.parse(readFileSync(file, 'utf8'))), null, 2)); }
    catch (error) { process.stderr.write(`Recording impact analysis failed: ${error.message}\n`); process.exitCode = 1; }
  }
}
