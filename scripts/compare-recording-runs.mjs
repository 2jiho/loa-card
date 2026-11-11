// Compare, per recording, the newest sequential replay of two builds card by card.
// Usage: node scripts/compare-recording-runs.mjs [--root fixtures/local/recordings] [--base HEAD] [--json]
//   --base  prefix of the baseline build label in the run summaries (default "HEAD", written by the
//           comparison page of a checked-out release). Every other build counts as "current".
// A run is used only when it is a full sequential replay (no subset experiment) of a complete
// recording. Live results (`run-live.json`) are shown for reference. See docs/dev-recording.md.
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const root=option('--root','fixtures/local/recordings'),base=option('--base','HEAD'),asJson=args.includes('--json');

const readJson=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
const cardKey=card=>`${card.awakening}/${card.extraCopies}`;

export function diffCards(a,b){
  const mapA=new Map(a.map(c=>[c.id,c])),mapB=new Map(b.map(c=>[c.id,c]));
  const onlyA=[...mapA.values()].filter(c=>!mapB.has(c.id)).map(c=>c.name).sort((x,y)=>x.localeCompare(y,'ko'));
  const onlyB=[...mapB.values()].filter(c=>!mapA.has(c.id)).map(c=>c.name).sort((x,y)=>x.localeCompare(y,'ko'));
  const changed=[...mapA].filter(([id,c])=>mapB.has(id)&&cardKey(c)!==cardKey(mapB.get(id)))
    .map(([id,c])=>({name:c.name,a:cardKey(c),b:cardKey(mapB.get(id))})).sort((x,y)=>x.name.localeCompare(y.name,'ko'));
  return {onlyA,onlyB,changed,same:mapA.size-onlyA.length-changed.length};
}

const results=[];
for(const id of existsSync(root)?readdirSync(root).sort():[]){
  const dir=join(root,id),meta=readJson(join(dir,'meta.json'));
  if(!meta||!existsSync(join(dir,'runs')))continue;
  const runs=readdirSync(join(dir,'runs')).filter(n=>/^run-2/.test(n)).sort()
    .map(name=>({name,report:readJson(join(dir,'runs',name))})).filter(r=>r.report&&r.report.summary&&!r.report.subsetOf&&r.report.summary.mode==='sequential');
  const isBase=r=>String(r.report.summary.build).startsWith(base);
  const baseline=[...runs].reverse().find(isBase),current=[...runs].reverse().find(r=>!isBase(r));
  if(!baseline||!current)continue;
  const live=readJson(join(dir,'runs','run-live.json'));
  results.push({id:id.replace(/^share-2026/,''),frames:meta.frames,complete:meta.complete,
    baseline:{read:baseline.report.summary.read,cards:baseline.report.cards.length,unidentified:baseline.report.summary.unidentified},
    current:{read:current.report.summary.read,cards:current.report.cards.length,unidentified:current.report.summary.unidentified},
    live:live?{read:live.summary.read,cards:live.cards.length,final:!!live.live?.final,status:live.status}:null,
    sameInput:!!baseline.report.recording.sha256&&baseline.report.recording.sha256===current.report.recording.sha256,
    diff:diffCards(baseline.report.cards,current.report.cards)});
}

if(asJson){console.log(JSON.stringify(results,null,1));}
else{
  console.log(`기준선(${base}) 대 현재 · 같은 기록의 순차 재실행, 카드 단위\n`);
  for(const r of results){
    console.log(`■ ${r.id}  프레임 ${r.frames}${r.complete?'':' (불완전)'}${r.sameInput?'':'  ※ 입력 동일성 미확인'}`);
    console.log(`  기준선 읽음 ${r.baseline.read} · 카드 ${r.baseline.cards} · 미확인 ${r.baseline.unidentified}`);
    console.log(`  현재   읽음 ${r.current.read} · 카드 ${r.current.cards} · 미확인 ${r.current.unidentified}`);
    if(r.live)console.log(`  라이브 읽음 ${r.live.read} · 카드 ${r.live.cards}${r.live.final?'':' (진행 중 상태)'} · ${r.live.status.slice(0,28)}`);
    console.log(`  같음 ${r.diff.same} · 기준선에만 ${r.diff.onlyA.length} · 현재에만 ${r.diff.onlyB.length} · 값 다름 ${r.diff.changed.length}`);
    if(r.diff.onlyA.length)console.log(`    기준선에만: ${r.diff.onlyA.join(', ')}`);
    if(r.diff.onlyB.length)console.log(`    현재에만: ${r.diff.onlyB.join(', ')}`);
    for(const c of r.diff.changed)console.log(`    값 다름: ${c.name}  각성/장수 ${c.a} → ${c.b}`);
    console.log('');
  }
}
