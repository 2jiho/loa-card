import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import {comparePreparedCropCanvases,createPreparedCanvasHasher,parsePreparedCropProof,preparedCropDiagnostic} from '../src/features/card-scanner/acquisition/prepared-crop-proof-client';
import {createPreparedCropProver,type PreparedCropProof} from '../src/features/card-scanner/acquisition/prepared-crop-proof';

const frame={version:1 as const,kind:'measured' as const,sourceFrameId:7,captureTime:1,acquisitionFrameId:9,width:2,height:1,hash:'a'.repeat(64)};
const rgba=Uint8ClampedArray.from([1,2,3,255]);
function cell(slot=0,data=rgba){return {slot,content:{x:slot,y:0,width:1,height:1},complete:true,
 image:{width:1,height:1,getContext:()=>({getImageData:()=>({data})})} as unknown as HTMLCanvasElement};}
async function fixture(){const sha256=await pixelHash(new Uint8Array(rgba)),cells=[cell()];
 return {cells,proof:{version:1 as const,scope:'prepared-worker-crop' as const,frame,frameCheck:'match' as const,frameBytesHashed:8,
  timedOut:false,hashBusy:false,total:1,checked:1,unsupported:0,mismatch:0,overBudget:0,hashFailed:0,bytesHashed:4,
  crops:[{slot:0,content:{x:0,y:0,width:1,height:1},sha256}]}};}
const signal=()=>new AbortController().signal;

test('binds a worker assertion to exact measured frame and canvas slot without claiming OCR',async()=>{
 const {cells,proof}=await fixture(),parsed=parsePreparedCropProof(proof,frame,cells);
 assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.crops[0]));
 const result=await preparedCropDiagnostic(proof,frame,cells,signal());assert.equal(result.status,'accepted');
 if(result.status!=='accepted')return;
 assert.equal(result.canvas.scope,'delivery-canvas-snapshot-only');assert.equal(result.canvas.matched,1);
 assert.equal(result.canvas.bytesRead,4);assert.equal(result.canvas.budgetMs,250);assert.equal(result.canvas.timedOut,false);
 assert.deepEqual(result.canvas.slots,[{slot:0,status:'matched'}]);
});

test('real Worker proof function and client Canvas snapshot agree on the same owned pixels',async()=>{
 const source=Uint8ClampedArray.from([1,2,3,255,4,5,6,255]);
 const actualFrame={...frame,hash:await pixelHash(new Uint8Array(source))};
 const cells=[cell()],proof=await createPreparedCropProver().measure(actualFrame,source,
  [{slot:0,content:cells[0].content,complete:true,pixels:{width:1,height:1,data:rgba.slice()}}]);
 assert.equal(proof.frameCheck,'match');assert.equal(proof.checked,1);
 const output=await preparedCropDiagnostic(proof,actualFrame,cells,signal());
 assert.equal(output.status,'accepted');if(output.status==='accepted')assert.equal(output.canvas.matched,1);
});

test('rejects mismatched frames, slots, geometry, counters, frame checks and untrusted accessors',async()=>{
 const {cells,proof}=await fixture();
 const cases:unknown[]=[
  {...proof,frame:{...frame,sourceFrameId:8}}, {...proof,frame:{...frame,hash:'b'.repeat(64)}},
  {...proof,checked:0}, {...proof,total:2}, {...proof,bytesHashed:3}, {...proof,frameCheck:'failed'},
  {...proof,frameBytesHashed:0},{...proof,hashBusy:'yes'}, {...proof,timedOut:true}, {...proof,hashBusy:true},
  {...proof,frameCheck:'failed',frameBytesHashed:0,timedOut:true,hashBusy:true,checked:0,hashFailed:1,crops:[]},
  {...proof,crops:[{...proof.crops[0],slot:1}]},
  {...proof,crops:[{...proof.crops[0],content:{...proof.crops[0].content,x:1}}]},
  {...proof,crops:[{...proof.crops[0],sha256:'bad'}]},
 ];
 for(const value of cases){const result=await preparedCropDiagnostic(value,frame,cells,signal());assert.equal(result.status,'invalid');}
 const accessor={...proof,get checked(){throw Error('getter executed');}};
 const invalid=await preparedCropDiagnostic(accessor,frame,cells,signal());assert.equal(invalid.status,'invalid');
 if(invalid.status==='invalid')assert.doesNotMatch(invalid.reason,/getter executed/);
 const accessorArray=[proof.crops[0]];Object.defineProperty(accessorArray,0,{get(){throw Error('array getter executed');}});
 assert.equal((await preparedCropDiagnostic({...proof,crops:accessorArray},frame,cells,signal())).status,'invalid');
});

test('compares actual delivery snapshots; failures and mismatch do not reject acquisition diagnostics',async()=>{
 const {proof}=await fixture();
 const different=cell(0,Uint8ClampedArray.from([9,2,3,255]));
 let result=await preparedCropDiagnostic(proof,frame,[different],signal());
 assert.equal(result.status,'accepted');if(result.status==='accepted')assert.equal(result.canvas.mismatch,1);
 const unavailable={...cell(),image:{width:1,height:1,getContext:()=>null} as unknown as HTMLCanvasElement};
 result=await preparedCropDiagnostic(proof,frame,[unavailable],signal());
 assert.equal(result.status,'accepted');if(result.status==='accepted')assert.equal(result.canvas.unavailable,1);
 assert.equal((await preparedCropDiagnostic(undefined,frame,[cell()],signal())).status,'invalid');
});

test('accepts consistent timed-out and busy worker diagnostics as inconclusive',async()=>{
 const {proof,cells}=await fixture();
 for(const flags of [{timedOut:true,hashBusy:false},{timedOut:false,hashBusy:true}]){
  const value={...proof,...flags,frameCheck:'failed',frameBytesHashed:0,checked:0,hashFailed:1,bytesHashed:0,crops:[]};
  const diagnostic=await preparedCropDiagnostic(value,frame,cells,signal());
  assert.equal(diagnostic.status,'accepted');
  if(diagnostic.status==='accepted'){assert.equal(diagnostic.claim.checked,0);assert.equal(diagnostic.canvas.matched,0);}
 }
});

test('a hung digest times out and blocks further digest work rather than accumulating buffers',async()=>{
 const {proof,cells}=await fixture();let calls=0,release!:(value:string)=>void;
 const gate=createPreparedCanvasHasher(()=>{calls++;return new Promise(resolve=>{release=resolve;});});
 const first=await comparePreparedCropCanvases(proof as PreparedCropProof,cells,signal(),gate,10);
 assert.equal(first.timedOut,true);assert.equal(first.unavailable,1);assert.equal(first.bytesRead,4);
 const next=await comparePreparedCropCanvases(proof as PreparedCropProof,cells,signal(),gate,10);
 assert.equal(next.unavailable,1);assert.equal(calls,1,'a second pending digest is not started');
 release(proof.crops[0].sha256);await new Promise(resolve=>setTimeout(resolve,0));
});

test('user cancellation propagates from an in-flight comparison',async()=>{
 const {proof,cells}=await fixture(),controller=new AbortController();
 const pending=comparePreparedCropCanvases(proof as PreparedCropProof,cells,controller.signal,()=>new Promise(()=>{}));
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
});
