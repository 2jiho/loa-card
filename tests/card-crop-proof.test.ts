import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CARD_CROP_PROOF_LIMITS,parseCardCropProofData,cardCropPngBytes,assertCardCropPngHeader,
  verifyCardCropPng,verifyCardCropRgba,decodeCardCropBitmap} from '../dev/card-crop-proof-core';

const sha='a'.repeat(64);
function header(){
  const bytes=new Uint8Array(33),view=new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);
  view.setUint32(8,13);view.setUint32(16,140);view.setUint32(20,210);bytes[24]=8;bytes[25]=6;
  return bytes;
}
const image=(bytes:Uint8Array)=>`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
function manifest(){return {version:1,sourceDigest:sha,
  runReferences:[{id:'run.control',sha256:sha,sourceDigest:sha,runFile:'work/private-run.json'}],
  inputs:[{key:'source.card.1',runReferenceId:'run.control',
    source:{sessionId:'opaque source session',observationId:'opaque observation',sourceFrameId:41 as number|null,
      acquisitionFrameId:27,processingFrame:19,captureOrder:6,captureTime:2.75,phase:'input',slot:32},
    capture:{stable:null as boolean|null,borderAlignment:null as number|null,intact:null as boolean|null,complete:null as boolean|null,provenance:'unknown'},
    width:140,height:210,image:image(header()),pngSha256:sha,rgbaSha256:sha,candidate:{name:'unverified annotation'}}]};}
type Manifest=ReturnType<typeof manifest>;
function rejects(mutate:(value:Manifest)=>void){const invalid=manifest();mutate(invalid);assert.throws(()=>parseCardCropProofData(JSON.stringify(invalid)));}

test('full card manifest preserves opaque source/acquisition/order/time/phase/slot and input order',()=>{
  const value=manifest();
  value.runReferences.push({...value.runReferences[0],id:'run.native',sha256:'b'.repeat(64)});
  value.inputs.push({...value.inputs[0],key:'source.card.2',runReferenceId:'run.native',
    source:{...value.inputs[0].source,sourceFrameId:null,phase:'recovery'}});
  assert.deepEqual(parseCardCropProofData(JSON.stringify(value)),value);
  const parsed=parseCardCropProofData(JSON.stringify(value));
  assert.deepEqual(parsed.inputs.map(input=>[input.key,input.runReferenceId,input.source.acquisitionFrameId,input.source.sourceFrameId]),
    [['source.card.1','run.control',27,41],['source.card.2','run.native',27,null]]);
});

test('source references must bind exactly; ambiguous aliases and unbounded source tuples fail',()=>{
  for(const mutate of [
    (x:Manifest)=>{x.inputs[0].runReferenceId='another run';},
    (x:Manifest)=>{x.runReferences.push({...x.runReferences[0]});},
    (x:Manifest)=>{x.runReferences[0].sourceDigest='b'.repeat(64);},
    (x:Manifest)=>{x.runReferences[0].sha256='unhashed';},
    (x:Manifest)=>{x.inputs.push({...x.inputs[0]});},
    (x:Manifest)=>{x.inputs.push({...x.inputs[0],key:'alias-of-same-observation'});},
    (x:Manifest)=>{x.runReferences.push({...x.runReferences[0],id:'same-run-alias'});
      x.inputs.push({...x.inputs[0],key:'alias-observation',runReferenceId:'same-run-alias'});},
    (x:Manifest)=>{x.inputs[0].source.slot=40;},
    (x:Manifest)=>{x.inputs[0].source.captureOrder=-1;},
    (x:Manifest)=>{x.inputs[0].source.processingFrame=0;},
    (x:Manifest)=>{x.inputs[0].source.acquisitionFrameId=1.5;},
    (x:Manifest)=>{x.inputs[0].source.captureTime=-.01;},
    (x:Manifest)=>{x.inputs[0].source.sessionId='x'.repeat(161);},
    (x:Manifest)=>{x.inputs[0].source.observationId='control\ncharacter';},
  ])rejects(mutate);
  assert.throws(()=>parseCardCropProofData(JSON.stringify({...manifest(),sourceDigest:null})));
  const foreign=manifest();Object.assign(foreign.inputs[0].source,{frameId:27});
  assert.throws(()=>parseCardCropProofData(JSON.stringify(foreign)));
});

test('strict manifest bounds reject remote images, decoded PNG overflow, dimension and digest mismatch',()=>{
  for(const mutate of [
    (x:Manifest)=>{x.inputs[0].width=139;},
    (x:Manifest)=>{x.inputs[0].height=211;},
    (x:Manifest)=>{x.inputs[0].image='https://example.invalid/private.png';},
    (x:Manifest)=>{x.inputs[0].image='data:image/png;base64,AA=A';},
    (x:Manifest)=>{x.inputs[0].pngSha256='A'.repeat(64);},
    (x:Manifest)=>{x.inputs[0].rgbaSha256='unknown';},
    (x:Manifest)=>{x.inputs[0].image=image(new Uint8Array(CARD_CROP_PROOF_LIMITS.pngBytes+1));},
    (x:Manifest)=>{x.inputs=Array.from({length:9},(_,index)=>({...x.inputs[0],key:String(index),source:{...x.inputs[0].source,observationId:String(index)}}));},
  ])rejects(mutate);
  assert.throws(()=>parseCardCropProofData(' '.repeat(CARD_CROP_PROOF_LIMITS.fileBytes+1)));
  assert.throws(()=>cardCropPngBytes('data:image/png;base64,AB==')); // Noncanonical pad bits.
  const maximum=new Uint8Array(CARD_CROP_PROOF_LIMITS.pngBytes);maximum.set(header());
  assert.equal(cardCropPngBytes(image(maximum)).length,CARD_CROP_PROOF_LIMITS.pngBytes);
});

test('candidate annotations cannot inject truth, thresholds, identities, configuration or catalog filters',()=>{
  const value=manifest();Object.assign(value.inputs[0].candidate,{id:'any diagnostic card ID'});
  const parsed=parseCardCropProofData(JSON.stringify(value));
  assert.deepEqual(parsed.inputs[0].candidate,{name:'unverified annotation',id:'any diagnostic card ID'});
  assert.deepEqual(parsed.inputs[0].capture,{stable:null,borderAlignment:null,intact:null,complete:null,provenance:'unknown'});
  for(const injection of [{expected:'a'},{accepted:true},{confidence:1},{catalogIds:['a']},{allowGrayNameFallback:true},{awakening:5},{extraCopies:15}]){
    const invalid=manifest();Object.assign(invalid.inputs[0].candidate,injection);
    assert.throws(()=>parseCardCropProofData(JSON.stringify(invalid)));
  }
  for(const injection of [{expected:{}},{recognizerOptions:{}},{id:'forced identity'},{captureStable:true}]){
    const invalid=manifest();Object.assign(invalid.inputs[0],injection);
    assert.throws(()=>parseCardCropProofData(JSON.stringify(invalid)));
  }
});

test('unknown capture evidence stays null; numeric or fabricated stability metadata is rejected',()=>{
  rejects(x=>{x.inputs[0].capture.stable=true;});
  rejects(x=>{x.inputs[0].capture.borderAlignment=.99;});
  rejects(x=>{x.inputs[0].capture.provenance='inferred-stable';});
  rejects(x=>{x.inputs[0].capture.provenance='recorded';x.inputs[0].capture.borderAlignment=1.01;});
  const recorded=manifest();recorded.inputs[0].capture={stable:false,borderAlignment:.81,intact:true,complete:true,provenance:'recorded'};
  assert.deepEqual(parseCardCropProofData(JSON.stringify(recorded)).inputs[0].capture,recorded.inputs[0].capture);
  for(const provenance of [['unknown'],['recorded'],['recomputed-acquisition'],null,1,{},true]){
    const invalid=manifest();Object.assign(invalid.inputs[0].capture,{provenance,stable:true,borderAlignment:1});
    assert.throws(()=>parseCardCropProofData(JSON.stringify(invalid)));
  }
});

test('PNG IHDR prevents oversized native decode and handles offset byte views',()=>{
  const backing=new Uint8Array(43);backing.set(header(),5);const bytes=backing.subarray(5,38);
  assert.doesNotThrow(()=>assertCardCropPngHeader(bytes));
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  view.setUint32(16,0x7fffffff);assert.throws(()=>assertCardCropPngHeader(bytes));
  view.setUint32(16,140);view.setUint32(20,209);assert.throws(()=>assertCardCropPngHeader(bytes));
  assert.throws(()=>assertCardCropPngHeader(header().subarray(0,32)));
  const invalid=header();invalid[12]=0;assert.throws(()=>assertCardCropPngHeader(invalid));
});

test('PNG byte SHA and independently decoded RGBA SHA are both checked against actual bytes',async()=>{
  const bytes=header(),pngSha256=createHash('sha256').update(bytes).digest('hex');
  const verified=await verifyCardCropPng({image:image(bytes),pngSha256});
  assert.equal(verified.sha256,pngSha256);assert.deepEqual(verified.bytes,bytes);
  bytes[32]^=1;
  await assert.rejects(verifyCardCropPng({image:image(bytes),pngSha256}),/PNG SHA-256 mismatch/);
  const rgba=new Uint8ClampedArray(140*210*4),rgbaSha256=createHash('sha256').update(rgba).digest('hex');
  assert.equal(await verifyCardCropRgba(rgba,rgbaSha256),rgbaSha256);
  rgba[4]=1;await assert.rejects(verifyCardCropRgba(rgba,rgbaSha256),/RGBA SHA-256 mismatch/);
  await assert.rejects(verifyCardCropRgba(new Uint8ClampedArray(140*210*4-1),rgbaSha256),/Invalid decoded/);
});

test('abort/deadline bounds native PNG decode waits and disposes late bitmap output once',async()=>{
  for(const cancel of [true,false]){
    let complete!:(bitmap:ImageBitmap)=>void,closes=0;
    const controller=new AbortController(),operation=decodeCardCropBitmap(new Blob(),controller.signal,
      {deadlineMs:5,decode:()=>new Promise(resolve=>{complete=resolve;})});
    if(cancel)controller.abort(Error('stop proof'));
    await assert.rejects(operation,cancel?/stop proof/:/deadline/);
    complete({close(){closes++;}} as ImageBitmap);await Promise.resolve();assert.equal(closes,1);
  }
  const controller=new AbortController();controller.abort();let starts=0;
  await assert.rejects(decodeCardCropBitmap(new Blob(),controller.signal,{decode:async()=>{starts++;return {} as ImageBitmap;}}));
  assert.equal(starts,0);
  await assert.rejects(decodeCardCropBitmap(new Blob(),new AbortController().signal,{deadlineMs:5001}),/deadline/);
});

test('successful native decode transfers ownership; synchronous decoder failures reject',async()=>{
  let closes=0;const bitmap={close(){closes++;}} as ImageBitmap,signal=new AbortController().signal;
  assert.equal(await decodeCardCropBitmap(new Blob(),signal,{decode:async()=>bitmap}),bitmap);
  assert.equal(closes,0);bitmap.close();assert.equal(closes,1);
  await assert.rejects(decodeCardCropBitmap(new Blob(),signal,{decode:()=>{throw Error('decoder failed');}}),/decoder failed/);
});
