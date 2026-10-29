import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalFrameIndex,type CanonicalFrameCommit} from '../src/features/card-scanner/canonical-frame-index';
import {readCanonicalFrame} from '../src/features/card-scanner/canonical-frame-reader';
import {inspectExactPrefix} from '../src/features/card-scanner/exact-recording-prefix';
import {entryParts,packPixels,fastCompress,pixelHash,type ExactFrame} from '../src/features/card-scanner/exact-recording-codec';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,windowWorkingSet} from '../src/features/card-scanner/rgba-window-policy';
import type {BoundedReadSource} from '../src/features/card-scanner/generic-bounded-input';

const signal=()=>new AbortController().signal;
const tags={codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};
const commit=(id:number,overrides:Partial<CanonicalFrameCommit>={}):CanonicalFrameCommit=>({
  sourceFrameId:100+id,frameId:id,offset:(id-1)*100,endOffset:id*100,width:2560,height:1440,
  captureTime:10-id,arrivalOrder:id,key:id===1,pixelHash:'a'.repeat(64),role:'input',...tags,...overrides,
});

test('window geometry admits eight dependencies without redefining cumulative legacy work',()=>{
  const window=new CanonicalFrameIndex({codecPolicy:RGBA_WINDOW_POLICY});
  for(let id=1;id<=8;id++){assert.equal(window.keyRequired(2560,1440),id===1);window.append(commit(id));}
  const range=window.decodeRange(108);
  assert.equal(range.decodeBytes,8*2560*1440*4);
  assert.equal(range.workingSetBytes,31_965_197);assert.equal(range.policy,RGBA_WINDOW_POLICY);
  assert.equal(window.keyRequired(2560,1440),true);
  assert.throws(()=>window.append(commit(9)),/bounded keyframe/);assert.equal(window.stats().entries,8);
  window.append(commit(9,{key:true}));assert.equal(window.decodeRange(109).keyFrameId,9);
  const legacy=new CanonicalFrameIndex();
  const untag=(value:CanonicalFrameCommit)=>{const{codec,policy,...rest}=value;void codec;void policy;return rest;};
  legacy.append(untag(commit(1)));legacy.append(untag(commit(2)));
  assert.equal(legacy.keyRequired(2560,1440),true);
  assert.throws(()=>legacy.append(untag(commit(3))),/bounded keyframe/);
  assert.equal(legacy.decodeRange(102).decodeBytes,29_491_200);
  assert.equal(Object.hasOwn(legacy.decodeRange(102),'workingSetBytes'),false);
});

test('source and physical lookups stay distinct while roles and receipts preserve the new policy',()=>{
  const index=new CanonicalFrameIndex({codecPolicy:RGBA_WINDOW_POLICY});index.append(commit(1));index.append(commit(2));
  assert.equal(index.get(1),undefined);assert.equal(index.get(101)?.frameId,1);
  assert.equal(index.getByFrameId(1)?.sourceFrameId,101);
  assert.deepEqual(index.decodeRange(102).frameIds,[1,2]);
  index.addRole(101,'recovery');index.attachAnalysisReceipt(101,7);
  assert.equal(index.getByFrameId(1)?.policy,RGBA_WINDOW_POLICY);assert.equal(index.getByFrameId(1)?.analysisReceiptId,7);
  assert.deepEqual(index.getByFrameId(1)?.roles,['input','recovery']);
  assert.throws(()=>index.getByFrameId(0));
});

test('window keys reject unsupported geometry and mixed descriptor policies before mutation',()=>{
  const index=new CanonicalFrameIndex({codecPolicy:RGBA_WINDOW_POLICY});
  assert.equal(windowWorkingSet(3840,2160).admitted,false);
  assert.throws(()=>index.keyRequired(3840,2160),/working set/);
  for(const value of [commit(1,{width:3840,height:2160}),{...commit(1),codec:'lz4'},
    {...commit(1),policy:undefined},{...commit(1),storage:undefined}])assert.throws(()=>index.append(value as CanonicalFrameCommit));
  assert.equal(index.stats().entries,0);
  assert.throws(()=>new CanonicalFrameIndex({codecPolicy:RGBA_WINDOW_POLICY,maxDecodeBytes:48}));
  assert.throws(()=>new CanonicalFrameIndex({codecPolicy:'unknown' as typeof RGBA_WINDOW_POLICY}));
  assert.throws(()=>new CanonicalFrameIndex().append(commit(1)),/legacy/);
});

