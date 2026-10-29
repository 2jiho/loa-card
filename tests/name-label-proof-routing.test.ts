import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNameLabelProofRoute,parseSelectedNameLabels,nameLabelProofVariant} from '../dev/name-label-proof-routing';
import {parseNameLabelProofData,NAME_LABEL_VARIANTS} from '../dev/name-label-proof-core';
import {NAME_LABEL_CONTRAST_VARIANTS} from '../dev/name-label-contrast';
import {NAME_LABEL_COLOR_VARIANTS} from '../dev/name-label-color';
const sha='a'.repeat(64),file=`failure-name-label-control-${sha}.json`;
const legacy=()=>({version:1,sourceDigest:sha,runReferences:[{sha256:sha,provider:'canvas-control'}],
  inputs:[{key:'control',provider:'canvas-control',processingFrame:97,slot:3,image:'data:image/png;base64,AAAA',pngSha256:sha,rgbaSha256:sha,width:128,height:36}]});
const normal=()=>({version:1,sourceDigest:sha,
  runReferences:[{sha256:sha,provider:'normal-acquisition',sourceDigest:sha}],
  inputs:[{...legacy().inputs[0],provider:'normal-acquisition',runSha256:sha,source:{sessionId:'session',observationId:'obs1',
    sourceFrameId:null,acquisitionFrameId:12,processingFrame:97,captureOrder:12,captureTime:1.3,phase:'input',slot:3}}]});

test('default name label route preserves the legacy pointer and frozen six-recipe sequence',()=>{
  const route=parseNameLabelProofRoute('');
  assert.equal(route.manifestPath,'/work/paired-name-inputs.json');assert.equal(route.expectedManifestSha256,null);
  assert.equal(route.family,'legacy');assert.deepEqual(route.variants,NAME_LABEL_VARIANTS);
  assert.ok(Object.isFrozen(route));assert.ok(Object.isFrozen(route.variants));
});

test('contrast route accepts only a fixed five-recipe first-line family and exact local manifest hash',()=>{
  const route=parseNameLabelProofRoute(`?manifest=${file}&recipes=contrast-first-line`);
  assert.equal(route.manifestPath,`/work/${file}`);assert.equal(route.expectedManifestSha256,sha);
  assert.deepEqual(route.variants,['raw-first','gray-first',...NAME_LABEL_CONTRAST_VARIANTS]);
  const text=JSON.stringify(legacy());assert.deepEqual(parseSelectedNameLabels(route,text,sha),legacy());
  assert.throws(()=>parseSelectedNameLabels(route,text,'b'.repeat(64)),/SHA/);
  assert.throws(()=>parseSelectedNameLabels(route,text,'unknown'),/SHA/);
});

test('routing rejects URL/traversal/duplicate/unknown options before any source is requested',()=>{
  for(const search of ['?manifest=https://example.test/data.json','?manifest=../label.json','?manifest=%2e%2e%2flabel.json',
    '?manifest=%252e%252e%252flabel.json','?manifest=mutable.json',`?manifest=${file}&manifest=${file}`,
    '?recipes=contrast-first-line&recipes=contrast-first-line','?recipes=raw','?name=샨디','?threshold=0','?'+ 'x'.repeat(1024)])
    assert.throws(()=>parseNameLabelProofRoute(search));
});

test('color experiment has a fixed six-recipe sequence and cannot select a grade or channel via freeform query',()=>{
  const route=parseNameLabelProofRoute(`?manifest=${file}&recipes=color-first-line`);
  assert.equal(route.family,'color-first-line');assert.ok(Object.isFrozen(route.variants));
  assert.deepEqual(route.variants,['raw-first','gray-first',...NAME_LABEL_COLOR_VARIANTS]);
  assert.throws(()=>parseNameLabelProofRoute('?recipes=color-first-line&grade=4'));
  assert.throws(()=>parseNameLabelProofRoute('?recipes=color-first-line&channel=B'));
});

test('normal-acquisition label preserves the actual complete tuple and exact parent run without promoting null source ID',()=>{
  const input=normal(),parsed=parseNameLabelProofData(JSON.stringify(input));
  assert.deepEqual(parsed,input);assert.equal(parsed.inputs[0].source?.sourceFrameId,null);
  assert.equal(parsed.inputs[0].source?.acquisitionFrameId,12);assert.equal(parsed.inputs[0].processingFrame,97);
  assert.equal(parsed.inputs[0].runSha256,sha);assert.equal(parsed.inputs[0].provider,'normal-acquisition');
  assert.deepEqual(parseNameLabelProofData(JSON.stringify(legacy())),legacy());
});

test('normal labels cannot borrow another run/source/frame/slot or invent provenance for a legacy provider',()=>{
  for(const mutate of [
    (d:ReturnType<typeof normal>)=>{d.inputs[0].runSha256='b'.repeat(64);},
    (d:ReturnType<typeof normal>)=>{d.inputs[0].source.slot=4;},
    (d:ReturnType<typeof normal>)=>{d.inputs[0].source.processingFrame=98;},
    (d:ReturnType<typeof normal>)=>{d.inputs[0].source.captureTime=NaN;},
    (d:ReturnType<typeof normal>)=>{d.inputs[0].source.phase='invented';},
    (d:ReturnType<typeof normal>)=>{d.runReferences[0].provider='native-yuv';},
    (d:ReturnType<typeof normal>)=>{d.runReferences[0].sourceDigest='b'.repeat(64);},
  ]){const d=normal();mutate(d);assert.throws(()=>parseNameLabelProofData(JSON.stringify(d)));}
  const noSource=normal();Reflect.deleteProperty(noSource.inputs[0],'source');assert.throws(()=>parseNameLabelProofData(JSON.stringify(noSource)));
  const noProducer=normal();Reflect.deleteProperty(noProducer.runReferences[0],'sourceDigest');assert.throws(()=>parseNameLabelProofData(JSON.stringify(noProducer)));
  const spoof=legacy();Object.assign(spoof.inputs[0],{source:normal().inputs[0].source,runSha256:sha});
  assert.throws(()=>parseNameLabelProofData(JSON.stringify(spoof)),/Legacy/);
});

test('recipe selection does not mutate the original or depend on names, candidates or catalog state',()=>{
  const rgba=new Uint8ClampedArray(128*36*4);for(let i=0;i<rgba.length;i+=4)rgba.set([230,232,234,255],i);
  const original=rgba.slice();
  for(const variant of [...parseNameLabelProofRoute('?recipes=contrast-first-line').variants,...parseNameLabelProofRoute('?recipes=color-first-line').variants]){
    const result=nameLabelProofVariant(rgba,variant);assert.equal(result.width,128);assert.equal(result.height,18);
    assert.notEqual(result.data.buffer,rgba.buffer);assert.deepEqual(rgba,original);
  }
});
