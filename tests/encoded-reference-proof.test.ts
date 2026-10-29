import test from 'node:test';
import assert from 'node:assert/strict';
import {compareReferencePixels,createEncodedCandidateSearch,linkRawPixelProof,parsePreparedEncodedReference} from '../dev/encoded-reference-proof';

const hash='a'.repeat(64),other='b'.repeat(64),candidate={sourceFrameId:58,captureTime:900,width:2,height:2,pixelSha256:hash};
const input=()=>({caseId:'c8610f98618113b4ce95d74d8c09d59b395daed75921621dadc5f35df95b0609',
 sourceArchive:{bytes:512079069,sha256:other,manifestMatched:true,unmodifiedAfterInspection:true,recordState:'partial',exactComplete:false},
 encodedReference:{path:'work/encoded-reference/video5-recovery-source.webm',bytes:11529428,type:'video/webm',sha256:hash,outputFileSha256:hash,
  outputFileMatchesContainedVideo:true,metadataDurationAnnotationSeconds:18000},
 exactHeaderInspection:{recoveryCandidates:[{...candidate,physicalPhase:'recovery'}]}});
test('prepared reference keeps partial archive and duration annotation separate and forbids arbitrary source paths',()=>{
 const parsed=parsePreparedEncodedReference(input());assert.equal(parsed.sourceArchive.exactComplete,false);
 assert.equal(parsed.encodedReference.metadataDurationAnnotationSeconds,18000);assert.equal(parsed.candidates[0].captureTime,900);
 for(const changed of [
  {...input(),caseId:'a'.repeat(64)},
  {...input(),encodedReference:{...input().encodedReference,path:'https://example.com/video.webm'}},
  {...input(),encodedReference:{...input().encodedReference,bytes:33*1024*1024}},
  {...input(),encodedReference:{...input().encodedReference,outputFileSha256:other}},
  {...input(),sourceArchive:{...input().sourceArchive,exactComplete:true}},
  {...input(),exactHeaderInspection:{recoveryCandidates:[{...candidate,physicalPhase:'input'}]}},
  {...input(),exactHeaderInspection:{recoveryCandidates:[{...candidate,physicalPhase:'recovery'},{...candidate,physicalPhase:'recovery'}]}},
 ])assert.throws(()=>parsePreparedEncodedReference(changed));
});
test('complete RGBA and dimensions find actual ordinal and PTS without using capture time as a lookup',()=>{
 const search=createEncodedCandidateSearch([candidate]);
 search.accept({ordinal:1,ptsSeconds:0,durationSeconds:.04,width:2,height:2,pixelSha256:other});
 search.accept({ordinal:2,ptsSeconds:.04,durationSeconds:.03,width:2,height:2,pixelSha256:hash});
 const found=search.snapshot();assert.equal(found.matched,true);assert.equal(found.candidates[0].annotatedCaptureTimeMatches,0);
 assert.deepEqual(found.candidates[0].matches[0],{ordinal:2,ptsSeconds:.04,durationSeconds:.03,width:2,height:2,pixelSha256:hash});
 assert.equal(found.candidates[0].expectedEncodedDurationSeconds,null);
});
test('independent raw pixel proof must match the same source bytes and exact candidate time, dimensions and SHA',()=>{
 const prepared=parsePreparedEncodedReference(input()),row={id:58,time:900,width:2,height:2,hash};
 const raw={caseId:prepared.caseId,fileSha256:prepared.sourceArchive.sha256,fileBytes:prepared.sourceArchive.bytes,inputUnmodified:true,
  metadata:{version:4,recordState:'partial',exact:{complete:false,frames:1}},pixelVerification:{physicalVerified:1,physicalHashes:[row]}};
 assert.equal(linkRawPixelProof(raw,prepared).physicalFramesVerified,1);
 for(const changed of [
  {...raw,fileSha256:hash},
  {...raw,pixelVerification:{...raw.pixelVerification,physicalHashes:[{...row,time:900.001}]}},
  {...raw,pixelVerification:{...raw.pixelVerification,physicalHashes:[{...row,hash:other}]}},
  {...raw,pixelVerification:{...raw.pixelVerification,physicalHashes:[{...row,width:1,height:4}]}},
  {...raw,metadata:{...raw.metadata,exact:{complete:true,frames:1}}},
 ])assert.throws(()=>linkRawPixelProof(changed,prepared));
});
test('same SHA with different dimensions cannot establish a reference and repeated matches remain ambiguous',()=>{
 const search=createEncodedCandidateSearch([candidate]);
 search.accept({ordinal:1,ptsSeconds:0,durationSeconds:.04,width:1,height:4,pixelSha256:hash});
 assert.equal(search.snapshot().matched,false);assert.equal(search.snapshot().candidates[0].hashWithWrongDimensions,1);
 for(let ordinal=2;ordinal<=40;ordinal++)search.accept({ordinal,ptsSeconds:ordinal*.04,durationSeconds:.04,width:2,height:2,pixelSha256:hash});
 const found=search.snapshot().candidates[0];assert.equal(found.matchingFrameCount,39);assert.equal(found.ambiguousPixelMatch,true);
 assert.equal(found.matches.length,32);assert.equal(found.matchesOmitted,7);assert.equal(found.lastMatch?.ordinal,40);
});
test('sequential matcher rejects skipped ordinals, regressing PTS, invalid durations and oversized frames',()=>{
 for(const sample of [
  {ordinal:2,ptsSeconds:0,durationSeconds:.04,width:2,height:2,pixelSha256:hash},
  {ordinal:1,ptsSeconds:0,durationSeconds:NaN,width:2,height:2,pixelSha256:hash},
  {ordinal:1,ptsSeconds:0,durationSeconds:.04,width:10000,height:10000,pixelSha256:hash},
 ])assert.throws(()=>createEncodedCandidateSearch([candidate]).accept(sample));
 const search=createEncodedCandidateSearch([candidate]);search.accept({ordinal:1,ptsSeconds:1,durationSeconds:.04,width:2,height:2,pixelSha256:hash});
 assert.throws(()=>search.accept({ordinal:2,ptsSeconds:.5,durationSeconds:.04,width:2,height:2,pixelSha256:hash}));
});

