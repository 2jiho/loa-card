import {readFileSync} from 'node:fs';
import {observationPixels} from '../src/features/card-scanner/observation-pixels';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveWorkPriority} from '../src/features/card-scanner/live-work-priority';
import {CandidateQueue} from '../src/features/card-scanner/candidate-queue';
import {shiftOcrRetry} from '../src/features/card-scanner/live-scan-policy';

test('failed OCR attempts yield to other unread cards without certifying or dropping any observation',()=>{
 const priority=new LiveWorkPriority();
 const a=priority.group(new Uint8Array(3240).fill(30),0);
 const b=priority.group(new Uint8Array(3240).fill(180),0);
 const queue=[{group:a,id:'a1',needsIdentity:true},{group:a,id:'a2',needsIdentity:true},
  {group:b,id:'b1',needsIdentity:true},{group:a,id:'a3',needsIdentity:true}];
 const take=()=>{const item=shiftOcrRetry(queue,item=>priority.retryPriority(item.group))!;priority.attempted(item.group);return item;};
 assert.equal(take().id,'a1'); // Simulate a failed OCR, no serviced call.
 assert.equal(priority.priority(a),0,'a failed read must not pretend to identify the card');
 assert.equal(take().id,'b1','first OCR of another unread card beats the failed group repeat');
 assert.equal(take().id,'a2');assert.equal(take().id,'a3');assert.equal(queue.length,0);
 priority.serviced(b);
 for(let i=0;i<1000;i++)priority.attempted(a);
 assert.ok(priority.retryPriority(a)<priority.retryPriority(b),'unidentified retries still precede confirmed groups');
 priority.attempted(-1);assert.equal(priority.attempts(-1),0,'unknown group keys must not merge unrelated work');
});

test('live scheduling favors unread artwork while preserving every distinct observation and count',()=>{
 const priority=new LiveWorkPriority(), queue=new CandidateQueue<{group:number;hint:number;count:number}>(20,()=>assert.fail('No crop should be released'));
 const first=new Uint8Array(3240).fill(30), changed=first.slice();changed.fill(230,864,2016);
 const different=new Uint8Array(3240).fill(190);
 const a=priority.group(first,0), b=priority.group(changed,0), c=priority.group(different,0);
 assert.equal(a,b,'changed counts may share a scheduling hint, never an observation ID');
 assert.notEqual(a,c);
 queue.push({group:1,hint:a,count:1});queue.push({group:2,hint:b,count:15});queue.push({group:3,hint:c,count:2});
 const take=()=>{const item=queue.shift(v=>priority.priority(v.hint))!;priority.serviced(item.hint);return item;};
 assert.deepEqual([take().group,take().group,take().group],[1,3,2]);
 assert.equal(queue.length,0);
});

test('approximate priority does not cross columns and FIFO is retained without a priority callback',()=>{
 const priority=new LiveWorkPriority(), pixels=new Uint8Array(3240);
 assert.notEqual(priority.group(pixels,0),priority.group(pixels,1));
 const queue=new CandidateQueue<{group:number}>(5,()=>{});
 queue.push({group:2});queue.push({group:1});assert.equal(queue.shift()?.group,2);assert.equal(queue.shift()?.group,1);
});

// Ground truth comes from the existing manually checked screenshot inventory.
// These cards can share coarse colors; scheduling must still consider them unread.
test('real screenshot cards stay independently schedulable despite similar overall colors',()=>{
 const rows=JSON.parse(readFileSync(new URL('./fixtures/artwork-detail-samples.json',import.meta.url),'utf8')) as {expected:string;column:number;gray:string}[];
 const priority=new LiveWorkPriority(),names=new Map<number,Set<string>>();
 for(const row of rows.filter(r=>r.expected)) {
  const rgba=new Uint8Array(768*4);Buffer.from(row.gray,'base64').forEach((v,i)=>rgba.set([v,v,v,255],i*4));
  const feature=observationPixels(rgba,24,32).feature,group=priority.group(feature,row.column);
  const bucket=names.get(group)??new Set<string>();bucket.add(row.expected);names.set(group,bucket);
  const noisy=feature.map(v=>Math.min(255,v+1));
  assert.equal(priority.group(noisy,row.column),group,'small capture brightness noise: '+row.expected);
 }
 assert.equal(names.size,384);
 assert.equal([...names.values()].filter(bucket=>bucket.size!==1).length,0);
});

test('dynamic count, jewel and border pixels do not change a portrait scheduling hint',()=>{
 const priority=new LiveWorkPriority(),first=new Uint8Array(3240);
 for(let i=0;i<first.length;i++)first[i]=(i*37)%251;
 const changed=first.slice();changed.fill(255,864,2592);
 for(let y=0;y<18;y++)for(let x=0;x<12;x++)if(y<5||y>=11||x<2||x>=10)changed.fill(255,2592+(y*12+x)*3,2592+(y*12+x)*3+3);
 assert.equal(priority.group(first,3),priority.group(changed,3));
});

test('actual shared artwork does not postpone Commander Sol behind an already-read Sol Grande',()=>{
 const rows=JSON.parse(readFileSync(new URL('./fixtures/shared-portrait-priority.json',import.meta.url),'utf8')) as {name:string;column:number;feature:string}[];
 const priority=new LiveWorkPriority();
 const [grande,commander]=rows.map(row=>priority.group(Buffer.from(row.feature,'base64'),row.column));
 priority.serviced(grande);priority.serviced(grande);priority.serviced(grande);
 assert.notEqual(grande,commander,'same robot artwork has two different names/rarities');
 assert.equal(priority.priority(commander),0);
 const noisy=Buffer.from(rows[1].feature,'base64').map(v=>Math.min(255,v+1));
 assert.equal(priority.group(noisy,8),commander,'minor capture noise still reuses the correct scheduling group');
});
