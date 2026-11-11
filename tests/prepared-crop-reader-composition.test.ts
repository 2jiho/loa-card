import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreparedCropProver} from '../src/features/card-scanner/acquisition/prepared-crop-proof';
import {preparedCropDiagnostic} from '../src/features/card-scanner/acquisition/prepared-crop-proof-client';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import {beginRecognitionInspection,type RecognitionInputMeta,type ReaderCropClaim} from '../src/features/card-scanner/recognition/recognition-input-observer';
import {createReaderCropBindingObserver,type ReaderCropComparison} from '../dev/reader-crop-binding';

// Composes the real diagnostic helpers with synthetic RGBA and a byte-backed
// Canvas double. This does not execute a browser Worker, the scanner, OCR, or
// establish card identity, independent observations, or completion evidence.
const signal=()=>new AbortController().signal;
const waitFor=async(test:()=>boolean)=>{
 const deadline=Date.now()+2000;
 while(!test()){if(Date.now()>deadline)throw Error('Diagnostic callback timeout');await new Promise(resolve=>setImmediate(resolve));}
};
async function fixture(){
 const source=Uint8ClampedArray.from([1,2,3,255,4,5,6,255]),pixels=source.slice(0,4);
 const frame={version:1 as const,kind:'measured' as const,sourceFrameId:9,acquisitionFrameId:7,captureTime:2,width:2,height:1,
  hash:await pixelHash(new Uint8Array(source))};
 const content={x:0,y:0,width:1,height:1};
 const workerCell={slot:0,content,complete:true,pixels:{width:1,height:1,data:pixels}};
 const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:pixels.slice()})})} as unknown as HTMLCanvasElement;
 const delivery=[{slot:0,content,complete:true,image:canvas}];
 const meta:RecognitionInputMeta={diagnosticReadId:1,processingFrame:1,slot:0,group:1,trace:1,pixelKey:'scheduling-only',
  source:{sessionId:'s',frameId:7,observationId:'o',captureOrder:4,captureTime:2,phase:'recovery',slot:0},
  stage:'full',stable:true,borderAlignment:1,sourceBox:content,sourceWidth:2,sourceHeight:1,cropWidth:1,cropHeight:1};
 return {source,pixels,frame,content,workerCell,canvas,delivery,meta};
}

async function produced(f:Awaited<ReturnType<typeof fixture>>){
 const proof=await createPreparedCropProver().measure(f.frame,f.source,[f.workerCell]);
 const result=await preparedCropDiagnostic(proof,f.frame,f.delivery,signal());
 assert.equal(result.status,'accepted');if(result.status!=='accepted')throw Error('Expected parsed worker assertion');
 return {proof,result};
}

test('worker comparison, delivery canvas and reader snapshot agree without asserting OCR',async()=>{
 const f=await fixture(),{proof,result}=await produced(f),out:ReaderCropComparison[]=[];
 assert.equal(proof.frameCheck,'match');assert.equal(proof.checked,1);
 assert.equal(result.canvas.scope,'delivery-canvas-snapshot-only');assert.equal(result.canvas.matched,1);
 const wrapper=createReaderCropBindingObserver('s',signal(),value=>out.push(value));
 const inspection=beginRecognitionInspection(wrapper.observer,f.meta);
 assert.ok(inspection);inspection.captureInput?.(f.canvas,{frame:result.claim.frame,crop:result.claim.crops[0]});
 await waitFor(()=>out.length===1);
 assert.equal(out[0].status,'match');assert.equal(out[0].actualSha256,proof.crops[0].sha256);
 assert.equal(out[0].modelExecutionVerified,false);assert.equal(out[0].independentObservation,false);assert.equal(out[0].completionEvidence,false);
 const stats=wrapper.close();assert.equal(stats.captures,1);assert.equal(stats.delivered,1);assert.equal(stats.accountingComplete,true);
});