async function archive(count=10,invalidHash:boolean|number=false){
  const index=new CanonicalFrameIndex({codecPolicy:RGBA_WINDOW_POLICY}),parts:BlobPart[]=[],originals:Uint8Array<ArrayBuffer>[]=[],headers:ExactFrame[]=[];
  let bytes=0,previous:Uint8Array<ArrayBuffer>|undefined;
  for(let id=1;id<=count;id++){
    let state=(0x12345678^id)>>>0;
    const pixels=Uint8Array.from({length:128*128*4},()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state&255;});
    const hash=invalidHash===true||invalidHash===id?'0'.repeat(64):await pixelHash(pixels),key=index.keyRequired(128,128);
    const header:ExactFrame={kind:'frame',id,time:count-id,width:128,height:128,key,hash,canonical:true,xor:true,...tags,
      ...(id===count?{phase:'recovery' as const}:{phase:'input' as const})};
    const body=new Blob(entryParts(header,fastCompress(packPixels(pixels,key?undefined:previous,true))));
    const offset=bytes;parts.push(body);bytes+=body.size;
    index.append({sourceFrameId:100+id,frameId:id,offset,endOffset:bytes,width:128,height:128,captureTime:count-id,
      arrivalOrder:id,key,pixelHash:hash,role:'input',...tags});
    parts.push(new Blob(entryParts({kind:'event',seq:id,time:id,type:'gap',value:{id}})));bytes+=(parts.at(-1) as Blob).size;
    previous=pixels;originals.push(pixels);headers.push(header);
  }
  const blob=new Blob(parts);blob.arrayBuffer=()=>{throw Error('whole archive materialization');};
  return{index,blob,originals,headers};
}
function sourceFor(blob:Blob){
  const reads:{offset:number;length:number}[]=[],state={revision:'immutable-test-blob'};
  const source:BoundedReadSource={snapshot:()=>({byteLength:blob.size,revision:state.revision}),
    read:async(offset,length)=>{reads.push({offset,length});return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());}};
  return{source,reads,state};
}

test('window random access reads only its physical dependencies using at most32KiB header and payload ranges',async()=>{
  const {index,blob,originals}=await archive();
  for(const id of [108,103,110,101]){
    const range=index.decodeRange(id),frames=range.frameIds.map(frame=>index.getByFrameId(frame)!);
    const {source,reads}=sourceFor(blob);
    const result=await readCanonicalFrame({frames,source,read:source.read,codecPolicy:RGBA_WINDOW_POLICY});
    assert.equal(result.id,id-100);assert.deepEqual(new Uint8Array(result.pixels.buffer),originals[id-101]);
    assert.equal(result.hash,frames.at(-1)!.pixelHash);
    assert.ok(reads.length>frames.length*3,'incompressible test payloads require bounded chunks');
    assert.ok(Math.max(...reads.map(read=>read.length))<=32768);
    assert.ok(reads.every(read=>frames.some(frame=>read.offset>=frame.offset&&read.offset+read.length<=frame.endOffset)),
      'event gaps and unrelated physical frames must not be read');
    result.pixels.fill(0);const again=await readCanonicalFrame({frames,source,read:source.read,codecPolicy:RGBA_WINDOW_POLICY});
    assert.deepEqual(new Uint8Array(again.pixels.buffer),originals[id-101],'returned raster is independent of future reads');
  }
});

test('window ranges require one explicit source and matching descriptor policy before reading',async()=>{
  const {index,blob}=await archive(1),frames=[index.get(101)!],{source,reads}=sourceFor(blob);
  await assert.rejects(readCanonicalFrame({frames,read:source.read,codecPolicy:RGBA_WINDOW_POLICY}),/출처/);
  await assert.rejects(readCanonicalFrame({frames,source,read:async()=>new Uint8Array(),codecPolicy:RGBA_WINDOW_POLICY}),/출처/);
  await assert.rejects(readCanonicalFrame({frames,read:source.read}),/정책/);
  await assert.rejects(readCanonicalFrame({frames:[{...frames[0],policy:undefined}],source,read:source.read,codecPolicy:RGBA_WINDOW_POLICY}),/색인/);
  assert.equal(reads.length,0);
});

test('changed source, decoded hash failure and abort never publish partial trusted pixels',async()=>{
  const good=await archive(1),frames=[good.index.get(101)!],changing=sourceFor(good.blob);
  const read=async(offset:number,length:number)=>{const bytes=await changing.source.read(offset,length);changing.state.revision='changed';return bytes;};
  const source:BoundedReadSource={snapshot:changing.source.snapshot,read};
  await assert.rejects(readCanonicalFrame({frames,source,read,codecPolicy:RGBA_WINDOW_POLICY}),/source snapshot changed/);
  const invalid=await archive(1,true),badSource=sourceFor(invalid.blob).source;
  await assert.rejects(readCanonicalFrame({frames:[invalid.index.get(101)!],source:badSource,read:badSource.read,codecPolicy:RGBA_WINDOW_POLICY}),/픽셀 불일치/);
  const controller=new AbortController(),cancel=sourceFor(good.blob);
  const cancelRead=async(offset:number,length:number)=>{const bytes=await cancel.source.read(offset,length);controller.abort(new Error('cancelled-window'));return bytes;};
  const cancelledSource:BoundedReadSource={snapshot:cancel.source.snapshot,read:cancelRead};
  await assert.rejects(readCanonicalFrame({frames,source:cancelledSource,read:cancelRead,codecPolicy:RGBA_WINDOW_POLICY,signal:controller.signal}),/cancelled-window/);
});

