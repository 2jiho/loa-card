import { test } from "node:test";
import assert from "node:assert/strict";
import {createHash} from 'node:crypto';
import { recordContinuous } from "../src/features/card-scanner/continuous-capture";
import {createBoundedJournal,JOURNAL_CHUNK_BYTES,JOURNAL_PENDING_BYTES} from '../src/features/card-scanner/recording-journal';

class FakeRecorder extends EventTarget {
  static instance: FakeRecorder;
  static isTypeSupported(type: string) { return type.includes("vp8"); }
  state = "inactive";
  mimeType: string;
  requestedBitrate: number;
  stopCalls = 0;
  constructor(_stream: unknown, options: { mimeType: string; videoBitsPerSecond: number }) {
    super(); this.mimeType = options.mimeType; this.requestedBitrate = options.videoBitsPerSecond; FakeRecorder.instance = this;
  }
  start() { this.state = "recording"; }
  data(text: string) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([text]) }));
  }
  stop() {
    this.state = "inactive"; this.stopCalls++;
    queueMicrotask(() => { this.data("tail"); this.dispatchEvent(new Event("stop")); });
  }
}
const Recorder = FakeRecorder as unknown as typeof MediaRecorder;
test('missing recorder stop event has a deadline and ignores late chunks', {timeout:2000},async()=>{
  class StuckRecorder extends FakeRecorder {stop(){this.state='inactive';this.stopCalls++;}}
  const warnings:string[]=[];
  const capture=recordContinuous({} as MediaStream,m=>warnings.push(m),StuckRecorder as unknown as typeof MediaRecorder,1024,15);
  FakeRecorder.instance.data('initial');const pending=capture.finish();
  assert.equal(capture.finish(),pending);assert.equal(await pending,undefined);
  FakeRecorder.instance.data('late');FakeRecorder.instance.dispatchEvent(new Event('stop'));
  assert.equal(await capture.finish(),undefined);assert.equal(warnings.length,1);assert.match(warnings[0],/시간 초과/);
});
test('throwing recorder stop settles without waiting for a nonexistent event',async()=>{
  class BrokenRecorder extends FakeRecorder {stop(){throw Error('broken');}}
  const capture=recordContinuous({} as MediaStream,()=>{},BrokenRecorder as unknown as typeof MediaRecorder);
  assert.equal(await capture.finish(),undefined);
});
test("screen recording requests text detail and a resolution-aware bitrate on the actual encoder", async () => {
  const track = { contentHint: "", getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }) };
  const before = performance.now();
  const capture = recordContinuous({ getVideoTracks: () => [track] } as unknown as MediaStream, () => {}, Recorder);
  assert.ok(capture.startedAt >= before && capture.startedAt <= performance.now());
  assert.equal(track.contentHint, "text");
  assert.equal(FakeRecorder.instance.requestedBitrate, 33_177_600);
  assert.ok(await capture.finish());
});
test("continuous recording preserves encoded chunks including stop's final chunk", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder);
  FakeRecorder.instance.data("first"); FakeRecorder.instance.data("second");
  const result = await capture.finish();
  assert.ok(result); assert.equal(await result.blob.text(), "firstsecondtail");
  assert.equal(result.blob.type, "video/webm;codecs=vp8");
  assert.equal(await capture.finish(), result); assert.equal(FakeRecorder.instance.stopCalls, 1);
  assert.deepEqual(warnings, []);
});
test("a truncated recording is never replayed as if it covered the entire scan", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder, 5);
  FakeRecorder.instance.data("123456");
  assert.equal(await capture.finish(), undefined);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /용량/);
});
test("encoder failure is reported without returning a partial recovery video", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder);
  FakeRecorder.instance.data("first"); FakeRecorder.instance.dispatchEvent(new Event("error"));
  assert.equal(await capture.finish(), undefined);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /실패/);
});

test('disk spool preserves order, flushes tail and disposes on explicit release',async()=>{
 const written:string[]=[];let disposed=0;
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,async()=>({
  async write(blob){written.push(await blob.text());},async finish(type){return new Blob(written,{type});},async dispose(){disposed++;},
 }));
 FakeRecorder.instance.data('a');FakeRecorder.instance.data('b');
 const result=await capture.finish();assert.ok(result);assert.deepEqual(written,['a','b','tail']);
 assert.equal(disposed,0);await result.dispose?.();assert.equal(disposed,1);
});
test('slow disk cannot accumulate unbounded encoded chunks',async()=>{
 let release!:()=>void,disposed=0;const messages:string[]=[];
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const capture=recordContinuous({} as MediaStream,m=>messages.push(m),Recorder,1024,1000,async()=>({
  async write(){await blocked;},async finish(){return new Blob(['unused']);},async dispose(){disposed++;},
 }),5);
 FakeRecorder.instance.data('1234');FakeRecorder.instance.data('56');release();
 assert.equal(await capture.finish(),undefined);assert.equal(messages.length,1);assert.match(messages[0],/한도/);
 for(let i=0;i<10;i++)await Promise.resolve();assert.equal(disposed,1);
});
test('disk errors return no misleading full recording and do not throw through scanner callbacks',async()=>{
 const messages:string[]=[];
 const capture=recordContinuous({} as MediaStream,m=>messages.push(m),Recorder,1024,1000,async()=>({
  async write(){throw Error('quota');},async finish(){throw Error('unexpected');},async dispose(){},
 }));
 FakeRecorder.instance.data('source');assert.equal(await capture.finish(),undefined);assert.match(messages[0],/quota/);
});

