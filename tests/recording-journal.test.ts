import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedJournal,splitJournalBlob,JOURNAL_CHUNK_BYTES,MAX_JOURNAL_CHUNK_BYTES} from '../src/features/card-scanner/recording-journal';
const chunk=(sequence:number,text:string,kind:'exact'|'video'='exact')=>({kind,sequence,blob:new Blob([text])});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('normal cleanup after a joined journal preserves final success statistics',async()=>{
  const warnings:string[]=[],journal=createBoundedJournal({async write(){},incomplete:reason=>{warnings.push(reason);}});
  await journal.write(chunk(0,'saved'));const final=await journal.finish();assert.equal(final.complete,true);
  journal.dispose();journal.dispose();assert.deepEqual(journal.stats,final);assert.deepEqual(warnings,[]);
  await assert.rejects(journal.write(chunk(1,'too late')),/종료/);assert.deepEqual(journal.stats,final);
});

test('cleanup while finish is still joining a write remains an actual interruption',async()=>{
  let started!:()=>void;const writing=new Promise<void>(resolve=>{started=resolve;}),warnings:string[]=[];
  const journal=createBoundedJournal({write(_chunk,signal){started();return new Promise<void>((_resolve,reject)=>{
    signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});
  });},incomplete:reason=>{warnings.push(reason);}});
  const pending=journal.write(chunk(0,'pending'));void pending.catch(()=>{});await writing;
  const finishing=journal.finish();journal.dispose();await assert.rejects(pending,/중단/);
  const final=await finishing;assert.equal(final.complete,false);assert.equal(final.dropped,1);
  assert.equal(warnings.length,1);journal.dispose();assert.deepEqual(journal.stats,final);
});

test('bounded journal persists separate exact/video sequences in arrival order and releases its backlog',async()=>{
  const written:string[]=[],warnings:string[]=[];
  const journal=createBoundedJournal({async write(value){written.push(`${value.kind}:${value.sequence}:${await value.blob.text()}`);},incomplete:reason=>{warnings.push(reason);}});
  const a=journal.write(chunk(0,'a')),b=journal.write(chunk(0,'b','video')),c=journal.write(chunk(1,'c'));
  await Promise.all([a,b,c]);assert.deepEqual(written,['exact:0:a','video:0:b','exact:1:c']);
  assert.deepEqual(await journal.finish(),{offered:3,written:3,dropped:0,writtenBytes:3,pendingBytes:0,peakPendingBytes:3,complete:true,error:''});
  assert.deepEqual(warnings,[]);await assert.rejects(journal.write(chunk(2,'after')),/종료/);
});

test('slow persistence cannot retain an unlimited backlog and accepted prefix still finishes',async()=>{
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});const written:string[]=[],warnings:string[]=[];
  const journal=createBoundedJournal({async write(value){await blocked;written.push(await value.blob.text());},incomplete:reason=>{warnings.push(reason);}},{maxPendingBytes:5});
  const first=journal.write(chunk(0,'1234'));
  await assert.rejects(journal.write(chunk(1,'56')),/한도/);
  await assert.rejects(journal.write(chunk(2,'later')),/한도/);
  assert.equal(journal.stats.peakPendingBytes,4);release();await first;
  const stats=await journal.finish();assert.deepEqual(written,['1234']);assert.equal(stats.complete,false);assert.equal(stats.pendingBytes,0);
  assert.equal(stats.dropped,1);assert.equal(warnings.length,1);
});

test('failed writes retain only a committed prefix and reporting errors cannot escape the queue',async()=>{
  let calls=0;
  const journal=createBoundedJournal({async write(){if(++calls===2)throw Error('quota');},incomplete(){throw Error('report failed');}});
  const results=await Promise.allSettled([journal.write(chunk(0,'a')),journal.write(chunk(1,'b')),journal.write(chunk(2,'c'))]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[2].status,'rejected');
  const stats=await journal.finish();assert.equal(stats.written,1);assert.equal(stats.dropped,2);assert.equal(stats.pendingBytes,0);assert.match(stats.error,/quota/);
});

