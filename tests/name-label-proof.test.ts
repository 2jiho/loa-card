import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNameLabelProofData,nameLabelVariant,NAME_LABEL_PROOF_LIMITS,NAME_LABEL_VARIANTS,assertNameLabelPngHeader,decodeNameLabelBitmap} from '../dev/name-label-proof-core';
const sha='a'.repeat(64);
function manifest(){return {version:1,sourceDigest:sha,runReferences:[{sha256:sha,provider:'canvas-control',runFile:'fixtures/local/example.json'}],
  inputs:[{key:'control.97.32',provider:'canvas-control',processingFrame:97,slot:32,image:'data:image/png;base64,AAAA',pngSha256:sha,rgbaSha256:sha,width:128,height:36}]};}
test('name-label manifest preserves ordered identity and rejects unbounded or ambiguous inputs',()=>{
  const input=manifest();assert.deepEqual(parseNameLabelProofData(JSON.stringify(input)),input);
  const both=manifest();both.inputs.push({...both.inputs[0],key:'native.97.32',provider:'native-yuv'});
  both.runReferences.push({...both.runReferences[0],provider:'native-yuv'});
  assert.deepEqual(parseNameLabelProofData(JSON.stringify(both)).inputs.map(item=>item.key),['control.97.32','native.97.32']);
  for(const mutate of [
    (x:ReturnType<typeof manifest>)=>{x.inputs.push({...x.inputs[0]});},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].slot=40;},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].processingFrame=0;},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].width=256;},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].rgbaSha256='unknown';},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].image='https://example.invalid/input.png';},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].image='data:image/png;base64,AA=A';},
    (x:ReturnType<typeof manifest>)=>{x.inputs[0].image='data:image/png;base64,'+'AAAA'.repeat(32769);},
    (x:ReturnType<typeof manifest>)=>{x.inputs=Array.from({length:9},(_,i)=>({...x.inputs[0],key:String(i)}));},
    (x:ReturnType<typeof manifest>)=>{x.runReferences[0].sha256='bad';},
  ]){const invalid=manifest();mutate(invalid);assert.throws(()=>parseNameLabelProofData(JSON.stringify(invalid)));}
  assert.throws(()=>parseNameLabelProofData(JSON.stringify({...manifest(),unexpected:'unpreserved metadata'})));
  assert.throws(()=>parseNameLabelProofData(' '.repeat(NAME_LABEL_PROOF_LIMITS.fileBytes+1)));
});
test('raw variants slice exact rows without mutating the initial label',()=>{
  const source=new Uint8ClampedArray(128*36*4);
  for(let y=0;y<36;y++)for(let x=0;x<128;x++)source.set([y,x,255-y,30+y],(y*128+x)*4);
  const original=source.slice();
  for(const variant of NAME_LABEL_VARIANTS.filter(value=>value.startsWith('raw-'))){
    const pixels=nameLabelVariant(source,variant),top=variant==='raw-second'?18:0,height=variant==='raw-full'?36:18;
    assert.equal(pixels.height,height);assert.equal(pixels.width,128);
    assert.deepEqual(pixels.data,original.slice(top*128*4,(top+height)*128*4));
    pixels.data.fill(0);assert.deepEqual(source,original);
  }
  assert.throws(()=>nameLabelVariant(new Uint8ClampedArray(1),'raw-full'));
  assert.throws(()=>nameLabelVariant(source,'mask' as 'raw-first'));
});
test('PNG dimensions are guarded before browser decoding, including offset byte views',()=>{
  const backing=new Uint8Array(50),bytes=backing.subarray(3,36),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);
  view.setUint32(8,13);view.setUint32(16,128);view.setUint32(20,36);
  assert.doesNotThrow(()=>assertNameLabelPngHeader(bytes));
  view.setUint32(16,0x7fffffff);assert.throws(()=>assertNameLabelPngHeader(bytes));
  view.setUint32(16,128);view.setUint32(20,0x7fffffff);assert.throws(()=>assertNameLabelPngHeader(bytes));
  assert.throws(()=>assertNameLabelPngHeader(bytes.subarray(0,32)));
});
test('gray variants use explicit luminance and retain alpha and both line boundaries',()=>{
  const source=new Uint8ClampedArray(128*36*4);
  for(let i=0;i<source.length;i+=4)source.set([20,180,220,(i/4)%256],i);
  source.set([255,0,0,37],18*128*4);
  const original=source.slice(),first=nameLabelVariant(source,'gray-first'),second=nameLabelVariant(source,'gray-second'),full=nameLabelVariant(source,'gray-full');
  assert.deepEqual([...first.data.slice(0,4)],[137,137,137,0]);
  assert.deepEqual([...second.data.slice(0,4)],[76,76,76,37]);
  assert.deepEqual(full.data.slice(0,18*128*4),first.data);
  assert.deepEqual(full.data.slice(18*128*4),second.data);
  for(let i=3;i<full.data.length;i+=4)assert.equal(full.data[i],source[i]);
  assert.deepEqual(source,original);
});
test('cancelled or timed-out native PNG decoding closes late results without delaying its caller',async()=>{
  for(const cancel of [true,false]){
    const controller=new AbortController();let complete!:(bitmap:ImageBitmap)=>void,closes=0;
    const operation=decodeNameLabelBitmap(new Blob(),controller.signal,{deadlineMs:5,decode:()=>new Promise(resolve=>{complete=resolve;})});
    if(cancel)controller.abort(Error('stopped'));
    await assert.rejects(operation,cancel?/stopped/:/deadline/);
    complete({close(){closes++;}} as ImageBitmap);await Promise.resolve();
    assert.equal(closes,1);
  }
  const controller=new AbortController();controller.abort();let started=0;
  await assert.rejects(decodeNameLabelBitmap(new Blob(),controller.signal,{decode:async()=>{started++;return {} as ImageBitmap;}}));
  assert.equal(started,0);
});
test('successful PNG decode ownership transfers once and synchronous failures reject cleanly',async()=>{
  let closes=0;const bitmap={close(){closes++;}} as ImageBitmap,signal=new AbortController().signal;
  const decoded=await decodeNameLabelBitmap(new Blob(),signal,{decode:async()=>bitmap});
  assert.equal(decoded,bitmap);assert.equal(closes,0);decoded.close();assert.equal(closes,1);
  await assert.rejects(decodeNameLabelBitmap(new Blob(),signal,{decode:()=>{throw Error('decode failed');}}),/decode failed/);
  await assert.rejects(decodeNameLabelBitmap(new Blob(),signal,{deadlineMs:5001}),/deadline/);
});