test('continuous journal preserves encoded order and tail without delaying the recovery video',async()=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),chunks:Blob[]=[];
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,undefined,undefined,{
  async write(chunk){await blocked;chunks.push(chunk.blob);},incomplete:assert.fail,
 });
 FakeRecorder.instance.data('first');FakeRecorder.instance.data('second');
 const raw=await capture.finish();assert.ok(raw);assert.equal(await raw.blob.text(),'firstsecondtail');assert.equal(chunks.length,0);
 const finalizing=raw.finishJournal!();release();const journal=await finalizing;
 assert.equal(await new Blob(chunks).text(),'firstsecondtail');assert.equal(journal.complete,true);assert.equal(journal.bytes,15);assert.equal(journal.chunks,3);
 await raw.dispose?.();
});

test('journal quota failure leaves the recovery video intact and marks a partial durable prefix',async()=>{
 const warnings:string[]=[],stored:string[]=[];
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,undefined,undefined,{
  async write(chunk){if(chunk.sequence===1)throw Error('quota');stored.push(await chunk.blob.text());},incomplete:reason=>{warnings.push(reason);},
 });
 FakeRecorder.instance.data('first');FakeRecorder.instance.data('second');const raw=await capture.finish();assert.ok(raw);
 const journal=await capture.finishJournal();assert.equal(await raw.blob.text(),'firstsecondtail');assert.equal(journal.complete,false);assert.match(journal.error,/quota/);assert.equal(warnings.length,1);assert.deepEqual(stored,['first'],'a failed middle chunk must not be followed by a stored tail');
 await raw.dispose?.();
});

test('continuous journal finalization cannot wait forever for a blocked sink',async()=>{
 let aborted=false;
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,undefined,undefined,{
  write(_chunk,signal){signal!.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});},incomplete(){},
 });
 FakeRecorder.instance.data('source');const raw=await capture.finish();assert.ok(raw);
 const journal=await raw.finishJournal!(10);assert.equal(journal.complete,false);assert.equal(aborted,true);assert.match(journal.error,/시간 초과/);
 assert.equal(capture.journalBufferedBytes,0);assert.equal(capture.journalPendingEvents,0);await raw.dispose?.();
});

test('a single 9MiB encoder event flows sequentially through the actual 8MiB common journal without blocking the recovery video',async()=>{
 let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const chunks:{sequence:number;blob:Blob}[]=[],losses:string[]=[];
 let concurrent=0,peakConcurrent=0;
 const common=createBoundedJournal({
  async write(chunk){concurrent++;peakConcurrent=Math.max(peakConcurrent,concurrent);entered();await blocked;
   chunks.push({sequence:chunk.sequence,blob:chunk.blob});concurrent--;},incomplete:reason=>{losses.push(reason);},
 });
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,32*1024*1024,1000,undefined,16*1024*1024,common);
 const source=new Uint8Array(9*1024*1024);for(let index=0;index<source.length;index++)source[index]=index%251;
 const encoded=new Blob([source]);
 FakeRecorder.instance.dispatchEvent(Object.assign(new Event('dataavailable'),{data:encoded}));
 await started;
 const raw=await capture.finish();assert.ok(raw);assert.equal(chunks.length,0,'the optional mirror cannot hold recovery-video completion');
 assert.equal(capture.journalStats.error,'');assert.ok(capture.journalBufferedBytes>=encoded.size);
 assert.ok(capture.journalStats.peakPendingBytes<=16*1024*1024);
 const finalizing=raw.finishJournal!();release();const mirrored=await finalizing;
 assert.equal(mirrored.complete,true);assert.equal(mirrored.bytes,encoded.size+4);assert.equal(mirrored.chunks,37);
 assert.equal(peakConcurrent,1);assert.ok(common.stats.peakPendingBytes<=JOURNAL_CHUNK_BYTES);
 assert.ok(common.stats.peakPendingBytes<JOURNAL_PENDING_BYTES);
 assert.deepEqual(chunks.map(chunk=>chunk.sequence),Array.from({length:37},(_,index)=>index));
 assert.ok(chunks.every(chunk=>chunk.blob.size<=JOURNAL_CHUNK_BYTES));
 const hash=async(blob:Blob)=>createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
 const expected=new Blob([encoded,'tail']);
 assert.equal(await hash(new Blob(chunks.map(chunk=>chunk.blob))),await hash(expected));
 assert.equal(await hash(raw.blob),await hash(expected));assert.deepEqual(losses,[]);
 assert.equal(capture.journalBufferedBytes,0);assert.equal(capture.journalPendingEvents,0);
 assert.equal((await common.finish()).complete,true);await raw.dispose?.();
});

