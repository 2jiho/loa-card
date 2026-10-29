import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseCardCropProofRoute,parseSelectedCardCropProof} from '../dev/card-crop-proof-routing';

const digest='a'.repeat(64);
const basename=`failure-card-crop-video4-baseline-obs3730-${digest}.json`;
const selected=`?manifest=${basename}&comparison=portrait-registration`;
test('contrast comparison enables only the contrast fallback in its second mode',()=>{
 const route=parseCardCropProofRoute(`?manifest=${basename}&comparison=name-contrast`);
 assert.equal(route.modes[0].contrastNameFallback,undefined);
 assert.deepEqual(route.modes[1],{id:'contrast-first-line-opt-in',portraitRefinement:false,grayNameFallback:false,contrastNameFallback:true});
});

test('default crop routing preserves the legacy pointer and baseline/gray modes with explicit resample',()=>{
  const route=parseCardCropProofRoute('');
  assert.equal(route.manifestPath,'/work/card-crop-inputs.json');assert.equal(route.expectedManifestSha256,null);
  assert.equal(route.comparison,'baseline-gray');
  assert.deepEqual(route.modes,[{id:'baseline',portraitRefinement:false,grayNameFallback:false},
    {id:'gray-first-line-opt-in',portraitRefinement:false,grayNameFallback:true}]);
  assert.deepEqual(route.nameConfiguration,{version:1,rawResultPolicy:'resample'});
});

test('immutable failure manifest selection compares portrait OFF/ON alone without candidate or threshold options',()=>{
  const route=parseCardCropProofRoute(selected);
  assert.equal(route.manifestPath,`/work/${basename}`);assert.equal(route.expectedManifestSha256,digest);
  assert.deepEqual(route.modes,[{id:'baseline',portraitRefinement:false,grayNameFallback:false},
    {id:'fractional-registration-opt-in',portraitRefinement:true,grayNameFallback:false}]);
  assert.equal(route.nameConfiguration.rawResultPolicy,'resample');
  assert.ok(Object.isFrozen(route)&&Object.isFrozen(route.modes)&&Object.isFrozen(route.nameConfiguration));
  for(const mode of route.modes)assert.ok(Object.isFrozen(mode));
  assert.throws(()=>{(route.modes as unknown as unknown[]).push({});},TypeError);
});

test('crop routing rejects URL/path injection, mutable pointer override, duplicates, unsupported policies and oversized queries',()=>{
  for(const query of [
    '?manifest=https://example.invalid/'+basename,'?manifest=//example.invalid/'+basename,
    '?manifest=/work/'+basename,'?manifest=../'+basename,'?manifest=%2e%2e%2f'+basename,
    '?manifest=%252e%252e%252f'+basename,'?manifest=card-crop-inputs.json',
    '?manifest='+basename+'&manifest='+basename,'?comparison=portrait-registration&comparison=baseline-gray',
    '?comparison=fractional','?fractional=1','?names=continue','?threshold=.8','?candidate=3200004',
    '?manifest='+basename.replace(digest,digest.toUpperCase()),'?'+ 'x'.repeat(1024),
  ])assert.throws(()=>parseCardCropProofRoute(query),query);
});

// Header-only synthetic metadata fixture: no pixels are reconstructed and no
// model/browser is involved. The browser proof still must decode and verify RGBA.
function manifest(){
  const png=new Uint8Array(33),view=new DataView(png.buffer);
  png.set([137,80,78,71,13,10,26,10]);png.set([73,72,68,82],12);view.setUint32(8,13);
  view.setUint32(16,140);view.setUint32(20,210);
  return {version:1,sourceDigest:digest,runReferences:[{id:'parent',sha256:digest,sourceDigest:digest,runFile:'work/opaque-run.json'}],
    inputs:[{key:'opaque-observation',runReferenceId:'parent',
      source:{sessionId:'original-session',observationId:'3730',sourceFrameId:null,acquisitionFrameId:94,
        processingFrame:94,captureOrder:826,captureTime:3.1,phase:'input',slot:9},
      capture:{stable:false,borderAlignment:1,intact:true,complete:true,provenance:'recorded'},
      width:140,height:210,image:`data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      pngSha256:digest,rgbaSha256:'b'.repeat(64)}]};
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function routeFor(text:string){return parseCardCropProofRoute(`?manifest=failure-card-crop-synthetic-${sha(text)}.json&comparison=portrait-registration`);}

test('selected immutable bytes use the existing strict schema and preserve the exact tuple, stable=false and declared hashes',()=>{
  const value=manifest(),text=JSON.stringify(value),route=routeFor(text);
  const parsed=parseSelectedCardCropProof(route,text,sha(text));
  assert.deepEqual(parsed,value);assert.equal(parsed.inputs[0].capture.stable,false);
  assert.equal(parsed.inputs[0].source.sourceFrameId,null);assert.equal(Object.hasOwn(parsed.inputs[0],'candidate'),false);
  assert.equal(parsed.inputs[0].rgbaSha256,'b'.repeat(64),'producer RGBA declaration is preserved, not claimed browser verification');
  assert.throws(()=>parseSelectedCardCropProof(route,text+'\n',sha(text+'\n')),/SHA-256 mismatch/);
  assert.throws(()=>parseSelectedCardCropProof(route,text,'invalid'),/SHA-256 mismatch/);
});

test('matching the selected manifest hash cannot bypass strict source binding or inject recognizer options',()=>{
  for(const mutate of [
    (value:ReturnType<typeof manifest>)=>{value.inputs[0].runReferenceId='later-parent';},
    (value:ReturnType<typeof manifest>)=>{Object.assign(value.inputs[0],{expected:{id:'3200004'},allowPortraitRefinement:true});},
    (value:ReturnType<typeof manifest>)=>{value.runReferences[0].sourceDigest='c'.repeat(64);},
  ]){
    const value=manifest();mutate(value);const text=JSON.stringify(value);
    assert.throws(()=>parseSelectedCardCropProof(routeFor(text),text,sha(text)));
  }
});