test('all preserved recovery candidates stay bounded and candidate metadata is immutable during decode',()=>{
 const targets=Array.from({length:43},(_,index)=>({...candidate,sourceFrameId:index+1,physicalPhase:'recovery'}));
 const parsed=parsePreparedEncodedReference({...input(),exactHeaderInspection:{recoveryCandidates:targets}});
 assert.equal(parsed.candidates.length,43);
 const search=createEncodedCandidateSearch(parsed.candidates);
 parsed.candidates[0].pixelSha256=other;parsed.candidates[0].captureTime=123;
 search.accept({ordinal:1,ptsSeconds:0,durationSeconds:.04,width:2,height:2,pixelSha256:hash});
 const found=search.snapshot();assert.equal(found.candidates[0].pixelSha256,hash);assert.equal(found.candidates[0].captureTime,900);
 assert.equal(found.candidates.filter(row=>row.matched).length,43);
 for(const count of [0,65])assert.throws(()=>parsePreparedEncodedReference({...input(),exactHeaderInspection:{recoveryCandidates:Array.from({length:count},(_,index)=>({...targets[0],sourceFrameId:index+1}))}}));
 for(const invalid of [[],[candidate,candidate],Array.from({length:65},(_,index)=>({...candidate,sourceFrameId:index+1})),[{...candidate,width:0}]])assert.throws(()=>createEncodedCandidateSearch(invalid));
});

test('RGBA diagnosis distinguishes color and alpha changes, records exact bounds and caps example pixels',()=>{
 const expected=new Uint8Array([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255]);
 const actual=expected.slice();actual[4]=42;actual[11]=0;
 const diff=compareReferencePixels(expected,actual,2,2);
 assert.equal(diff.equal,false);assert.equal(diff.changedPixels,2);assert.equal(diff.changedBytes,2);
 assert.deepEqual(diff.changedByChannel,[1,0,0,1]);assert.deepEqual(diff.maxDeltaByChannel,[2,0,0,255]);
 assert.deepEqual(diff.bounds,{x:0,y:0,width:2,height:2});assert.equal(diff.expectedNonOpaquePixels,0);assert.equal(diff.actualNonOpaquePixels,1);
 assert.deepEqual(diff.samples.map(sample=>[sample.x,sample.y]),[[1,0],[0,1]]);
 const same=compareReferencePixels(expected,expected,2,2);assert.equal(same.equal,true);assert.equal(same.bounds,null);
 assert.equal(compareReferencePixels(new Uint8Array(80),new Uint8Array(80).fill(255),20,1).samples.length,16);
 assert.throws(()=>compareReferencePixels(expected,actual,1,1));assert.throws(()=>compareReferencePixels(expected,actual,0,4));
});
