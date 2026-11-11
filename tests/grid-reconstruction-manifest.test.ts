import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGridReconstructionManifest,parseGridReconstructionManifest} from '../src/features/card-scanner/session/grid-reconstruction-manifest';
const sha=(c:string)=>c.repeat(64);
const base=()=>({
  createdAt:'2026-11-05T00:00:00.000Z',
  input:{caseId:sha('a'),sha256:sha('b'),bytes:27_543_837,duration:14.5666,width:2560,height:1440},
  settings:{stepSeconds:.05,xs:[138,295,453,610,767,924,1081,1239,1396,1553],rowOriginY:392,pitchY:243,cardWidth:140,cardHeight:210,matcher:'portrait-atlas'},
  environment:{sourceDigest:sha('c'),files:949,build:'d38be23'},
  frames:[{time:.2,top:null,frameSha256:sha('d'),probeAccepted:0,accepted:0},
    {time:4.7,top:394,frameSha256:sha('e'),probeAccepted:4,accepted:26}],
  union:[{id:'3200813',name:'베스칼',firstTime:4.7,slot:27,corr:.992,margin:.539,cropSha256:sha('f')}],
  expected:397,
});
test('manifest preserves input, settings, frame order and crop hashes',()=>{
  const manifest=createGridReconstructionManifest(base());
  assert.equal(manifest.version,1);
  assert.equal(manifest.kind,'grid-video-reconstruction');
  assert.equal(manifest.missing,396);
  assert.equal(manifest.frames[1].top,394);
  assert.equal(manifest.union[0].cropSha256,sha('f'));
  const parsed=parseGridReconstructionManifest(JSON.parse(JSON.stringify(manifest)));
  assert.deepEqual(parsed,manifest);
});
test('manifest rejects malformed hashes, duplicate union ids and invalid settings',()=>{
  assert.throws(()=>createGridReconstructionManifest({...base(),input:{...base().input,sha256:'bad'}}),/input/);
  assert.throws(()=>createGridReconstructionManifest({...base(),settings:{...base().settings,stepSeconds:0}}),/settings/);
  assert.throws(()=>createGridReconstructionManifest({...base(),settings:{...base().settings,xs:[1,2]}}),/settings/);
  assert.throws(()=>createGridReconstructionManifest({...base(),settings:{...base().settings,rowOriginY:NaN}}),/settings/);
  assert.throws(()=>createGridReconstructionManifest({...base(),union:[base().union[0],base().union[0]]}),/Duplicate/);
  assert.throws(()=>createGridReconstructionManifest({...base(),frames:[{...base().frames[0],frameSha256:'x'}]}),/frames/);
  assert.throws(()=>parseGridReconstructionManifest({...createGridReconstructionManifest(base()),missing:5}),/missing/);
});
