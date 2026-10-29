import test from 'node:test';
import assert from 'node:assert/strict';
import {compareNativePlanePasses,comparePaintedRgbaPasses,parseNativePlaneSource} from '../dev/native-plane-proof-worker';
import type {NativePlaneRecord,PaintedRgbaRecord} from '../dev/native-plane-proof-worker';

const hash='a'.repeat(64),archiveHash='b'.repeat(64);
function source(){return {caseId:'c8610f98618113b4ce95d74d8c09d59b395daed75921621dadc5f35df95b0609',
 sourceArchive:{sha256:archiveHash,manifestMatched:true,unmodifiedAfterInspection:true,recordState:'partial',exactComplete:false},
 encodedReference:{path:'work/encoded-reference/video5-recovery-source.webm',bytes:11529428,type:'video/webm',sha256:hash,
  outputFileSha256:hash,outputFileMatchesContainedVideo:true,metadataDurationAnnotationSeconds:18.0399}};}
const color={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
function record(ordinal=1):NativePlaneRecord{return {ordinal,
 sample:{timestampSeconds:(ordinal-1)*.04,durationSeconds:.04,rotation:0,flip:false,pixelAspectRatio:{numerator:1,denominator:1},colorSpace:{...color}},
 native:{format:'I420',codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},
  timestampMicroseconds:(ordinal-1)*40000,durationMicroseconds:40000,colorSpace:{...color}},
 layout:[{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}],bytes:6,sha256:hash,nativeI420OrNv12:true,allocatedBytes:16,
 explicitRgb:{status:'supported',bytes:16,sha256:hash,layout:[{offset:0,stride:8}],repeatSha256:hash,repeatLayout:[{offset:0,stride:8}]}};}

test('native-plane preparation preserves partial source and rejects arbitrary paths, oversize or unverified bytes',()=>{
 const accepted=parseNativePlaneSource(source());assert.equal(accepted.sourceArchiveComplete,false);assert.equal(accepted.encodedSourceCompleteness,'unknown');
 assert.equal(accepted.metadataDurationAnnotationSeconds,18.0399);
 for(const changed of [
  {...source(),caseId:'c'.repeat(64)},
  {...source(),sourceArchive:{...source().sourceArchive,exactComplete:true}},
  {...source(),encodedReference:{...source().encodedReference,path:'https://example.com/video.webm'}},
  {...source(),encodedReference:{...source().encodedReference,bytes:33*1024*1024}},
  {...source(),encodedReference:{...source().encodedReference,outputFileSha256:archiveHash}},
 ])assert.throws(()=>parseNativePlaneSource(changed));
});

test('native bytes, native metadata and plane packing must all agree at the same ordinal',()=>{
 const first=[record(),record(2)],same=structuredClone(first);
 const good=compareNativePlanePasses(first,same);assert.equal(good.nativeYuvDeterministic,true);assert.equal(good.matchingFrames,2);
 const byteChanged=structuredClone(first);byteChanged[1].sha256=archiveHash;
 assert.equal(compareNativePlanePasses(first,byteChanged).byteDifferences,1);
 for(const changed of [
  (row:NativePlaneRecord)=>{row.layout[1].stride=2;},
  (row:NativePlaneRecord)=>{row.native.colorSpace.fullRange=true;},
  (row:NativePlaneRecord)=>{row.native.visibleRect!.x=1;},
  (row:NativePlaneRecord)=>{row.sample.durationSeconds=.05;},
 ]){const other=structuredClone(first);changed(other[0]);const compared=compareNativePlanePasses(first,other);
  assert.equal(compared.nativeYuvDeterministic,false);assert.equal(compared.byteDifferences,0);assert.equal(compared.metadataDifferences,1);}
 assert.equal(compareNativePlanePasses(first,[record()]).sameFrameCount,false);
});

test('equal RGB buffers do not claim native YUV determinism and difference summaries remain bounded',()=>{
 const rgb=record();rgb.native.format='RGBA';rgb.nativeI420OrNv12=false;
 const other=structuredClone(rgb),comparison=compareNativePlanePasses([rgb],[other]);
 assert.equal(comparison.matchedAll,true);assert.equal(comparison.allNativeI420OrNv12,false);assert.equal(comparison.nativeYuvDeterministic,false);
 const first=Array.from({length:80},(_,index)=>record(index+1)),second=structuredClone(first);second.forEach(row=>row.sha256=archiveHash);
 const bounded=compareNativePlanePasses(first,second);assert.equal(bounded.changedFrames,80);assert.equal(bounded.differences.length,64);assert.equal(bounded.differencesOmitted,16);
});

