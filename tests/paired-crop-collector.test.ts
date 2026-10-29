import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPairedCropCollector,PAIRED_CROP_LIMITS} from '../dev/paired-crop-collector';
import type {RecognitionInputMeta,RecognitionInputOutcome,NameLabelRecipe} from '../src/features/card-scanner/recognition-input-observer';

const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
const uri=`data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const target={processingFrame:97,slot:32};
const meta=(read=1,changes:Partial<RecognitionInputMeta>={}):RecognitionInputMeta=>({
 diagnosticReadId:read,...target,source:{sessionId:'selected-source',frameId:83,observationId:'frame83-slot32',captureOrder:83,captureTime:4.225,phase:'input',slot:32},
 group:2,trace:8,pixelKey:'actual-pixels-83-32',stage:'full',stable:true,borderAlignment:0.98,
 sourceBox:{x:150,y:200,width:2,height:1},sourceWidth:1920,sourceHeight:1080,cropWidth:2,cropHeight:1,...changes,
});
const outcome=(changes:Partial<RecognitionInputOutcome>={}):RecognitionInputOutcome=>({
 admitted:true,identifyExecuted:true,nameMatchCount:0,budgetRemainingAtStart:150,budgetRemainingAtEnd:4,elapsedMs:146,timedOut:false,error:null,
 identified:null,acceptedIdentity:null,status:'unknown',retained:false,diagnostics:[],...changes,
});
const recipe=(changes:Partial<NameLabelRecipe>={}):NameLabelRecipe=>({region:'initial-name-label',sourceBox:{x:8,y:7,width:100,height:27},
 targetWidth:128,targetHeight:36,offsetY:0,quick:false,allowRaw:true,bypassCache:false,...changes});
const label=()=>({width:128,height:36,data:new Uint8ClampedArray(128*36*4).fill(100)});
function card(width=2,height=1){
 const source=new Uint8ClampedArray(width*height*4).fill(170);let reads=0;
 return {source,get reads(){return reads;},canvas:{width,height,getContext:()=>({getImageData:()=>{reads++;return {data:source.slice()};}})} as unknown as HTMLCanvasElement};
}
type Request={kind:string;id:number;width:number;height:number;pixels:ArrayBuffer;maxImageBytes:number};
class FakeWorker {
 onmessage:Worker['onmessage']=null;onerror:Worker['onerror']=null;onmessageerror:Worker['onmessageerror']=null;
 requests:Request[]=[];terminations=0;sentBuffers:ArrayBuffer[]=[];
 constructor(readonly automatic=true,readonly ack=true){}
 postMessage(value:unknown,transfer:Transferable[]=[]){
  const request=structuredClone(value,{transfer}) as Request;
  if(request.kind==='encode-rgba'){
   this.sentBuffers.push((value as Request).pixels);this.requests.push(request);
   if(this.automatic)queueMicrotask(()=>this.reply(request));
  }else if(request.kind==='dispose'&&this.ack)queueMicrotask(()=>this.emit({kind:'disposed',id:request.id,acknowledged:true}));
 }
 emit(value:unknown){this.onmessage?.call(this as unknown as Worker,{data:value} as MessageEvent);}
 result(request:Request=this.requests.at(-1)!){const hash=sha(new Uint8Array(request.pixels));return {kind:'result',id:request.id,status:request.maxImageBytes<uri.length?'omitted-budget':'encoded',
  width:request.width,height:request.height,rgbaSha256:hash,rasterRgbaSha256:hash,rgbaMatchesRaster:true,pngSha256:request.maxImageBytes<uri.length?null:sha(png),
  pngBytes:png.length,imageBytes:request.maxImageBytes<uri.length?null:uri.length,image:request.maxImageBytes<uri.length?null:uri,error:null};}
 reply(request:Request=this.requests.at(-1)!,changes:Record<string,unknown>={}){this.emit({...this.result(request),...changes});}
 terminate(){this.terminations++;}
}
function fixture(options:Parameters<typeof createPairedCropCollector>[1]={},workerFactory:()=>FakeWorker=()=>new FakeWorker()){
 const workers:FakeWorker[]=[];
 const collector=createPairedCropCollector([target],{...options,createWorker:()=>{const worker=workerFactory();workers.push(worker);return worker;}});
 return {collector,workers};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('selects exact processing frame/slot and defers all worker/hash/PNG work until finish',async()=>{
 const {collector,workers}=fixture(),crop=card();
 assert.equal(collector.begin(meta(99,{processingFrame:96})),undefined);
 const input=collector.begin(meta())!;input.captureCard(crop.canvas);const pixels=label(),original=pixels.data.slice();
 input.captureLabel(pixels,recipe());input.finish(outcome({nameMatchCount:1}));
 assert.equal(workers.length,0);assert.equal(crop.reads,1);
 assert.equal(collector.snapshot().images.length,2);assert.equal(collector.snapshot().stats.rawReservedBytes>0,true);
 pixels.data.fill(4);crop.source.fill(3);
 const evidence=await collector.finish();
 assert.equal(workers.length,1);assert.equal(workers[0].requests.length,2);assert.equal(evidence.complete,true);
 assert.equal(evidence.images[0].rgbaSha256,sha(new Uint8Array(8).fill(170)));
 assert.equal(evidence.images[1].rgbaSha256,sha(original));assert.equal(pixels.data.byteLength,original.length);
 assert.ok(workers[0].sentBuffers.every(buffer=>buffer.byteLength===0),'only collector-owned buffers are transferred');
 assert.ok(evidence.images.every(image=>image.rgbaSha256===image.rasterRgbaSha256&&image.rgbaMatchesRaster===true&&image.pngSha256===sha(png)));
 assert.equal(evidence.stats.rawReservedBytes,0);assert.equal(evidence.stats.pending,0);
 assert.deepEqual(evidence.workerCleanup,{acknowledged:true,forced:false,workerTerminated:true,error:null});
 assert.equal(Object.hasOwn(evidence.images[0],'bitmapClosed'),false);
 assert.match(evidence.scopes.pixelHashes,/no acquisition Worker or model-tensor hash/);
 await collector.dispose();assert.equal(workers[0].terminations,1);
});

test('same observation and region retries share storage but preserve separate diagnostic outcomes',async()=>{
 const {collector}=fixture();
 for(let ordinal=1;ordinal<=2;ordinal++){
  const input=collector.begin(meta(ordinal))!;input.captureCard(card().canvas);
  input.captureLabel(label(),recipe({quick:ordinal===1,bypassCache:ordinal===2}));
  input.finish(outcome({nameMatchCount:1,status:ordinal===1?'unknown':'accepted',retained:ordinal===2}));
 }
 const evidence=await collector.finish();assert.equal(evidence.images.length,2);assert.equal(evidence.rows.length,2);
 assert.equal(evidence.rows[1].card?.imageId,evidence.rows[0].card?.imageId);assert.equal(evidence.rows[1].card?.shared,true);
 assert.equal(evidence.rows[1].labels[0].reference.shared,true);assert.equal(evidence.rows[1].labels[0].recipe.bypassCache,true);
 assert.equal(evidence.rows[0].outcome?.status,'unknown');assert.equal(evidence.rows[1].outcome?.status,'accepted');
 assert.match(evidence.scopes.sharedReferences,/not independent/);assert.equal(evidence.complete,true);
});

test('a different actual label ROI cannot reuse a prior ROI as the exact input',async()=>{
 const {collector}=fixture();const input=collector.begin(meta())!;input.captureCard(card().canvas);
 input.captureLabel(label(),recipe());input.captureLabel(label(),recipe({offsetY:2}));input.finish(outcome({nameMatchCount:2}));
 const evidence=await collector.finish();assert.equal(evidence.images.length,2);assert.equal(evidence.rows[0].labels.length,2);
 assert.equal(evidence.rows[0].labels[1].reference.imageId,null);assert.equal(evidence.rows[0].labels[1].reference.exactRegion,false);
 assert.match(evidence.rows[0].labels[1].reference.omitted!,/different-geometry/);assert.equal(evidence.complete,false);
});

test('capture/raw/image limits omit images explicitly without losing outcomes or allocating rejected pixels',async()=>{
 const count=fixture({maxCaptures:1}),input=count.collector.begin(meta())!;input.captureCard(card().canvas);input.captureLabel(label(),recipe());input.finish(outcome({nameMatchCount:1}));
 const counted=await count.collector.finish();assert.equal(counted.images.length,1);assert.equal(counted.rows[0].labels[0].reference.omitted,'capture-count-bound');assert.equal(counted.complete,false);
 const raw=fixture({maxRawBytes:23}),crop=card(),r=raw.collector.begin(meta())!;r.captureCard(crop.canvas);r.finish(outcome());
 const bounded=await raw.collector.finish();assert.equal(crop.reads,0);assert.equal(bounded.stats.peakRawReservedBytes,0);assert.equal(bounded.rows[0].card?.omitted,'raw-byte-bound');assert.equal(bounded.complete,false);
 const image=fixture({maxImageBytes:uri.length}),i=image.collector.begin(meta())!;i.captureCard(card().canvas);i.captureLabel(label(),recipe());i.finish(outcome({nameMatchCount:1}));
 const encoded=await image.collector.finish();assert.equal(encoded.stats.imageBytes,uri.length);assert.equal(encoded.images[1].status,'omitted-budget');assert.equal(encoded.images[1].image,null);assert.equal(encoded.complete,false);
});

test('long escaped/unicode keys reserve actual image metadata before copying and preserve bounded diagnostics',async()=>{
 const {collector}=fixture();const input=collector.begin(meta(1,{pixelKey:'\u0000'.repeat(4096)}))!;input.captureCard(card().canvas);
 const diagnostics=Array.from({length:100},()=>({text:'한'.repeat(120),confidence:23,engine:'engine',variant:'variant',reason:'\u0000'.repeat(300),
  candidates:[{id:'id',name:'이름',score:12}]}));
 input.finish(outcome({diagnostics}));const evidence=await collector.finish();
 const recordedOutcome=evidence.rows[0].outcome!;
 assert.equal(diagnostics.length,100);assert.equal((recordedOutcome.diagnostics as unknown[]).length+Number(recordedOutcome.diagnosticsOmitted),100);assert.equal(evidence.complete,false);
 assert.ok(evidence.stats.metadataBytes<=evidence.stats.metadataReservedBytes);assert.ok(evidence.stats.metadataReservedBytes<=PAIRED_CROP_LIMITS.maxMetadataBytes);
 const small=fixture({maxMetadataBytes:6000}),s=small.collector.begin(meta())!;const crop=card();s.captureCard(crop.canvas);s.finish(outcome());
 const omitted=await small.collector.finish();assert.equal(crop.reads,0);assert.equal(omitted.rows[0].card?.omitted,'metadata-byte-bound');assert.equal(omitted.complete,false);
});

test('missing targets, missing actual labels/card, unfinished rows and empty evidence cannot report complete',async()=>{
 const empty=fixture();const emptyResult=await empty.collector.finish();assert.equal(emptyResult.complete,false);assert.deepEqual(emptyResult.missingTargets,[target]);
 for(const mode of ['card','label','unfinished'] as const){
  const {collector}=fixture();const input=collector.begin(meta())!;
  if(mode!=='card')input.captureCard(card().canvas);
  if(mode!=='unfinished')input.finish(outcome({nameMatchCount:mode==='label'?1:0}));
  const result=await collector.finish();assert.equal(result.complete,false,mode);
 }
});

test('PNG paint mismatch preserves raw and raster hashes but cannot retain an exact-input image',async()=>{
 const {collector,workers}=fixture({},()=>new FakeWorker(false));const input=collector.begin(meta())!;input.captureCard(card().canvas);input.finish(outcome());
 const finishing=collector.finish();workers[0].reply(undefined,{status:'error',rgbaMatchesRaster:false,rasterRgbaSha256:'a'.repeat(64),image:null,imageBytes:null,pngSha256:null,error:'Input differs from painted PNG.'});
 const evidence=await finishing;assert.equal(evidence.images[0].status,'error');assert.equal(evidence.images[0].image,null);
 assert.equal(evidence.images[0].rasterRgbaSha256,'a'.repeat(64));assert.notEqual(evidence.images[0].rgbaSha256,evidence.images[0].rasterRgbaSha256);assert.equal(evidence.complete,false);
});

test('per-image deadline terminates the hung worker and late results cannot replace the next input',async()=>{
 let starts=0;const {collector,workers}=fixture({encodeTimeoutMs:15,finishTimeoutMs:200,disposeTimeoutMs:10},()=>new FakeWorker(starts++>0));
 const input=collector.begin(meta())!;input.captureCard(card().canvas);input.captureLabel(label(),recipe());input.finish(outcome({nameMatchCount:1}));
 const finishing=collector.finish(),old=workers[0],late=old.onmessage!;
 await finishing;assert.equal(workers.length,2);assert.equal(old.terminations,1);
 late.call(old as unknown as Worker,{data:old.result()} as MessageEvent);
 const evidence=collector.snapshot();
 assert.equal(evidence.images[0].status,'timeout');assert.equal(evidence.images[0].image,null);assert.equal(evidence.images[1].status,'encoded');
 assert.equal(evidence.stats.lateResponsesIgnored,1);assert.equal(evidence.stats.rawReservedBytes,0);assert.equal(evidence.workerCleanup.forced,true);assert.equal(evidence.complete,false);
});

test('overall deadline and unacknowledged disposal terminate and preserve partial metadata',async()=>{
 const {collector,workers}=fixture({encodeTimeoutMs:100,finishTimeoutMs:10,disposeTimeoutMs:10},()=>new FakeWorker(false,false));
 const input=collector.begin(meta())!;input.captureCard(card().canvas);input.finish(outcome());
 const evidence=await collector.finish();assert.equal(evidence.images[0].status,'timeout');assert.equal(evidence.rows[0].outcome?.status,'unknown');
 assert.equal(evidence.stats.pending,0);assert.equal(evidence.stats.rawReservedBytes,0);assert.equal(workers[0].terminations,1);assert.equal(evidence.complete,false);
 const noAck=fixture({disposeTimeoutMs:10},()=>new FakeWorker(true,false)),i=noAck.collector.begin(meta())!;i.captureCard(card().canvas);i.finish(outcome());
 const partial=await noAck.collector.finish();assert.equal(partial.workerCleanup.acknowledged,false);assert.equal(partial.workerCleanup.forced,true);assert.equal(partial.complete,false);
});

test('finish and dispose concurrently share cleanup and late handles cannot mutate rows/images',async()=>{
 const {collector,workers}=fixture({disposeTimeoutMs:20},()=>new FakeWorker(false));const input=collector.begin(meta())!;input.captureCard(card().canvas);
 const finishing=collector.finish(),disposing=collector.dispose();await Promise.all([finishing,disposing]);
 const before=collector.snapshot();input.captureCard(card().canvas);input.captureLabel(label(),recipe());input.finish(outcome());assert.equal(collector.begin(meta(2)),undefined);
 const after=collector.snapshot();assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.images,before.images);assert.equal(after.stats.lateCallsIgnored,4);
 assert.equal(workers[0].terminations,1);assert.equal(after.stats.rawReservedBytes,0);assert.equal(after.stats.pending,0);assert.equal(after.complete,false);
 await collector.dispose();assert.equal(workers[0].terminations,1);
});

test('disposing a never-started or collecting observer joins safely without ever creating a worker',async()=>{
 const {collector,workers}=fixture(),input=collector.begin(meta())!;input.captureCard(card().canvas);
 await collector.dispose();assert.equal(workers.length,0);assert.equal(collector.snapshot().stats.rawReservedBytes,0);assert.equal(collector.snapshot().images[0].status,'disposed');
 assert.equal((await collector.finish()).complete,false);
});

test('canvas readback, invalid arrays and worker construction errors remain optional diagnostics',async()=>{
 const {collector}=fixture();const input=collector.begin(meta())!;
 assert.doesNotThrow(()=>input.captureCard({width:2,height:1,getContext:()=>{throw Error('tainted');}} as unknown as HTMLCanvasElement));
 assert.doesNotThrow(()=>input.captureLabel({width:128,height:36,data:new Uint8ClampedArray(3)},recipe()));input.finish(outcome({nameMatchCount:1}));
 const evidence=await collector.finish();assert.equal(evidence.images.every(v=>v.status==='error'),true);assert.equal(evidence.complete,false);
 const factory=fixture({},()=>{throw Error('Worker unavailable');}),i=factory.collector.begin(meta())!;i.captureCard(card().canvas);i.finish(outcome());
 const failed=await factory.collector.finish();assert.match(failed.images[0].error!,/unavailable/);assert.equal(failed.stats.pending,0);assert.equal(failed.stats.rawReservedBytes,0);
});

test('four immutable target pairs and bounded rows reject duplicate or over-broad configuration',async()=>{
 assert.throws(()=>createPairedCropCollector([target,target]),/targets/);assert.throws(()=>createPairedCropCollector([]),/targets/);
 assert.throws(()=>createPairedCropCollector(Array.from({length:5},(_,i)=>({processingFrame:i+1,slot:0}))),/targets/);
 const targets=[{...target}],worker=new FakeWorker(),collector=createPairedCropCollector(targets,{createWorker:()=>worker,maxRows:1});
 targets[0].processingFrame=2;const input=collector.begin(meta())!;input.captureCard(card().canvas);input.finish(outcome());
 assert.equal(collector.begin(meta(2)),undefined);const result=await collector.finish();assert.equal(result.targets[0].processingFrame,97);assert.equal(result.complete,false);assert.equal(result.stats.rowsOmitted,1);
 await tick();
});
