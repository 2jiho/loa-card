import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchiveJournalMirror} from '../src/features/card-scanner/archive-journal-mirror';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('default disk drain reduces writes without increasing byte credits or delaying a small tail',async()=>{
 const size=10*1024*1024+413,source=new Blob([new Uint8Array(size).map((_,i)=>i%251)]);
 const sent:{sequence:number;blob:Blob}[]=[];let completed=0;
 const mirror=createArchiveJournalMirror({read:(offset,length)=>source.slice(offset,offset+length),
  send:(sequence,blob)=>{sent.push({sequence,blob});},incomplete:assert.fail,complete:()=>{completed++;}});
 mirror.update(413);await turn();assert.equal(sent.length,1);assert.equal(sent[0].blob.size,413);
 mirror.acknowledge(0,413);mirror.seal(size);await turn();
 assert.equal(mirror.stats.pendingBytes,8*1024*1024);
 assert.equal(mirror.stats.complete,false);
 for(let i=1;i<11;i++){assert.ok(sent[i]);mirror.acknowledge(sent[i].sequence,sent[i].blob.size);await turn();}
 assert.equal(sent.length,11);assert.equal(completed,1);assert.equal(mirror.stats.complete,true);
 assert.equal(mirror.stats.peakPendingBytes,8*1024*1024);
 assert.deepEqual(await new Blob(sent.map(row=>row.blob)).arrayBuffer(),await source.arrayBuffer());
});

test('encoded file backlog stays on disk while bounded transport credits preserve exact byte order',async()=>{
  const source=new Blob(['abcdefghijklmnopqrstuvwxyz']),sent:{sequence:number;blob:Blob}[]=[],warnings:string[]=[];let completed=0;
  const mirror=createArchiveJournalMirror({read:(offset,length)=>source.slice(offset,offset+length),send:(sequence,blob)=>{sent.push({sequence,blob});},
    incomplete:reason=>{warnings.push(reason);},complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:8});
  mirror.update(20);await turn();assert.equal(sent.length,2);assert.equal(mirror.stats.pendingBytes,8);
  mirror.seal(source.size);await turn();assert.equal(sent.length,2,'an unacknowledged window must not allocate another chunk');
  for(let index=0;index<7;index++){
    if(!sent[index])await turn();const value=sent[index];assert.ok(value);mirror.acknowledge(value.sequence,value.blob.size);await turn();
  }
  assert.equal(await new Blob(sent.map(value=>value.blob)).text(),await source.text());assert.equal(mirror.stats.complete,true);
  assert.equal(mirror.stats.peakPendingBytes,8);assert.equal(mirror.stats.acknowledgedBytes,26);assert.equal(completed,1);assert.deepEqual(warnings,[]);
});

test('an async OPFS fallback can publish after close without retaining the whole file in JavaScript',async()=>{
  const source=new Blob(['first-last']),sent:Blob[]=[];let readable=false,completed=0;
  const mirror=createArchiveJournalMirror({read:(offset,length)=>readable?source.slice(offset,offset+length):undefined,
    send:(_sequence,blob)=>{sent.push(blob);},incomplete:assert.fail,complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:16});
  mirror.update(source.size);await turn();assert.equal(sent.length,0);assert.equal(mirror.stats.pendingBytes,0);
  readable=true;mirror.seal(source.size);await turn();assert.equal(sent.length,3);
  sent.forEach((blob,index)=>mirror.acknowledge(index,blob.size));await turn();
  assert.equal(await new Blob(sent).text(),'first-last');assert.equal(completed,1);
});

test('duplicate credits, short reads and disposed mirrors cannot create a false complete journal',async()=>{
  const warnings:string[]=[];
  const mirror=createArchiveJournalMirror({read:()=>new Blob(['x']),send(){},incomplete:reason=>{warnings.push(reason);},complete:()=>assert.fail('corrupt transport completed'),chunkBytes:2,maxPendingBytes:4});
  mirror.update(4);await turn();assert.match(mirror.stats.error,/범위/);assert.equal(warnings.length,1);
  const second=createArchiveJournalMirror({read:(_offset,length)=>new Blob([new Uint8Array(length)]),send(){},incomplete(){},complete:()=>assert.fail('disposed transport completed'),chunkBytes:2,maxPendingBytes:4});
  second.update(4);await turn();second.acknowledge(99,2);second.seal(4);await turn();assert.match(second.stats.error,/응답/);
  second.stop();assert.equal(second.stats.pendingBytes,0);assert.equal(second.stats.complete,false);
});

test('tiny chunks cannot turn the byte window into an unbounded metadata queue',async()=>{
 let offered=0;
 const mirror=createArchiveJournalMirror({read:(_offset,length)=>new Blob([new Uint8Array(length)]),send(){offered++;},
  incomplete:assert.fail,complete:()=>assert.fail('unacknowledged work completed'),chunkBytes:1,maxPendingBytes:1024*1024});
 mirror.update(1024*1024);await turn();assert.equal(offered,256);assert.equal(mirror.stats.pendingBytes,256);mirror.stop();
});

