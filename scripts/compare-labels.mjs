// Dev only: compares a replay run of an imported recording with the human-confirmed labels of the
// corpus case it came from (docs/dev-recording.md). Labels are partial: only the cards and fields a
// person confirmed are checked, and a pass says nothing about the other cards.
// Usage: node scripts/compare-labels.mjs <recording id> [run file]
// Exit: 0 every labelled field matches, 2 a value differs, 3 none differ but some were not read,
// 1 no labels or a bad input.
import {existsSync,readdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const RECORDINGS='fixtures/local/recordings',LABELS='fixtures/local/corpus/human-labels';
const [id,runArgument]=process.argv.slice(2);
if(!id){console.error('Usage: node scripts/compare-labels.mjs <recording id> [run file]');process.exit(1);}
const fail=message=>{console.error(message);process.exit(1);};
const meta=JSON.parse(await readFile(join(RECORDINGS,id,'meta.json'),'utf8'));
const caseId=meta.source?.corpusCase;
if(!caseId)fail(`${id} was not imported from a corpus case, so it has no human labels.`);
const runs=existsSync(join(RECORDINGS,id,'runs'))?readdirSync(join(RECORDINGS,id,'runs')).filter(name=>name.endsWith('.json')).sort():[];
const runName=runArgument??runs.at(-1);
if(!runName)fail(`${id} has no replay run yet.`);
const run=JSON.parse(await readFile(join(RECORDINGS,id,'runs',runName),'utf8'));
const cards=new Map((run.cards??[]).map(card=>[card.id,card]));
const labelFiles=existsSync(join(LABELS,'labels'))?readdirSync(join(LABELS,'labels')).filter(name=>name.endsWith('.json')):[];
const labels=[],quarantined=[];
for(const name of labelFiles){
  const label=JSON.parse(await readFile(join(LABELS,'labels',name),'utf8'));
  if(label.caseId!==caseId)continue;
  (existsSync(join(LABELS,'quarantine',name))?quarantined:labels).push({sha:name.replace(/\.json$/,''),label});
}
if(!labels.length)fail(`No usable human labels for corpus case ${caseId.slice(0,12)}${quarantined.length?` (${quarantined.length} quarantined)`:''}.`);
const FIELD={name:'name',awakening:'awakening',extraCopies:'extraCopies'};
let differ=0,unread=0,match=0;
console.log(`${id} · ${runName} · labels ${labels.length}${quarantined.length?`, quarantined ${quarantined.length} (not used)`:''}`);
for(const {sha,label} of labels){
  for(const entry of label.cards){
    const card=cards.get(entry.id);
    for(const [field,value] of Object.entries(entry.fields)){
      if(value?.status!=='known'||!(field in FIELD))continue;
      const actual=card?card[FIELD[field]]:undefined;
      // An unread value (absent card or null) is never the same as a confirmed 0.
      const state=actual===undefined||actual===null?'not read':actual===value.value?'ok':'differs';
      if(state==='ok')match++;else if(state==='differs')differ++;else unread++;
      if(state!=='ok')console.log(`  ${state.padEnd(8)} ${entry.id} ${field}: label ${JSON.stringify(value.value)}, run ${JSON.stringify(actual??null)} (label ${sha.slice(0,8)})`);
    }
  }
}
console.log(`  match ${match}, differ ${differ}, not read ${unread}`);
process.exit(differ?2:unread?3:0);
