// Dev only: replays the local regression set and checks each run (docs/dev-recording.md).
// The set is a private file, fixtures/local/regression-set.json ({recordings:[{id,role,reference?,variable?}]}),
// because the recordings are not in Git. For each recording: a replay (rowlive by default), the
// progress-window checks, the card values against its pinned reference run, and, for recordings
// imported from a corpus case, the human labels. A reference is an earlier run that someone chose
// to compare against with --pin; it is not a confirmed answer.
// Usage: node scripts/run-regression.mjs [--set <file>] [--only <id>] [--mode rowlive] [--port 5173] [--pin]
// Needs the dev server (npm run dev). Runs one replay at a time. Exit 1 when any check fails.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const setFile=option('--set','fixtures/local/regression-set.json'),only=option('--only',null);
const mode=option('--mode','rowlive'),port=option('--port','5173'),pin=args.includes('--pin');
const ROOT='fixtures/local/recordings';
if(!existsSync(setFile)){console.error(`No regression set at ${setFile}. See docs/dev-recording.md.`);process.exit(1);}
const set=JSON.parse(readFileSync(setFile,'utf8'));
const entries=set.recordings.filter(entry=>!only||entry.id===only);
const runsOf=id=>existsSync(join(ROOT,id,'runs'))?readdirSync(join(ROOT,id,'runs')).filter(name=>/^run-2.*\.json$/.test(name)).sort():[];
const node=(script,scriptArgs)=>spawnSync(process.execPath,[script,...scriptArgs],{encoding:'utf8'});
const key=card=>`${card.name} ${card.awakening??'?'}/${card.extraCopies??'?'}`;
// A conflict is a value read in both runs that differs; a card or value read in one run only is a
// gap. A recording marked `variable` (one whose hard cards are read in some runs and not others,
// such as a small screen) fails only on conflicts; any other fails on both.
function diff(reference,current){
  const a=new Map(reference.map(card=>[card.id,card])),b=new Map(current.map(card=>[card.id,card]));
  const conflicts=[],gaps=[];
  for(const [id,card] of a)if(!b.has(id))gaps.push(`only in reference: ${key(card)}`);
  for(const [id,card] of b)if(!a.has(id))gaps.push(`only now: ${key(card)}`);
  for(const [id,card] of a){
    const now=b.get(id);if(!now)continue;
    const fields=['awakening','extraCopies'];
    if(fields.some(field=>card[field]!=null&&now[field]!=null&&card[field]!==now[field]))conflicts.push(`conflict: ${key(card)} -> ${key(now)}`);
    else if(fields.some(field=>card[field]!==now[field]))gaps.push(`read in one run only: ${key(card)} -> ${key(now)}`);
  }
  return {conflicts,gaps};
}
let failed=0;const rows=[];
for(const entry of entries){
  if(!existsSync(join(ROOT,entry.id,'meta.json'))){console.log(`■ ${entry.id}: recording missing`);failed++;continue;}
  const before=new Set(runsOf(entry.id));
  const replay=node('scripts/run-recording-replay.mjs',['--id',entry.id,'--mode',mode,'--port',port]);
  const runName=runsOf(entry.id).find(name=>!before.has(name));
  if(replay.status!==0||!runName){console.log(`■ ${entry.id}: replay failed\n${(replay.stderr||replay.stdout).slice(-600)}`);failed++;continue;}
  const run=JSON.parse(readFileSync(join(ROOT,entry.id,'runs',runName),'utf8'));
  const confirmed=run.cards.filter(card=>card.confirmed!==false).length;
  const checks=[];
  if(mode==='rowlive'){
    const monitor=node('scripts/check-monitor-timeline.mjs',[entry.id,runName]);
    const bad=monitor.stdout.split('\n').filter(line=>/^FAIL/.test(line));
    checks.push(monitor.status===0?'monitor ok':`monitor FAIL (${bad.length})`);
    if(monitor.status!==0){failed++;for(const line of bad)console.log(`    ${line}`);}
  }
  if(entry.reference&&!pin){
    const path=join(ROOT,entry.id,'runs',entry.reference);
    if(!existsSync(path)){checks.push('reference missing');failed++;}
    else{const {conflicts,gaps}=diff(JSON.parse(readFileSync(path,'utf8')).cards,run.cards);
      const failing=entry.variable?conflicts:[...conflicts,...gaps];
      checks.push(!conflicts.length&&!gaps.length?'same as reference':`reference: ${conflicts.length} conflict, ${gaps.length} read in one run only${entry.variable&&!conflicts.length?' (variable: ok)':''}`);
      if(failing.length)failed++;
      rows.push(...[...conflicts,...gaps].map(line=>`  ${entry.id.slice(-9)}  ${line}`));}
  }
  if(JSON.parse(readFileSync(join(ROOT,entry.id,'meta.json'),'utf8')).source?.corpusCase){
    const labels=node('scripts/compare-labels.mjs',[entry.id,runName]);
    checks.push({0:'labels ok',2:'labels DIFFER',3:'labels: some not read'}[labels.status]??'labels: none');
    if(labels.status===2){failed++;rows.push(...labels.stdout.split('\n').filter(line=>/differs/.test(line)).map(line=>`  ${entry.id}${line}`));}
  }
  if(pin)entry.reference=runName;
  console.log(`■ ${entry.id.padEnd(40)} cards ${String(run.cards.length).padStart(3)} (confirmed ${confirmed}) · ${checks.join(' · ')}  [${entry.role}]`);
}
if(rows.length)console.log('\n'+rows.join('\n'));
if(pin){writeFileSync(setFile,JSON.stringify(set,null,2)+'\n');console.log(`\nPinned these runs as references in ${setFile}.`);}
process.exit(failed?1:0);