test('write timeout aborts the target transaction and permits background finalization to settle',async()=>{
  let aborted=false;
  const journal=createBoundedJournal({write(_value,signal){return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>{aborted=true;reject(signal!.reason);}));},incomplete(){}},{timeoutMs:10});
  await assert.rejects(journal.write(chunk(0,'a')),/시간 초과/);
  const stats=await journal.finish();assert.equal(aborted,true);assert.equal(stats.complete,false);assert.equal(stats.pendingBytes,0);
});

test('dispose aborts active work and releases queued chunks without waiting for a target that ignores cancellation',async()=>{
  let aborted=false;
  const journal=createBoundedJournal({write(_value,signal){signal!.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});},incomplete(){}},{timeoutMs:1000});
  const first=journal.write(chunk(0,'a')),second=journal.write(chunk(1,'b'));
  const firstHandled=assert.rejects(first),secondHandled=assert.rejects(second);await turn();journal.dispose();
  await Promise.all([firstHandled,secondHandled]);assert.equal(aborted,true);assert.equal((await journal.finish()).pendingBytes,0);
});

test('invalid sequence and oversized chunks fail explicitly; Blob slicing preserves every encoded byte',async()=>{
  for(const value of [chunk(1,'bad'),{...chunk(0,'a'),blob:new Blob([new Uint8Array(MAX_JOURNAL_CHUNK_BYTES+1)])}]){
    const journal=createBoundedJournal({async write(){assert.fail('invalid chunk must not reach storage');},incomplete(){}});
    await assert.rejects(journal.write(value));assert.equal((await journal.finish()).complete,false);
  }
  const bytes=Uint8Array.from({length:JOURNAL_CHUNK_BYTES*2+7},(_,index)=>index%251),parts=[...splitJournalBlob('exact',new Blob([bytes]))];
  assert.deepEqual(parts.map(part=>[part.sequence,part.blob.size]),[[0,JOURNAL_CHUNK_BYTES],[1,JOURNAL_CHUNK_BYTES],[2,7]]);
  assert.deepEqual(new Uint8Array(await new Blob(parts.map(part=>part.blob)).arrayBuffer()),bytes);
});

test('one producer losing input does not stop the other stream or discard its pending prefix',async()=>{
  const stored:string[]=[],warnings:string[]=[];
  const journal=createBoundedJournal({async write(value){stored.push(`${value.kind}:${await value.blob.text()}`);},incomplete:reason=>{warnings.push(reason);}});
  const first=journal.write(chunk(0,'first'));
  journal.incomplete('preview producer backlog exceeded');
  await Promise.all([first,journal.write(chunk(1,'second')),journal.write(chunk(2,'last'))]);
  const stats=await journal.finish();
  assert.deepEqual(stored,['exact:first','exact:second','exact:last']);
  assert.equal(stats.complete,false);assert.equal(stats.written,3);assert.equal(stats.pendingBytes,0);
  assert.equal(warnings.length,1);assert.match(stats.error,/preview/);
});

test('a later storage failure still closes both streams after a producer loss was reported',async()=>{
  let calls=0;
  const journal=createBoundedJournal({async write(){calls++;throw Error('quota');},incomplete(){}});
  journal.incomplete('preview lost');
  await assert.rejects(journal.write(chunk(0,'raw')),/quota/);
  await assert.rejects(journal.write(chunk(0,'preview','video')));
  const stats=await journal.finish();assert.equal(calls,1);assert.equal(stats.complete,false);assert.equal(stats.pendingBytes,0);
});

test('an empty producer loss reason still prevents a complete recording claim',async()=>{
  const journal=createBoundedJournal({async write(){},incomplete(){}});
  journal.incomplete(' ');await journal.write(chunk(0,'usable'));
  const stats=await journal.finish();assert.equal(stats.complete,false);assert.ok(stats.error.length);
});
