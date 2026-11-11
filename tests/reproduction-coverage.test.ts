import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recordedCoverage,recordedCoverageLabel,replayInputScope} from '../src/features/card-scanner/reproduction/reproduction-coverage';
import {createReproductionBundle,openReproduction,replaySettings,type ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';

const recording=():ReproductionFile=>({video:new Blob(),exact:new Blob(['bytes']),metadata:{
 version:3,createdAt:'2026-10-30T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,
 warnings:[],duration:0,type:'',bytes:0,seed:[],result:null,recordState:'complete',
 exact:{frames:1,events:0,bytes:5,dropped:0,peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''},
}});
function forgedFile(file:ReproductionFile):Blob {
 const magic='LOACARD-REPLAY1\n',meta=new Blob([JSON.stringify(file.metadata)]),length=new Uint8Array(4);
 new DataView(length.buffer).setUint32(0,meta.size,true);
 return new Blob([magic,length,meta,file.video,file.exact!]);
}

test('the metadata claim is distinct from pixel verification and old missing state is unknown',async()=>{
 const original=recording(),loaded=await openReproduction(createReproductionBundle(original),new AbortController().signal);
 assert.equal(recordedCoverage(loaded.metadata),'declared-complete');
 assert.match(recordedCoverageLabel(loaded.metadata),/전체 화면 보존 미확인/);
 assert.equal(replaySettings(loaded).truncated,false);
 delete original.metadata.recordState;
 const legacy=await openReproduction(createReproductionBundle(original),new AbortController().signal);
 assert.equal(recordedCoverage(legacy.metadata),'unknown');assert.equal(replaySettings(legacy).truncated,true);
 assert.equal(await legacy.exact!.text(),'bytes','legacy input remains available for actual validation');
});

test('input scope distinguishes selected exact frames, compressed preview and absent input',()=>{
 const exact=replayInputScope(true,false),mixed=replayInputScope(true,true),video=replayInputScope(false,true),none=replayInputScope(false,false);
 assert.match(exact,/저장된 선택·획득 화면/);assert.match(exact,/저장되지 않은 화면/);
 assert.doesNotMatch(exact,/미리보기 압축 영상/);
 assert.match(mixed,/미리보기 압축 영상/);assert.match(mixed,/판독에 쓰는 픽셀과 다를 수/);
 assert.match(video,/압축 영상/);assert.match(video,/원래 입력 픽셀/);
 assert.match(none,/재현할 픽셀이나 영상 입력이 없습니다/);
 assert.match(replayInputScope(true,false,false),/입력 프레임이 없어 재판독할 수 없습니다/);
 assert.match(replayInputScope(true,true,false),/압축 영상은 미리보기로만/);
});

test('partial or failed session never inherits the exact stream complete label',async()=>{
 for(const state of ['failed','partial'] as const){
  const file=recording();file.metadata.recordState=state;
  const loaded=await openReproduction(createReproductionBundle(file),new AbortController().signal);
  assert.equal(recordedCoverage(loaded.metadata),'partial');assert.equal(replaySettings(loaded).truncated,true);
  assert.match(recordedCoverageLabel(loaded.metadata),/부분 또는 실패/);
 }
 const incomplete=recording();incomplete.metadata.completed=false;
 assert.equal(recordedCoverage(incomplete.metadata),'partial');
});

test('a complete claim conflicting with dropped inputs or a recorder error is rejected at both boundaries',async()=>{
 for(const problem of [{dropped:1,error:''},{dropped:0,error:'storage failed'},{dropped:1,error:'storage failed'}]){
  const file=recording();file.metadata.recordState='failed';Object.assign(file.metadata.exact!,problem);
  assert.equal(replaySettings(file).truncated,true);
  assert.throws(()=>createReproductionBundle(file),/누락·오류/);
  await assert.rejects(openReproduction(forgedFile(file),new AbortController().signal),/누락·오류/);
 }
});
