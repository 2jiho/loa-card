import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapturedHeaderReads} from '../src/features/card-scanner/captured-header-read';
import type {CapturedHeaderRegion} from '../src/features/card-scanner/captured-header-read';
import type {InventoryHeaderFact} from '../src/features/card-scanner/scroll-capture-diagnostic';

const source=(frame:number):CapturedHeaderRegion=>({source:{sessionId:'header-test',processingFrame:frame,acquisitionFrameId:frame+100,
  canonicalSourceFrameId:frame+200,observationFrameId:`header-test:frame:${frame+300}`,inputId:frame+400,captureTime:frame/10,phase:'input',sourceWidth:1920,sourceHeight:1080},
  headerBox:{x:100,y:150,width:300,height:40}});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('an asynchronous header retains the exact captured source and crop despite later frame mutation',async()=>{
  const facts:InventoryHeaderFact[]=[],reads=createCapturedHeaderReads(fact=>{facts.push(fact);return true;}),origin=source(1),pending=deferred<{owned:number;capacity:number}>();
  const read=reads.read(origin,'initial',()=>pending.promise);
  (origin.source as {acquisitionFrameId:number}).acquisitionFrameId=999; (origin.headerBox as {x:number}).x=999;
  pending.resolve({owned:384,capacity:450});assert.deepEqual(await read,{owned:384,capacity:450});
  assert.equal(facts[0].source.acquisitionFrameId,101);assert.equal(facts[0].source.canonicalSourceFrameId,201);
  assert.equal(facts[0].source.observationFrameId,'header-test:frame:301');assert.equal(facts[0].source.inputId,401);assert.equal(facts[0].headerBox.x,100);
  assert.ok(Object.isFrozen(facts[0].source));assert.equal(reads.latestFactId,1);
});

test('header invocation IDs remain distinct from completion and physical capture order',async()=>{
  const facts:InventoryHeaderFact[]=[],reads=createCapturedHeaderReads(fact=>{facts.push(fact);return true;}),first=deferred<{owned:number;capacity:number}>(),second=deferred<{owned:number;capacity:number}>();
  const a=reads.read(source(5),'initial',()=>first.promise),b=reads.read(source(2),'ended-capture',()=>second.promise);
  second.resolve({owned:393,capacity:450});await b;first.resolve({owned:384,capacity:450});await a;
  assert.deepEqual(facts.map(fact=>[fact.factId,fact.source.processingFrame]),[[2,2],[1,5]]);assert.equal(reads.latestFactId,2);
});

test('absent or failed header reads neither invent capacity nor establish a new fact reference',async()=>{
  const facts:InventoryHeaderFact[]=[],reads=createCapturedHeaderReads(fact=>{facts.push(fact);return true;});
  assert.equal(await reads.read(source(1),'initial',async()=>null),null);
  const failure=Error('OCR failed');await assert.rejects(reads.read(source(2),'auto-completion',async()=>{throw failure;}),error=>error===failure);
  assert.equal(facts.length,0);assert.equal(reads.latestFactId,null);
});

test('optional malformed metadata, throwing sinks, and disabled diagnostics preserve valid OCR results',async()=>{
  const failures:unknown[]=[],value={owned:384,capacity:450};
  const reads=createCapturedHeaderReads(()=>{throw Error('sink failed');},error=>{failures.push(error);});
  assert.equal(await reads.read(source(1),'initial',async()=>value),value);
  const invalid=source(2);(invalid.source as {sourceWidth:number}).sourceWidth=0;
  assert.equal(await reads.read(invalid,'initial',async()=>value),value);assert.equal(failures.length,2);assert.equal(reads.latestFactId,null);
  const disabled=createCapturedHeaderReads(()=>false,()=>{throw Error('diagnostic callback failed');});
  assert.equal(await disabled.read(undefined,'initial',async()=>value),value);assert.equal(await disabled.read(source(3),'initial',async()=>value),value);
  assert.equal(await disabled.read(invalid,'initial',async()=>value),value);
  assert.equal(disabled.latestFactId,null);
});
