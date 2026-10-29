import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {beginReproduction,clearReproduction,listReproductionSessions,createReproductionBundle,openReproduction} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore,SessionStorageLimitError} from '../src/features/card-scanner/reproduction-session-store';
import type {ReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import type {ExactRecorder} from '../src/features/card-scanner/exact-recording';
import type {RecordingJournal} from '../src/features/card-scanner/recording-journal';
import {exactPixels} from '../src/features/card-scanner/exact-recording-codec';
import {RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';
import {createCanonicalFinalizationFixture} from './helpers/canonical-finalization-fixture';

const environment={browser:'test',catalog:'test',build:'test'};
async function capacityRun(options:{complete?:boolean;postReadFailure?:boolean;producerLoss?:boolean;missingCheckpoint?:boolean}={}){
 const fixture=await createCanonicalFinalizationFixture({extraFrameBytes:256*1024,codecPolicy:RGBA_WINDOW_POLICY});
 const recording=options.missingCheckpoint?fixture.recordingFrom(fixture.entries.filter(e=>e.header.kind!=='event'||e.header.type!=='freshness-checkpoint')):
  options.producerLoss?fixture.recordingFrom(undefined,{complete:false,error:'source loss'}):fixture.recording;
 const store=createReproductionSessionStore({dbName:`canonical-integration-${crypto.randomUUID()}`,
  limits:{maxBytes:400000,detailsReserveBytes:65536}});
 let journal!:RecordingJournal,producerDisposed=false,previewDisposed=false,committed=false,legacySeals=0,prepares=0;
 const wrapped:ReproductionSessionStore={...store,
  async prepareExactFinalization(...args){assert.equal(producerDisposed,false);assert.equal(previewDisposed,false);prepares++;
   return store.prepareExactFinalization(...args);},
  async commitExactFinalization(...args){assert.equal(producerDisposed,false);assert.equal(previewDisposed,false);
   const index=await store.commitExactFinalization(...args);committed=true;return index;},
  async getSession(...args){if(committed&&options.postReadFailure)throw Error('post-commit read failed');return store.getSession(...args);},
  async sealSession(...args){legacySeals++;return store.sealSession(...args);},
 };
 const exact={setJournal(value:RecordingJournal){journal=value;},async finish(){return recording;},
  async dispose(){producerDisposed=true;}} as unknown as ExactRecorder;
 const run=beginReproduction([],environment,{record:true,store:wrapped,exact});await run.ready;
 const preview=new Blob([new Uint8Array(100000)],{type:'video/webm'});
 run.options.continuous!({blob:preview,duration:1,async dispose(){previewDisposed=true;}});
 await journal.write({kind:'video',sequence:0,blob:preview});
 await journal.write({kind:'exact',sequence:0,blob:recording.blob.slice(0,100000)});
 await journal.write({kind:'exact',sequence:1,blob:recording.blob.slice(100000,200000)});
 await assert.rejects(journal.write({kind:'exact',sequence:2,blob:recording.blob.slice(200000)}),SessionStorageLimitError);
 const prefix=(await store.getSession(run.id))!;assert.equal(prefix.index.status,'partial');assert.equal(prefix.exact!.size,200000);
 return {run,store,recording,prefix,finish:()=>run.finish(undefined,options.complete??true),
  counters:()=>({producerDisposed,previewDisposed,committed,legacySeals,prepares})};
}

test('full live-owned canonical producer repairs the actual byte prefix and omits only the durable preview',async()=>{
 const h=await capacityRun(),file=(await h.finish())!,stored=(await h.store.getSession(h.run.id))!;
 assert.equal(stored.index.status,'complete');assert.equal(stored.index.sealed,true);assert.equal(stored.video.size,0);
 assert.equal(stored.exact!.size,h.recording.blob.size);assert.ok(stored.index.bytes<=400000);
 assert.equal(stored.exactFinalization?.storedExactBytes,200000);assert.equal(stored.exactFinalization?.omittedVideoBytes,100000);
 assert.equal(stored.exactFinalization?.originalCapacityFailure?.kind,'storage-capacity');
 assert.equal(stored.index.reason,undefined);assert.equal(stored.index.failure,undefined);
 assert.equal(h.run.journalStats().complete,false,'historical journal failure is not erased');
 assert.deepEqual(h.counters(),{producerDisposed:true,previewDisposed:true,committed:true,legacySeals:0,prepares:1});
 assert.equal(file.metadata.version,6);assert.equal(file.metadata.recordState,'complete');assert.equal(file.metadata.exact?.complete,true);
 const opened=await openReproduction(createReproductionBundle(file),new AbortController().signal);
 assert.equal(opened.video.size,0);assert.deepEqual(await opened.exact!.arrayBuffer(),await h.recording.blob.arrayBuffer());
 let pixels=0;for await(const frame of exactPixels(opened.exact!,new AbortController().signal,0,RGBA_WINDOW_POLICY)){assert.ok(frame.pixels.length);pixels++;}
 assert.equal(pixels,2,'both used and unused physical frames remain independently decodable');
 const timing=h.run.finalizationTiming();assert.notEqual(timing.canonicalVerifyMs,null);assert.notEqual(timing.canonicalCommitMs,null);
});

for(const complete of [true,false])test(`post-commit read failure never re-seals stale metadata (scan completed=${complete})`,async()=>{
 const h=await capacityRun({complete,postReadFailure:true});await assert.rejects(h.finish(),/post-commit read failed/);
 const stored=(await h.store.getSession(h.run.id))!;
 assert.equal(stored.index.status,complete?'complete':'partial');assert.equal(stored.index.sealed,true);
 assert.equal(stored.video.size,0);assert.equal(stored.exact!.size,h.recording.blob.size);assert.ok(stored.exactFinalization);
 assert.equal(h.counters().legacySeals,0);assert.equal(h.counters().producerDisposed,true);assert.equal(h.counters().previewDisposed,true);
 assert.equal(h.run.finalizationTiming().status,'rejected');assert.ok(h.run.finalizationTiming().failedStages.includes('postSealLoad'));
});

for(const issue of ['producerLoss','missingCheckpoint'] as const)test(`${issue} retains preview and partial input without promotion`,async()=>{
 const h=await capacityRun({[issue]:true});await h.finish();const stored=(await h.store.getSession(h.run.id))!;
 assert.equal(stored.index.status,'partial');assert.equal(stored.index.sealed,true);assert.equal(stored.video.size,100000);
 assert.equal(stored.exact!.size,h.prefix.exact!.size);assert.equal(stored.exactFinalization,undefined);
 assert.equal(h.counters().committed,false);assert.equal(h.counters().prepares,0);assert.equal(h.counters().legacySeals,1);
 assert.equal(h.counters().producerDisposed,true);assert.equal(h.counters().previewDisposed,true);
});

test('reset cancels a pending canonical proof and cannot restore the deleted session after its read returns',async()=>{
 await clearReproduction();
 const fixture=await createCanonicalFinalizationFixture({codecPolicy:RGBA_WINDOW_POLICY});
 let entered!:()=>void,release!:()=>void,disposed=0,journal!:RecordingJournal;
 const reading=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 class DelayedBlob extends Blob {
  override slice(start?:number,end?:number,type?:string){
   const part=super.slice(start,end,type);
   return new class extends Blob {
    override async arrayBuffer(){entered();await blocked;return super.arrayBuffer();}
   }([part],{type:part.type});
  }
 }
 const recording={...fixture.recording,blob:new DelayedBlob([fixture.recording.blob])};
 const exact={setJournal(value:RecordingJournal){journal=value;},async finish(){return recording;},
  async dispose(){disposed++;}} as unknown as ExactRecorder;
 const run=beginReproduction([],environment,{record:true,exact});await run.ready;
 // A real durable prefix, not a mock completed file: this enters reconciliation.
 await journal.write({kind:'exact',sequence:0,blob:fixture.recording.blob.slice(0,32)});
 const finished=run.finish(undefined,true);
 let timeout:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Reset did not cancel pending proof')),2000);});
 try{
  await Promise.race([reading,deadline]);
  await clearReproduction();
  assert.equal(await Promise.race([finished,deadline]),undefined);
  assert.equal(disposed,1);
  assert.ok(run.finalizationTiming().failedStages.includes('canonicalVerify'));
  assert.equal((await listReproductionSessions()).some(row=>row.id===run.id),false);
  release();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal((await listReproductionSessions()).some(row=>row.id===run.id),false);
 }finally{clearTimeout(timeout);release();await finished;await clearReproduction();}
});
