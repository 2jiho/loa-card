// Opt-in, offline analysis of an existing local run report or raw state trace.
// It neither opens a screen share nor sends data anywhere.
import {readFile} from 'node:fs/promises';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {analyzeFrameNames} from '../src/features/card-scanner/recognition/frame-name-offline.ts';
const path=process.argv[2];
if(!path)throw Error('Usage: node --import tsx scripts/analyze-frame-name-trace.mjs <private-run.json>');
const input=JSON.parse(await readFile(path,'utf8'));
const trace=await parseRunStateTrace(new Blob([JSON.stringify(input.execution??input)]),new AbortController().signal);
console.log(JSON.stringify({scope:'offline receipt/group and inventory-checkpoint consistency only; no live frame-name checkpoint or card correctness assertion',
  traceVersion:trace.version,...await analyzeFrameNames(trace)},null,2));