test('seal arriving during an unresolved unavailable read is not lost and completes exactly once',async()=>{
 const source=new Blob(['abcdefgh']),sent:{sequence:number;blob:Blob}[]=[],warnings:string[]=[];
 let resolveRead:(value:Blob|undefined)=>void=()=>{},started:()=>void=()=>{},reads=0,completed=0;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:(offset,length)=>{
  reads++;if(reads===1){started();return new Promise(resolve=>{resolveRead=resolve;});}
  return source.slice(offset,offset+length);
 },send:(sequence,blob)=>{sent.push({sequence,blob});mirror.acknowledge(sequence,blob.size);},
 incomplete:reason=>{warnings.push(reason);},complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(source.size);await entered;mirror.seal(source.size);resolveRead(undefined);await turn();
 assert.equal(sent.length,2);assert.equal(reads,3);assert.equal(await new Blob(sent.map(value=>value.blob)).text(),'abcdefgh');
 assert.deepEqual(sent.map(value=>value.sequence),[0,1]);assert.equal(mirror.stats.acknowledgedBytes,8);
 assert.equal(mirror.stats.complete,true);assert.equal(completed,1);assert.deepEqual(warnings,[]);
 await turn();assert.equal(reads,3);assert.equal(completed,1);
});

test('update arriving during an unresolved unavailable read retries the unchanged cursor once',async()=>{
 const source=new Blob(['abcdefgh']),sent:Blob[]=[],ranges:{offset:number;length:number}[]=[],warnings:string[]=[];
 let resolveRead:(value:Blob|undefined)=>void=()=>{},started:()=>void=()=>{},completed=0;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:(offset,length)=>{
  ranges.push({offset,length});if(ranges.length===1){started();return new Promise(resolve=>{resolveRead=resolve;});}
  return source.slice(offset,offset+length);
 },send:(sequence,blob)=>{sent.push(blob);mirror.acknowledge(sequence,blob.size);},
 incomplete:reason=>{warnings.push(reason);},complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(4);await entered;mirror.update(8);resolveRead(undefined);await turn();
 assert.equal(sent.length,2);assert.deepEqual(ranges,[{offset:0,length:4},{offset:0,length:4},{offset:4,length:4}]);
 assert.equal(await new Blob(sent).text(),'abcdefgh');assert.equal(mirror.stats.complete,false);
 mirror.seal(8);await turn();assert.equal(mirror.stats.complete,true);assert.equal(completed,1);assert.deepEqual(warnings,[]);
});

test('unavailable reads do not busy-retry or reuse a synchronous ACK wake already consumed by the next read',async()=>{
 const source=new Blob(['abcdefgh']),ranges:number[]=[],sent:Blob[]=[];let readable=false,completed=0;
 const mirror=createArchiveJournalMirror({read:(offset,length)=>{ranges.push(offset);return offset===0||readable?source.slice(offset,offset+length):undefined;},
 send:(sequence,blob)=>{sent.push(blob);mirror.acknowledge(sequence,blob.size);},incomplete:assert.fail,complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(8);await turn();await turn();await turn();
 assert.deepEqual(ranges,[0,4]);assert.equal(sent.length,1);assert.equal(mirror.stats.pendingBytes,0);assert.equal(mirror.stats.sentBytes,4);
 readable=true;mirror.update(8);await turn();assert.deepEqual(ranges,[0,4,4]);assert.equal(sent.length,2);
 mirror.seal(8);await turn();assert.equal(completed,1);assert.equal(mirror.stats.complete,true);
});

test('coalesced update and seal wakes retry an unavailable cursor once, then wait for another real wake',async()=>{
 const source=new Blob(['abcdefgh']),sent:Blob[]=[];let resolveRead:(value:Blob|undefined)=>void=()=>{},started:()=>void=()=>{},reads=0,readable=false,completed=0;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:(offset,length)=>{
  reads++;if(reads===1){started();return new Promise(resolve=>{resolveRead=resolve;});}
  return readable?source.slice(offset,offset+length):undefined;
 },send:(_sequence,blob)=>{sent.push(blob);},incomplete:assert.fail,complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(4);await entered;mirror.update(8);mirror.seal(8);mirror.seal(8);resolveRead(undefined);
 await turn();await turn();assert.equal(reads,2);assert.equal(sent.length,0);assert.equal(mirror.stats.complete,false);
 readable=true;mirror.seal(8);await turn();assert.equal(reads,3);assert.equal(sent.length,1);
 mirror.acknowledge(0,4);await turn();assert.equal(reads,4);assert.equal(sent.length,2);
 mirror.acknowledge(1,4);await turn();assert.equal(completed,1);assert.equal(mirror.stats.complete,true);
 assert.equal(mirror.stats.peakPendingBytes,4);assert.equal(await new Blob(sent).text(),'abcdefgh');
});

test('an ACK arriving during an unresolved unavailable read preserves credit and restarts the exact cursor',async()=>{
 const source=new Blob(['abcdefghijkl']),sent:{sequence:number;blob:Blob}[]=[],ranges:number[]=[];
 let resolveRead:(value:Blob|undefined)=>void=()=>{},started:()=>void=()=>{},completed=0;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:(offset,length)=>{
  ranges.push(offset);if(ranges.length===2){started();return new Promise(resolve=>{resolveRead=resolve;});}
  return source.slice(offset,offset+length);
 },send:(sequence,blob)=>{sent.push({sequence,blob});},incomplete:assert.fail,complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:8});
 mirror.update(12);await entered;assert.equal(sent.length,1);mirror.acknowledge(0,4);mirror.seal(12);resolveRead(undefined);await turn();
 assert.deepEqual(ranges,[0,4,4,8]);assert.deepEqual(sent.map(item=>item.sequence),[0,1,2]);
 assert.equal(mirror.stats.pendingBytes,8);assert.equal(mirror.stats.complete,false);
 mirror.acknowledge(1,4);mirror.acknowledge(2,4);await turn();
 assert.equal(completed,1);assert.equal(mirror.stats.complete,true);assert.equal(mirror.stats.acknowledgedBytes,12);
 assert.equal(await new Blob(sent.map(item=>item.blob)).text(),'abcdefghijkl');
});