test('a blocked event mirror rejects only its own backlog overflow while preserving the recovery video and an ordered stored prefix',async()=>{
 let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const stored:{sequence:number;text:string}[]=[],losses:string[]=[],rawWarnings:string[]=[],spooled:Blob[]=[];
 const capture=recordContinuous({} as MediaStream,message=>rawWarnings.push(message),Recorder,1024,1000,async()=>({
  async write(blob){spooled.push(blob);},async finish(type){return new Blob(spooled,{type});},async dispose(){},
 }),64,{
  async write(chunk){entered();await blocked;stored.push({sequence:chunk.sequence,text:await chunk.blob.text()});},
  incomplete:reason=>{losses.push(reason);},
 });
 FakeRecorder.instance.data('A'.repeat(40));await started;
 for(let index=0;index<20;index++)await Promise.resolve();
 assert.equal(capture.bufferedBytes,0,'spool can drain even though the optional mirror is blocked');
 FakeRecorder.instance.data('B'.repeat(32));
 const raw=await capture.finish();assert.ok(raw);assert.equal(await raw.blob.text(),'A'.repeat(40)+'B'.repeat(32)+'tail');
 assert.deepEqual(rawWarnings,[]);assert.equal(losses.length,1);assert.match(losses[0],/저장 대기 한도/);
 assert.equal(capture.journalStats.peakPendingBytes,40);
 release();const journal=await raw.finishJournal!();
 assert.equal(journal.complete,false);assert.deepEqual(stored,[{sequence:0,text:'A'.repeat(40)}]);
 assert.equal(capture.journalBufferedBytes,0);assert.equal(capture.journalPendingEvents,0);await raw.dispose?.();
});

test('tiny encoder events also have a bounded descriptor count and cannot multiply pending mirror work without limit',async()=>{
 const losses:string[]=[],stored:Blob[]=[];
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,4096,1000,undefined,1024,{
  async write(chunk){stored.push(chunk.blob);},incomplete:reason=>{losses.push(reason);},
 });
 for(let index=0;index<257;index++)FakeRecorder.instance.data('x');
 assert.equal(capture.journalPendingEvents,256);assert.equal(capture.journalBufferedBytes,256);
 const raw=await capture.finish();assert.ok(raw);assert.equal(await raw.blob.text(),'x'.repeat(257)+'tail');
 const journal=await raw.finishJournal!();assert.equal(journal.complete,false);assert.equal(losses.length,1);
 assert.equal(stored.length,0);assert.equal(capture.journalPendingEvents,0);assert.equal(capture.journalBufferedBytes,0);
 await raw.dispose?.();
});

test('a mirror deadline aborts its active write, releases queued event backing and prevents a late target commit',async()=>{
 let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 let attempted=0,committed=0,aborted=false;
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,undefined,undefined,{
  async write(_chunk,signal){attempted++;entered();signal!.addEventListener('abort',()=>{aborted=true;});
   await blocked;signal!.throwIfAborted();committed++;},incomplete(){},
 });
 FakeRecorder.instance.data('first');FakeRecorder.instance.data('second');await started;
 const raw=await capture.finish();assert.ok(raw);assert.equal(attempted,1);
 const journal=await raw.finishJournal!(10);assert.equal(journal.complete,false);assert.equal(aborted,true);
 assert.equal(capture.journalBufferedBytes,0);assert.equal(capture.journalPendingEvents,0);
 release();for(let index=0;index<10;index++)await Promise.resolve();
 assert.equal(committed,0);assert.equal(attempted,1,'a failed prefix cannot be followed by a stored later event');
 await raw.dispose?.();
});

test('explicit release also settles a noncooperative mirror without retaining the producer event queue',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const capture=recordContinuous({} as MediaStream,assert.fail,Recorder,1024,1000,undefined,undefined,{
  write(){entered();return new Promise(()=>{});},incomplete(){},
 });
 FakeRecorder.instance.data('first');FakeRecorder.instance.data('second');await started;
 const raw=await capture.finish();assert.ok(raw);await raw.dispose?.();
 assert.equal(capture.journalBufferedBytes,0);assert.equal(capture.journalPendingEvents,0);
 const journal=await capture.finishJournal(10);assert.equal(journal.complete,false);assert.match(journal.error,/중단/);
});
