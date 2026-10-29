import test from 'node:test';
import assert from 'node:assert/strict';
import {STREAM_PATCH_SOURCE_LIMITS} from '../src/features/card-scanner/streaming-delta-source';
import {RGBA_WINDOW_CODEC as CODEC,RGBA_WINDOW_POLICY as POLICY,RGBA_WINDOW_LIMITS as LIMITS,
  parseReplayPolicy,parseWindowFrame,windowWorkingSet,admitWindowFrame,admitLegacyRgbaFrame} from '../src/features/card-scanner/rgba-window-policy';
import type {DependencyState,WindowPolicy} from '../src/features/card-scanner/rgba-window-policy';

const outer=()=>({version:6,exact:{canonical:true,codec:CODEC,policy:POLICY}});
const selected=()=>parseReplayPolicy(outer()) as WindowPolicy;
const frame=(changes:Record<string,unknown>={})=>({kind:'frame',id:1,time:0,width:2560,height:1440,
  key:true,hash:'a'.repeat(64),canonical:true,codec:CODEC,policy:POLICY,xor:true,...changes});
const legacy=(changes:Record<string,unknown>={})=>{const {policy:_omitted,...value}=frame(changes);return {...value,codec:'lz4'};};
const admission=(previous:DependencyState|null,changes:Record<string,unknown>={})=>admitWindowFrame(selected(),previous,frame(changes),9);
test('v6 requires exact outer tags and returns frozen policy; legacy versions do not auto-upgrade',()=>{
  assert.deepEqual(selected(),{kind:'rgba-window',version:6,codec:CODEC,policy:POLICY});assert.ok(Object.isFrozen(selected()));
  for(const version of [1,2,3,4,5])assert.deepEqual(parseReplayPolicy({version}),{kind:'legacy-sum',version});
  assert.deepEqual(parseReplayPolicy({version:5,exact:{canonical:true,storageVersion:1,nativeFrames:3}}),{kind:'legacy-sum',version:5});
});
test('unknown versions, absent/unknown/misplaced tags and outer/inner conflicts fail closed',()=>{
  for(const value of [null,[],{}, {version:0},{version:7},{version:'6'}, {version:6},
    {...outer(),codec:CODEC},{...outer(),policy:POLICY},
    {version:6,exact:{canonical:true,codec:'lz4',policy:POLICY}},
    {version:6,exact:{canonical:true,codec:CODEC,policy:'future'}},
    {version:6,exact:{canonical:false,codec:CODEC,policy:POLICY}},
    {version:6,exact:{canonical:true,codec:CODEC}},
    {version:4,exact:{canonical:true,codec:CODEC,policy:POLICY}},
    {version:5,exact:{policy:undefined}}])assert.throws(()=>parseReplayPolicy(value));
  for(const changed of [{codec:'lz4'},{codec:undefined},{policy:undefined},{policy:'other'}])
    assert.throws(()=>parseWindowFrame(frame(changed),9,selected()),/conflict/);
});
test('v6 disallows storage metadata by presence, including undefined/null',()=>{
  for(const name of ['storage','storageVersion','nativeFrames','rgbaFrames','nativeAttestedFrames','nativeAttestationBudget'])
    for(const value of [undefined,null,0,1])assert.throws(()=>parseReplayPolicy({version:6,exact:{...outer().exact,[name]:value}}));
  for(const value of [undefined,null,{kind:'rgba'},{}])assert.throws(()=>parseWindowFrame(frame({storage:value}),9,selected()));
});
test('accessors/symbols/custom prototypes do not execute during gate or frame parsing',()=>{
  let called=0;
  const getter=Object.defineProperty({version:6},'exact',{get(){called++;return outer().exact;},enumerable:true});
  assert.throws(()=>parseReplayPolicy(getter));
  const inner=Object.defineProperty(frame(),'id',{get(){called++;return 1;},enumerable:true});
  assert.throws(()=>parseWindowFrame(inner,9,selected()));assert.equal(called,0);
  assert.throws(()=>parseReplayPolicy(Object.assign(Object.create({version:6}),{exact:outer().exact})));
  assert.throws(()=>parseReplayPolicy({...outer(),[Symbol('policy')]:POLICY}));
  assert.equal(parseReplayPolicy(Object.assign(Object.create(null),outer())).kind,'rgba-window');
});
test('explicit working set includes both rasters, bounded decoder, 2MiB outer and 256KiB hash',()=>{
  const budget=windowWorkingSet(2560,1440);
  assert.equal(budget.rgbaBytes,14_745_600);assert.equal(budget.decoderOwnedBytes,14_860_301);
  assert.equal(budget.publishedCopyBytes,14_745_600);assert.equal(budget.outerBytes,2_097_152);
  assert.equal(budget.hashBytes,262_144);assert.equal(budget.totalBytes,31_965_197);assert.equal(budget.admitted,true);
  assert.equal(budget.limitBytes,33_554_432);assert.ok(Object.isFrozen(budget));
  assert.equal(LIMITS.historyBytes,STREAM_PATCH_SOURCE_LIMITS.historyBytes);
  assert.equal(LIMITS.matchScratchBytes,STREAM_PATCH_SOURCE_LIMITS.matchScratchBytes);
  assert.equal(LIMITS.inputBytes,STREAM_PATCH_SOURCE_LIMITS.inputChunkBytes);
});
test('working set admission changes exactly at pixel-aligned limit and rejects excessive dimensions',()=>{
  const fixed=LIMITS.historyBytes+LIMITS.matchScratchBytes+LIMITS.inputBytes+LIMITS.headerBytes+LIMITS.outerBytes+LIMITS.hashBytes;
  const maxPixels=Math.floor((LIMITS.workingSetBytes-fixed)/8);
  assert.equal(windowWorkingSet(maxPixels,1).admitted,true);
  assert.equal(windowWorkingSet(maxPixels+1,1).admitted,false);
  assert.throws(()=>parseWindowFrame(frame({width:maxPixels+1,height:1}),9,selected()),/working set/);
  for(const dimensions of [[0,1],[-1,1],[1.5,1],[NaN,1],[Infinity,1],[Number.MAX_SAFE_INTEGER,2],[1,Number.MAX_SAFE_INTEGER]])
    assert.throws(()=>windowWorkingSet(...dimensions as [number,number]));
  assert.equal(windowWorkingSet(3840,2160).admitted,false);
});
test('v6 parser checks strict frame metadata and fast wrapper payload bounds without allocating rasters',()=>{
  const good=frame({width:1,height:1});assert.equal(parseWindowFrame(good,9,selected()).id,1);
  assert.ok(Object.isFrozen(parseWindowFrame(good,21,selected()))); // 4 pixels + 8 block header + 4 count + 5 wrapper
  for(const size of [-1,0,8,22,NaN,Infinity,1.5])assert.throws(()=>parseWindowFrame(good,size,selected()));
  for(const changed of [{kind:'event'},{id:0},{id:1.5},{time:-1},{time:NaN},{time:Infinity},{key:1},
    {hash:'A'.repeat(64)},{hash:'a'.repeat(63)},{canonical:undefined},{canonical:false},{xor:undefined},{xor:1},
    {phase:undefined},{phase:'backup'},{extra:1}])assert.throws(()=>parseWindowFrame(frame(changed),9,selected()));
  assert.throws(()=>parseWindowFrame(frame(),9,{...selected(),policy:'wrong'} as never));
});
test('new policy admits key plus seven deltas even though historical sum exceeds32MiB',()=>{
  let state:DependencyState|null=null;
  for(let id=1;id<=8;id++){
    const next=admission(state,{id,key:id===1});state=next.state;
    assert.equal(state.chainFrames,id);assert.equal(state.keyFrameId,1);assert.equal(next.workingSet.totalBytes,31_965_197);
  }
  assert.equal(state!.historicalRgbaWorkBytes,117_964_800);assert.ok(Object.isFrozen(state));
  const before={...state};assert.throws(()=>admission(state,{id:9,key:false}),/seven deltas/);assert.deepEqual(state,before);
  const reset=admission(state,{id:9,key:true});assert.equal(reset.state.chainFrames,1);assert.equal(reset.state.keyFrameId,9);
});
test('legacy keeps historical SUM32MiB and large-single-key exception unchanged',()=>{
  const first=admitLegacyRgbaFrame(null,legacy()),second=admitLegacyRgbaFrame(first,legacy({id:2,key:false}));
  assert.equal(second.historicalRgbaWorkBytes,29_491_200);
  assert.throws(()=>admitLegacyRgbaFrame(second,legacy({id:3,key:false})),/legacy SUM/);
  const big=admitLegacyRgbaFrame(null,legacy({width:4096,height:4096}));assert.equal(big.historicalRgbaWorkBytes,64*1024*1024);
  assert.throws(()=>admitLegacyRgbaFrame(big,legacy({id:2,key:false,width:4096,height:4096})),/legacy SUM/);
  let tiny:DependencyState|null=null;
  for(let id=1;id<=8;id++)tiny=admitLegacyRgbaFrame(tiny,legacy({id,key:id===1,width:1,height:1}));
  assert.throws(()=>admitLegacyRgbaFrame(tiny,legacy({id:9,key:false,width:1,height:1})),/seven deltas/);
});
test('legacy historical SUM accepts exactly32MiB and rejects its next delta',()=>{
  const dimensions={width:2048,height:2048};
  const key=admitLegacyRgbaFrame(null,legacy(dimensions));
  const boundary=admitLegacyRgbaFrame(key,legacy({...dimensions,id:2,key:false}));
  assert.equal(boundary.historicalRgbaWorkBytes,32*1024*1024);
  assert.throws(()=>admitLegacyRgbaFrame(boundary,legacy({...dimensions,id:3,key:false})),/legacy SUM/);
  assert.equal(admitLegacyRgbaFrame(boundary,legacy({...dimensions,id:3,key:true})).chainFrames,1);
});
test('chain starts only at a key, frame order is increasing and geometry changes require a new key',()=>{
  assert.throws(()=>admission(null,{key:false}),/matching key/);
  const state=admission(null).state;
  assert.throws(()=>admission(state,{id:1,key:true}),/order/);
  assert.throws(()=>admission(state,{id:2,key:false,width:1920,height:1080}),/matching key/);
  const resized=admission(state,{id:5,key:true,width:1920,height:1080});assert.equal(resized.state.keyFrameId,5);
  assert.equal(admission(resized.state,{id:7,key:false,width:1920,height:1080}).state.chainFrames,2);
});
test('mixing legacy/new dependency states or forged state facts is rejected before mutation',()=>{
  const current=admission(null).state,old=admitLegacyRgbaFrame(null,legacy());
  assert.throws(()=>admission(old,{id:2,key:false}),/state/);
  assert.throws(()=>admitLegacyRgbaFrame(current,legacy({id:2,key:false})),/state/);
  for(const changed of [{chainFrames:0},{chainFrames:9},{historicalRgbaWorkBytes:1},{keyFrameId:2},
    {lastFrameId:NaN},{chainFrames:1,lastFrameId:2,keyFrameId:1},
    {chainFrames:3,lastFrameId:2,keyFrameId:1,historicalRgbaWorkBytes:3*2560*1440*4},
    {width:3840,height:2160,historicalRgbaWorkBytes:3840*2160*4},{extra:1}])
    assert.throws(()=>admission({...current,...changed} as never,{id:3,key:false}));
  assert.throws(()=>admitLegacyRgbaFrame(null,frame()),/policy|codec/);
});
test('new outer policy rejects even a tiny legacy-tagged inner frame',()=>{
  assert.throws(()=>parseWindowFrame(legacy({width:1,height:1}),9,selected()),/conflict/);
  assert.throws(()=>admitWindowFrame({kind:'legacy-sum',version:4} as never,null,frame({width:1,height:1}),9),/policy/);
});
test('legacy policy never accepts the new codec through missing policy or outer downgrade',()=>{
  const {policy:_tag,...newCodecWithoutPolicy}=frame({width:1,height:1});
  assert.throws(()=>admitLegacyRgbaFrame(null,newCodecWithoutPolicy),/legacy codec/);
  for(const version of [1,2,3,4,5])assert.throws(()=>parseReplayPolicy({version,exact:{canonical:true,codec:CODEC,policy:POLICY}}),/legacy/);
});
test('new policy has no large-single-key working-set exception',()=>{
  const oversized={width:4096,height:4096};
  assert.equal(admitLegacyRgbaFrame(null,legacy(oversized)).chainFrames,1);
  assert.throws(()=>admission(null,oversized),/working set/);
  assert.equal(parseReplayPolicy({version:4}).kind,'legacy-sum');
  assert.equal(parseReplayPolicy(outer()).kind,'rgba-window');
});