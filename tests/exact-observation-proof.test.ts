import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {ExactObservationProofs, compareReplayPixelsOnly, type ExactGeometry} from '../dev/exact-observation-proof';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const geometry:ExactGeometry={width:2,height:2,left:5,top:9,cardX:0,cardY:0,cardWidth:2,cardHeight:2,scale:1};
const source=(i:number):ObservationSource=>({sessionId:'session',frameId:i,observationId:`id-${i}`,captureOrder:i,captureTime:i,phase:'input',slot:0});
const sha=(p:Uint8ClampedArray)=>createHash('sha256').update(p).digest('hex');
test('only the owner can prove full RGBA equality for distinct ordered sources and identical geometry',()=>{
  const proof=new ExactObservationProofs(64,4),pixels=new Uint8ClampedArray(16).fill(55);
  const a=proof.capture(source(1),geometry,pixels)!;
  pixels[0]=44;
  const b=proof.capture(source(2),geometry,new Uint8ClampedArray(16).fill(55))!;
  assert.deepEqual(proof.match(a,b),{earlier:source(1),later:source(2)});
  assert.equal(proof.match(b,a),null);
  assert.equal(proof.match({},b),null);
  assert.equal(new ExactObservationProofs(64,4).match(a,b),null);
  assert.equal(proof.capture(source(1),geometry,pixels),null,'source ID cannot be reassigned');
  const c=proof.capture(source(3),{...geometry,left:6},new Uint8ClampedArray(16).fill(55))!;
  assert.equal(proof.match(a,c),null,'equal pixels at different geometry are insufficient');
  const alpha=new Uint8ClampedArray(16).fill(55);alpha[15]++;
  const d=proof.capture(source(4),geometry,alpha)!;
  assert.equal(proof.match(a,d),null,'alpha is also compared');
  assert.throws(()=>proof.capture(source(5),{...geometry,scale:NaN},alpha));
  assert.throws(()=>proof.capture(source(5),geometry,new Uint8ClampedArray(new SharedArrayBuffer(16))));
});
test('bounded eviction invalidates capabilities and source ID reuse',()=>{
  const p=new ExactObservationProofs(16,1),pixels=new Uint8ClampedArray(16);
  const old=p.capture(source(1),geometry,pixels)!;
  const next=p.capture(source(2),geometry,pixels)!;
  assert.deepEqual(p.usage(),{bytes:16,entries:1});
  assert.equal(p.match(old,next),null);
  assert.equal(p.capture(source(1),geometry,pixels),null);
  assert.equal(p.capture(source(3),{...geometry,width:3},new Uint8ClampedArray(24)),null);
});
test('replay requires both exact bytes, source-bound geometry and matching SHA',async()=>{
  const pixels=new Uint8ClampedArray(16).fill(4);
  const a={source:source(1),geometry,pixels,sha256:sha(pixels)};
  const b={source:source(2),geometry,pixels:pixels.slice(),sha256:sha(pixels)};
  assert.ok(await compareReplayPixelsOnly(a,b));
  assert.equal(await compareReplayPixelsOnly(a,null),null);
  assert.equal(await compareReplayPixelsOnly(a,{...b,sha256:'0'.repeat(64)}),null);
  const altered=pixels.slice();altered[1]++;
  assert.equal(await compareReplayPixelsOnly(a,{...b,pixels:altered}),null);
  assert.equal(await compareReplayPixelsOnly(a,{...b,geometry:{...geometry,top:10}}),null);
  const forged={...b,source:{...source(88),observationId:'unrelated-id'}};
  assert.equal((await compareReplayPixelsOnly(a,forged))?.kind,'pixels-equal-only',
    'hashes cannot authenticate claimed source; a separately verified manifest is required');
});
test('optional local real crop copied in memory: byte equality and tamper checks',async t=>{
  const path=process.env.LOACARD_REAL_RGBA;
  if(!path)return t.skip('set LOACARD_REAL_RGBA to a private 140x210 RGBA crop');
  const pixels=new Uint8ClampedArray(await readFile(path));
  assert.equal(pixels.length,140*210*4);
  const g={...geometry,width:140,height:210,cardWidth:140,cardHeight:210};
  const a={source:source(1),geometry:g,pixels,sha256:sha(pixels)};
  const b={source:source(2),geometry:g,pixels:pixels.slice(),sha256:sha(pixels)};
  assert.ok(await compareReplayPixelsOnly(a,b));
  b.pixels[500]^=1;
  assert.equal(await compareReplayPixelsOnly(a,b),null);
});