test('invalid pass order or missing metadata cannot produce a matching summary',()=>{
 assert.throws(()=>compareNativePlanePasses([],[]));assert.throws(()=>compareNativePlanePasses([record(2)],[record(2)]));
 const bad=record();bad.layout[1].offset=6;assert.throws(()=>compareNativePlanePasses([bad],[record()]));
});

test('explicit RGBA capability and repeat differences cannot turn matching native planes into a broader success',()=>{
 const first=record(),second=structuredClone(first);assert.equal(compareNativePlanePasses([first],[second]).explicitRgb.matchedAll,true);
 if(second.explicitRgb.status!=='supported')assert.fail('fixture');second.explicitRgb.repeatSha256=archiveHash;
 const changed=compareNativePlanePasses([first],[second]);assert.equal(changed.nativeYuvDeterministic,true);
 assert.equal(changed.explicitRgb.sameFrameRepeatsMatch,false);assert.equal(changed.explicitRgb.matchedAll,false);
 second.explicitRgb={status:'unsupported',error:'NotSupportedError'};
 const unsupported=compareNativePlanePasses([first],[second]);assert.equal(unsupported.nativeYuvDeterministic,true);
 assert.equal(unsupported.explicitRgb.allSupported,false);assert.equal(unsupported.explicitRgb.matchedAll,null);
});

function painted(ordinal=1):PaintedRgbaRecord {
 const time=(ordinal-1)*.04;
 return {ordinal,time,duration:0,width:2,height:2,workerSha256:hash,paintSha256:hash,nonOpaquePixels:0,
  metadata:{recipe:'webcodecs-rgba-srgb-v1',ordinal,pts:time,duration:0,trackId:1,decoderPreference:'no-preference',rgbaSha256:hash,
   geometry:{codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,pixelAspectRatio:{num:1,den:1}},
   nativeFormat:'I420',nativeColorSpace:{...color},sampleColorSpace:{...color},nativeTimestampMicroseconds:Math.round(time*1e6),nativeDurationMicroseconds:null,
   rgbaLayout:{format:'RGBA',colorSpace:'srgb',offset:0,stride:8,bytes:16}}};
}

test('actual canvas hashes must match worker receipts within each pass as well as across both passes',()=>{
 const first=[painted(),painted(2)],second=structuredClone(first);
 assert.equal(comparePaintedRgbaPasses(first,second).matchedAll,true);
 second[1].paintSha256=archiveHash;const changed=comparePaintedRgbaPasses(first,second);
 assert.equal(changed.matchedAll,false);assert.equal(changed.postPaintMismatchesSecond,1);assert.equal(changed.paintHashChanges,1);
 const sameWrong=structuredClone(first);sameWrong.forEach(row=>row.paintSha256=archiveHash);
 const internallyWrong=comparePaintedRgbaPasses(sameWrong,structuredClone(sameWrong));
 assert.equal(internallyWrong.workerHashChanges,0);assert.equal(internallyWrong.paintHashChanges,0);
 assert.equal(internallyWrong.postPaintMismatchesFirst,2);assert.equal(internallyWrong.matchedAll,false,'repeated wrong painting is not proof');
});

test('painted RGBA comparison preserves timing/geometry and bounded failure details',()=>{
 const first=[painted(),painted(2)],changed=structuredClone(first);
 changed[0].metadata={...changed[0].metadata,trackId:2};
 assert.equal(comparePaintedRgbaPasses(first,changed).metadataChanges,1);
 assert.equal(comparePaintedRgbaPasses(first,[painted()]).matchedAll,false);
 const many=Array.from({length:80},(_,index)=>painted(index+1)),bad=structuredClone(many);bad.forEach(row=>row.paintSha256=archiveHash);
 const bounded=comparePaintedRgbaPasses(many,bad);assert.equal(bounded.paintHashChanges,80);assert.equal(bounded.differences.length,64);assert.equal(bounded.differencesOmitted,16);
 const invalid=painted();invalid.ordinal=2;assert.throws(()=>comparePaintedRgbaPasses([invalid],[painted()]));
});