test('window random access verifies an intermediate dependency before reading any later frame',async()=>{
  const data=await archive(8,4),range=data.index.decodeRange(108),{source,reads}=sourceFor(data.blob);
  await assert.rejects(readCanonicalFrame({frames:range.frameIds.map(id=>data.index.getByFrameId(id)!),
    source,read:source.read,codecPolicy:RGBA_WINDOW_POLICY}),/픽셀 불일치: 4/);
  assert.ok(reads.length>0);assert.ok(reads.every(read=>read.offset<data.index.get(105)!.offset));
});

test('an oversized unknown window header is streamed within the backend range cap before rejection',async()=>{
  const pixels=Uint8Array.from({length:16},(_,i)=>i),hash=await pixelHash(pixels);
  const header={kind:'frame' as const,id:1,time:0,width:2,height:2,key:true,hash,canonical:true as const,xor:true,...tags,junk:'x'.repeat(70_000)};
  const blob=new Blob(entryParts(header,fastCompress(packPixels(pixels)))),{source,reads}=sourceFor(blob);
  await assert.rejects(readCanonicalFrame({frames:[{frameId:1,offset:0,endOffset:blob.size,width:2,height:2,
    captureTime:0,key:true,pixelHash:hash,...tags}],source,read:source.read,codecPolicy:RGBA_WINDOW_POLICY}),/unknown frame field/);
  assert.ok(reads.length>=4);assert.ok(reads.every(read=>read.length<=32768));
});

test('aborting an outstanding window header read rejects before late native completion can publish',async()=>{
  const data=await archive(1),controller=new AbortController();let markStarted:()=>void=()=>{},finish:(bytes:Uint8Array<ArrayBuffer>)=>void=()=>{},reads=0,published=false;
  const started=new Promise<void>(resolve=>{markStarted=resolve;});
  const source:BoundedReadSource={snapshot:()=>({byteLength:data.blob.size,revision:'held-header'}),
    read:()=>{reads++;markStarted();return new Promise(resolve=>{finish=resolve;});}};
  const pending=readCanonicalFrame({frames:[data.index.get(101)!],source,read:source.read,
    codecPolicy:RGBA_WINDOW_POLICY,signal:controller.signal});
  void pending.then(()=>{published=true;},()=>{});
  await started;controller.abort(new Error('stop-held-header'));
  await assert.rejects(pending,/stop-held-header/);
  finish(new Uint8Array(8));await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.equal(published,false);
});

test('window prefix recovery preserves tags and the exact last complete entry across truncation',async()=>{
  const data=await archive(10),full=await inspectExactPrefix(data.blob,signal());
  assert.equal(full.complete,true);assert.equal(full.frames,10);assert.equal(full.policy,RGBA_WINDOW_POLICY);assert.equal(full.codec,RGBA_WINDOW_CODEC);
  assert.equal(Object.hasOwn(full,'storageVersion'),false);
  const frame10=data.index.get(110)!,cut=data.blob.slice(0,frame10.endOffset-1),partial=await inspectExactPrefix(cut,signal());
  assert.equal(partial.complete,false);assert.equal(partial.frames,9);assert.equal(partial.policy,RGBA_WINDOW_POLICY);
  assert.ok(partial.bytes<=frame10.offset);assert.equal(partial.blob.size,partial.bytes);
});

test('window prefixes reject ninth delta and new/legacy mixing while retaining their verified prefix boundary',async()=>{
  const data=await archive(8),first=new Blob([data.blob]);
  const pixels=data.originals.at(-1)!,hash=await pixelHash(pixels);
  const ninth:ExactFrame={kind:'frame',id:9,time:9,width:128,height:128,key:false,hash,canonical:true,xor:true,...tags};
  const tail=new Blob(entryParts(ninth,fastCompress(packPixels(pixels,pixels,true))));
  const over=await inspectExactPrefix(new Blob([first,tail]),signal());
  assert.equal(over.frames,8);assert.equal(over.complete,false);assert.equal(over.bytes,first.size);
  const {policy,codec,...plain}=ninth;void policy;void codec;
  const legacy=new Blob(entryParts({...plain,key:true,codec:'lz4'},fastCompress(packPixels(pixels))));
  const mixed=await inspectExactPrefix(new Blob([first,legacy]),signal());
  assert.equal(mixed.complete,false);assert.equal(mixed.frames,8);assert.equal(mixed.bytes,first.size);assert.equal(mixed.policy,RGBA_WINDOW_POLICY);
});
