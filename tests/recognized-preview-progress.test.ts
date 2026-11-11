import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActiveReadingCounter} from '../src/features/card-scanner/session/active-reading-counter';
import {createCandidatePreviewEncoder} from '../src/features/card-scanner/ui/candidate-preview';
import {createCoalescedPublisher} from '../src/features/card-scanner/capture/coalesced-publisher';
import {InventoryEvidence,hashInventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {canStopSharing} from '../src/features/card-scanner/session/auto-completion';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

test('reading display pauses without releasing the real scheduler lane or double counting',()=>{
 const counter=new ActiveReadingCounter(),a=counter.begin(),b=counter.begin();
 assert.equal(counter.active,2);a.pause();a.pause();assert.equal(counter.active,1);
 a.resume();a.resume();assert.equal(counter.active,2);b.finish();b.finish();assert.equal(counter.active,1);
 a.pause();assert.equal(counter.active,0);a.finish();a.resume();assert.equal(counter.active,0);
});

test('a delayed optional thumbnail does not hide committed fields and still blocks completion',async()=>{
 // This exercises the actual reducer, preview encoder, grid and coalescer with
 // the scanner's publication order. It is not a browser runScanner benchmark.
 const callbacks:BlobCallback[]=[];
 const canvas={width:140,height:210,toBlob(cb:BlobCallback){callbacks.push(cb);}} as unknown as HTMLCanvasElement;
 const reader={result:null as string|null,onload:null as FileReader['onload'],onerror:null as FileReader['onerror'],
  onabort:null as FileReader['onabort'],readAsDataURL(_blob:Blob){},abort(){}};
 const preview=createCandidatePreviewEncoder({createWorker:()=>undefined,createReader:()=>reader,timeoutMs:1000});
 const previewTask=preview.encodeOwned(canvas);
 const source:InventorySource={sessionId:'s',frameId:1,observationId:'1',captureOrder:10,captureTime:1,phase:'input',slot:0,frame:'frame'};
 const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:1,observations:1,
  captureOrder:10,capturePosition:{frame:'frame',slot:0,stable:true,sort:null}};
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);
 const attempt=grid.start(1),counter=new ActiveReadingCounter(),display=counter.begin();
 let readerJobs=1;
 const published:{image:string;read:number;active:number}[]=[];
 const publisher=createCoalescedPublisher(()=>published.push({image:inventory.cards.get('a')?.image??'',
  read:grid.snapshot().recent?.read??0,active:counter.active}),0);
 inventory.acceptIdentity(source,'a');inventory.confirmName(source,'a','카드');
 const change=inventory.recordObservation(source,card,.9),before=await hashInventoryEvidence(inventory.snapshot());
 grid.finish(1,'read',attempt);display.pause();publisher.request();
 assert.deepEqual(published,[{image:'',read:1,active:0}]);
 assert.equal(readerJobs,1);assert.equal(preview.waiting,1);
 const completion={expected:1,finalExpected:1,headerAvailable:true,inputSettled:readerJobs===0&&preview.waiting===0,
  fieldChangesSettled:true,unresolved:0,dropped:0,cards:[inventory.cards.get('a')!],
  latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder,confirmedNames:inventory.confirmedNameOrder};
 assert.equal(canStopSharing(completion),false,'the existing scheduler/preview gate is unchanged');
 callbacks[0](new Blob(['p'],{type:'image/jpeg'}));reader.result='data:image/jpeg;base64,cA==';
 reader.onload?.call(reader as unknown as FileReader,{} as ProgressEvent<FileReader>);
 const image=await previewTask;
 assert.equal(inventory.settlePresentationImage('a',change.presentationObservation,image),true);
 publisher.request();readerJobs--;display.finish();
 assert.equal(published[1].image,image);assert.equal(await hashInventoryEvidence(inventory.snapshot()),before);
 assert.equal(canStopSharing({...completion,inputSettled:readerJobs===0&&preview.waiting===0,
  cards:[inventory.cards.get('a')!]}),true);
 publisher.dispose();await preview.dispose();
});

test('a full preview encoder remains bounded and does not add an unowned canvas queue',async()=>{
 const callbacks:BlobCallback[]=[],canvases=Array.from({length:5},()=>({width:140,height:210,
  toBlob(cb:BlobCallback){callbacks.push(cb);}} as unknown as HTMLCanvasElement));
 const preview=createCandidatePreviewEncoder({createWorker:()=>undefined,maxPending:4,timeoutMs:1000});
 const tasks=canvases.map(canvas=>preview.encodeOwned(canvas));
 assert.equal(await tasks[4],'');assert.equal(canvases[4].width,0);
 assert.equal(preview.waiting,4);assert.equal(callbacks.length,4);
 for(const callback of callbacks)callback(null);
 assert.deepEqual(await Promise.all(tasks),['','','','','']);
 await preview.dispose();
});

test('aborting after field publication cannot settle a late image or leak the display count',async()=>{
 const controller=new AbortController(),callbacks:BlobCallback[]=[];
 const canvas={width:140,height:210,toBlob(cb:BlobCallback){callbacks.push(cb);}} as unknown as HTMLCanvasElement;
 const encoder=createCandidatePreviewEncoder({signal:controller.signal,createWorker:()=>undefined,timeoutMs:1000});
 const task=encoder.encodeOwned(canvas);
 const source:InventorySource={sessionId:'s',frameId:1,observationId:'1',captureOrder:10,captureTime:1,phase:'input',slot:0,frame:'frame'};
 const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:1,observations:1,
  captureOrder:10,capturePosition:{frame:'frame',slot:0,stable:true,sort:null}};
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 inventory.acceptIdentity(source,'a');inventory.confirmName(source,'a','카드');
 const change=inventory.recordObservation(source,card,.9),counter=new ActiveReadingCounter(),display=counter.begin();
 display.pause();
 const wait=(async()=>{try{const image=await task;controller.signal.throwIfAborted();
   inventory.settlePresentationImage('a',change.presentationObservation,image);
  }finally{display.finish();}})();
 controller.abort();await assert.rejects(wait);
 callbacks[0](new Blob(['late'],{type:'image/jpeg'}));
 assert.equal(inventory.cards.get('a')?.image,'');assert.equal(counter.active,0);
 assert.equal(canvas.width,0);await encoder.dispose();
});