test('separate delivery and reader snapshots report changes at their respective boundaries',async()=>{
 const f=await fixture(),proof=await createPreparedCropProver().measure(f.frame,f.source,[f.workerCell]);
 f.pixels[0]=99;
 const delivered=await preparedCropDiagnostic(proof,f.frame,f.delivery,signal());
 assert.equal(delivered.status,'accepted');if(delivered.status!=='accepted')return;
 assert.equal(delivered.canvas.mismatch,1);
 const out:ReaderCropComparison[]=[],wrapper=createReaderCropBindingObserver('s',signal(),value=>out.push(value));
 const inspection=beginRecognitionInspection(wrapper.observer,f.meta)!;
 inspection.captureInput?.(f.canvas,{frame:delivered.claim.frame,crop:delivered.claim.crops[0]});
 await waitFor(()=>out.length===1);assert.equal(out[0].status,'mismatch');
 assert.equal(wrapper.close().accountingComplete,true,'completed accounting does not turn mismatch into agreement');
});

test('changed source and unmatched or absent claims never produce a reader match',async()=>{
 const f=await fixture();let calls=0;
 const prover=createPreparedCropProver({hash:async bytes=>{if(++calls===2)f.source[4]^=1;return pixelHash(bytes);}});
 const invalid=await prover.measure(f.frame,f.source,[f.workerCell]);
 assert.equal(invalid.frameCheck,'mismatch');assert.equal(invalid.checked,0);assert.equal(invalid.hashFailed,1);
 const diagnostic=await preparedCropDiagnostic(invalid,f.frame,f.delivery,signal());
 assert.equal(diagnostic.status,'accepted');if(diagnostic.status!=='accepted')return;
 assert.equal(diagnostic.claim.crops.length,0);assert.equal(diagnostic.canvas.checked,0);
 const out:ReaderCropComparison[]=[],wrapper=createReaderCropBindingObserver('s',signal(),value=>out.push(value));
 beginRecognitionInspection(wrapper.observer,f.meta)!.captureInput?.(f.canvas);
 await waitFor(()=>out.length===1);assert.equal(out[0].status,'unavailable');assert.equal(out[0].reason,'claim-missing');
 assert.equal(wrapper.close().accountingComplete,true);
 const fresh=await fixture(),good=await produced(fresh),claim:ReaderCropClaim={frame:good.result.claim.frame,crop:good.result.claim.crops[0]};
 const wrongSource={...fresh.meta,source:{...fresh.meta.source,frameId:8}};
 const foreign:ReaderCropComparison[]=[],other=createReaderCropBindingObserver('s',signal(),value=>foreign.push(value));
 beginRecognitionInspection(other.observer,wrongSource)!.captureInput?.(fresh.canvas,claim);
 await waitFor(()=>foreign.length===1);assert.equal(foreign[0].status,'unsupported');assert.equal(foreign[0].reason,'invalid-or-unmatched-claim');
 assert.equal(other.close().accountingComplete,true);
 const badSlot:ReaderCropClaim={...claim,crop:{...claim.crop,slot:1}};
 const otherSlot:ReaderCropComparison[]=[],slotObserver=createReaderCropBindingObserver('s',signal(),value=>otherSlot.push(value));
 beginRecognitionInspection(slotObserver.observer,fresh.meta)!.captureInput?.(fresh.canvas,badSlot);
 await waitFor(()=>otherSlot.length===1);assert.equal(otherSlot[0].status,'unsupported');
 assert.equal(otherSlot[0].reason,'invalid-or-unmatched-claim');assert.equal(slotObserver.close().accountingComplete,true);
});

test('closing while reader hash is pending records incomplete accounting without a late result',async()=>{
 const f=await fixture(),{result}=await produced(f),out:ReaderCropComparison[]=[];
 let release!:(value:string)=>void;const gate=new Promise<string>(resolve=>{release=resolve;});
 const wrapper=createReaderCropBindingObserver('s',signal(),value=>out.push(value),{hash:()=>gate});
 beginRecognitionInspection(wrapper.observer,f.meta)!.captureInput?.(f.canvas,{frame:result.claim.frame,crop:result.claim.crops[0]});
 assert.equal(wrapper.stats().pending,1);
 const closed=wrapper.close();assert.equal(closed.accountingComplete,false);assert.equal(closed.captures,1);assert.equal(closed.delivered,0);
 release(result.claim.crops[0].sha256);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(wrapper.stats().pending,0);assert.equal(wrapper.stats().accountingComplete,false);assert.deepEqual(out,[]);
});
