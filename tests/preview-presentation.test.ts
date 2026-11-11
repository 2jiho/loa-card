import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewPresentation,finishCandidatePreview,previewFlushTimer} from '../src/features/card-scanner/ui/preview-presentation';
import {InventoryEvidence,hashInventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const defer=()=>{let resolve!:(image:string)=>void;const promise=new Promise<string>(done=>{resolve=done;});return {promise,resolve};};
const source=(order:number):InventorySource=>({sessionId:'scan',frameId:order,observationId:String(order),captureOrder:order,captureTime:order,
 phase:'input',slot:0,frame:`frame-${order}`});
const card=(order:number):ScannedCard=>({id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,
 image:'',time:order,observations:1,captureOrder:order,capturePosition:{frame:`frame-${order}`,slot:0,stable:true,sort:null}});

test('flush timing records only a valid monotonic clock, never a fabricated zero',()=>{
 let now=100;const finish=previewFlushTimer(()=>now);
 now=145.5;assert.equal(finish(),45.5);
 now=99;assert.equal(finish(),null);
 now=NaN;assert.equal(finish(),null);
 const missing=previewFlushTimer(()=>{throw Error('clock unavailable');});assert.equal(missing(),null);
});

test('reader can finish before a bounded preview, but final projection waits for its source-bound attachment',async()=>{
 const controller=new AbortController(),lane=createPreviewPresentation(controller.signal),job=defer();
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),s=source(1);
 inventory.acceptIdentity(s,'a');inventory.confirmName(s,'a','카드');
 const change=inventory.recordObservation(s,card(1),.9),before=await hashInventoryEvidence(inventory.snapshot());
 let readerFinished=false,flushFinished=false;
 assert.equal(lane.track(job.promise,image=>inventory.settlePresentationImage('a',change.presentationObservation,image)),true);
 readerFinished=true;
 const flush=lane.flush().then(()=>{flushFinished=true;});await Promise.resolve();
 assert.equal(readerFinished,true);assert.equal(flushFinished,false);assert.equal(lane.waiting,1);
 job.resolve('data:image/jpeg;base64,cA==');await flush;
 assert.equal(inventory.cards.get('a')?.image,'data:image/jpeg;base64,cA==');
 assert.equal(await hashInventoryEvidence(inventory.snapshot()),before,'presentation is not recognition evidence');
 assert.equal(lane.waiting,0);lane.close();
});

test('late old preview is not attached to a newer selected observation',async()=>{
 const controller=new AbortController(),lane=createPreviewPresentation(controller.signal),old=defer(),newer=defer();
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 const a=source(1),b=source(2);inventory.acceptIdentity(a,'a');inventory.confirmName(a,'a','카드');
 const first=inventory.recordObservation(a,card(1),.9);
 assert.equal(lane.track(old.promise,image=>inventory.settlePresentationImage('a',first.presentationObservation,image)),true);
 inventory.acceptIdentity(b,'a');inventory.confirmName(b,'a','카드');
 const latest=inventory.recordObservation(b,card(2),.99);
 assert.equal(lane.track(newer.promise,image=>inventory.settlePresentationImage('a',latest.presentationObservation,image)),true);
 newer.resolve('data:image/jpeg;base64,bmV3');await Promise.resolve();
 old.resolve('data:image/jpeg;base64,b2xk');await lane.flush();
 assert.equal(inventory.cards.get('a')?.image,'data:image/jpeg;base64,bmV3');lane.close();
});

test('abort and close prevent late attachments and saturation leaves task with the reader',async()=>{
 const controller=new AbortController(),lane=createPreviewPresentation(controller.signal,1),a=defer(),b=defer();let attached=0;
 assert.equal(lane.track(a.promise,()=>attached++),true);
 assert.equal(lane.track(b.promise,()=>attached++),false);
 controller.abort();a.resolve('data:image/jpeg;base64,YQ==');await lane.flush();
 assert.equal(attached,0);lane.close();b.resolve('data:image/jpeg;base64,Yg==');
 assert.equal(await b.promise,'data:image/jpeg;base64,Yg==','caller still owns saturated work');
});

test('unknown retry is exposed only after preview ownership settles',async()=>{
 const controller=new AbortController(),encoding=defer(),canvas={width:140,height:210} as HTMLCanvasElement;
 const candidate:{preview:string;previewCanvas?:HTMLCanvasElement;previewTask?:Promise<string>}={preview:'',previewCanvas:canvas};
 const encoder={encodeOwnedWhenAvailable(owned:HTMLCanvasElement){
  assert.equal(owned,canvas);return encoding.promise.then(image=>{owned.width=0;owned.height=0;return image;});
 }};
 let retry:typeof candidate|undefined,reported=false;
 const enqueue=(async()=>{await finishCandidatePreview(candidate,encoder,controller.signal);
  retry={...candidate};reported=true;})();
 await Promise.resolve();
 assert.equal(retry,undefined);assert.equal(reported,false,'another reader cannot consume a not-yet-retained canvas');
 encoding.resolve('data:image/jpeg;base64,cA==');await enqueue;
 assert.equal(retry?.preview,'data:image/jpeg;base64,cA==');assert.equal(retry?.previewCanvas,undefined);
 assert.equal(await retry?.previewTask,'data:image/jpeg;base64,cA==');assert.equal(canvas.width,0);
});

test('non-abort scan failure closes the lane and suppresses a late attachment',async()=>{
 const controller=new AbortController(),lane=createPreviewPresentation(controller.signal),job=defer();let attached=false,activity=false;
 assert.equal(lane.track(job.promise,()=>{attached=true;}),true);
 void job.promise.then(()=>{if(lane.active)activity=true;});
 lane.close();job.resolve('data:image/jpeg;base64,cA==');await lane.flush();
 assert.equal(attached,false);assert.equal(activity,false);assert.equal(controller.signal.aborted,false);
});
