// Local-only, offline investigation of existing recorded facts. It cannot
// modify scanner results or infer that two observations are the same card.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {analyzeAssociation} from '../dev/association-evidence.ts';
const [file,first,second]=process.argv.slice(2);
if(!file||!first||!second||process.argv.length!==5)throw Error('Usage: node --import tsx scripts/analyze-observation-pair.mjs <run.json> <first-observation-id> <second-observation-id>');
const bytes=await readFile(file),input=JSON.parse(bytes.toString('utf8'));
const trace=await parseRunStateTrace(new Blob([JSON.stringify(input.execution??input)]),new AbortController().signal);
console.log(JSON.stringify({reportSha256:createHash('sha256').update(bytes).digest('hex'),
 traceVersion:trace.version,...await analyzeAssociation(trace,first,second)},null,2));