test('stop cancels a queued wake while a late read cannot send, complete or change terminal offsets',async()=>{
 let resolveRead:(value:Blob|undefined)=>void=()=>{},started:()=>void=()=>{},reads=0,sends=0,completed=0;
 const warnings:string[]=[],entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:()=>{reads++;started();return new Promise(resolve=>{resolveRead=resolve;});},
 send:()=>{sends++;},incomplete:reason=>{warnings.push(reason);},complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(4);await entered;mirror.seal(4);mirror.stop('stop-pending-read');mirror.update(8);mirror.seal(8);
 resolveRead(new Blob(['abcd']));await turn();await turn();
 assert.equal(reads,1);assert.equal(sends,0);assert.equal(completed,0);assert.equal(mirror.stats.availableBytes,4);
 assert.equal(mirror.stats.pendingBytes,0);assert.equal(mirror.stats.complete,false);assert.deepEqual(warnings,['stop-pending-read']);
});

test('an async read rejection suppresses queued wakes and incomplete callback reentry',async()=>{
 let rejectRead:(reason:unknown)=>void=()=>{},started:()=>void=()=>{},reads=0,sends=0,completed=0;
 const warnings:string[]=[],entered=new Promise<void>(resolve=>{started=resolve;});
 const mirror=createArchiveJournalMirror({read:()=>{reads++;started();return new Promise((_resolve,reject)=>{rejectRead=reject;});},
 send:()=>{sends++;},incomplete:reason=>{warnings.push(reason);mirror.update(8);mirror.seal(8);},complete:()=>{completed++;},chunkBytes:4,maxPendingBytes:4});
 mirror.update(4);await entered;mirror.seal(4);rejectRead(new Error('read-failed'));await turn();await turn();
 assert.equal(reads,1);assert.equal(sends,0);assert.equal(completed,0);assert.equal(mirror.stats.availableBytes,4);
 assert.equal(warnings.length,1);assert.match(mirror.stats.error,/read-failed/);assert.equal(mirror.stats.complete,false);
});

test('an empty seal completes once and ignores reentrant terminal updates or credits',async()=>{
 let reads=0,completed=0;const warnings:string[]=[];
 const mirror=createArchiveJournalMirror({read:()=>{reads++;return undefined;},send:()=>assert.fail('empty file sent'),
 incomplete:reason=>{warnings.push(reason);},complete:()=>{
  completed++;mirror.update(4);mirror.seal(4);mirror.acknowledge(0,4);mirror.stop();
 },chunkBytes:4,maxPendingBytes:4});
 mirror.seal(0);await turn();mirror.seal(0);mirror.update(0);await turn();
 assert.equal(reads,0);assert.equal(completed,1);assert.equal(mirror.stats.complete,true);assert.equal(mirror.stats.availableBytes,0);
 assert.equal(mirror.stats.sentBytes,0);assert.equal(mirror.stats.pendingBytes,0);assert.equal(mirror.stats.error,'');assert.deepEqual(warnings,[]);
});

test('complete callback failure remains a single incomplete terminal result',async()=>{
 let attempts=0,reads=0;const warnings:string[]=[];
 const mirror=createArchiveJournalMirror({read:()=>{reads++;return undefined;},send:()=>assert.fail('empty file sent'),
 incomplete:reason=>{warnings.push(reason);},complete:()=>{attempts++;throw Error('complete-failed');},chunkBytes:4,maxPendingBytes:4});
 mirror.seal(0);await turn();mirror.seal(0);mirror.update(0);await turn();
 assert.equal(reads,0);assert.equal(attempts,1);assert.equal(warnings.length,1);assert.match(mirror.stats.error,/complete-failed/);
 assert.equal(mirror.stats.complete,false);assert.equal(mirror.stats.pendingBytes,0);
});
