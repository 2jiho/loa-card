import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {FrozenViewportHints} from '../src/features/card-scanner/frozen-viewport-hint';
import {LiveScrollPreview} from '../src/features/card-scanner/live-scroll-preview';
import {readScrollGeometry} from '../src/features/card-scanner/scroll-position';
import type {Layout} from '../src/features/card-scanner/detector';

const fixture=JSON.parse(readFileSync('tests/fixtures/scrollbar-samples.json','utf8'))[0];
const pixels=inflateSync(Buffer.from(fixture.rgbaZlib,'base64'));
const layout={scrollbar:{x:80,y:0,width:16,height:942}} as Layout;

test('selection samples the supplied immutable source independently of display polling',()=>{
  const seen:string[]=[];
  const read=(source:string)=>{seen.push(source);return pixels;};
  const selection=new FrozenViewportHints(read),display=new LiveScrollPreview(read);
  selection.bind('bound-frame',100,1000,layout,0);display.bind('bound-frame',100,1000,layout,0);
  display.read('mutable-video',100,1000,100);
  const hint=selection.read('frozen-frame',100,1000,100);
  const geometry=readScrollGeometry(pixels,16,942)!;
  assert.deepEqual(hint,{rowStart:Math.round(geometry.position*51),rowCount:4});
  assert.equal(seen.at(-1),'frozen-frame');
  assert.equal(display.read('mutable-video',100,1000,101),undefined);
  assert.equal(selection.read('newer-frozen-frame',100,1000,140)?.rowCount,4);
});

test('unbound, covered, moved or differently sized frames produce no scheduling hint',()=>{
  const selection=new FrozenViewportHints<number>(source=>{
    const result=Uint8Array.from(pixels);
    if(source===1){result.fill(255,0,16*16*4);result.fill(255,result.length-16*16*4);}
    return result;
  });
  assert.equal(selection.read(0,100,1000,0),undefined);
  selection.bind(0,100,1000,layout,1);
  assert.equal(selection.read(1,100,1000,40),undefined);
  assert.equal(selection.read(0,101,1000,80),undefined);
  selection.bind(0,100,1000,layout,90);
  assert.ok(selection.read(0,100,1000,120));
});

test('a strip read failure stays optional and cannot become a viewport estimate',()=>{
  let fail=false;
  const selection=new FrozenViewportHints(()=>{if(fail)throw Error('closed frame');return pixels;});
  selection.bind(0,100,1000,layout,0);fail=true;
  assert.equal(selection.read(0,100,1000,100),undefined);
  fail=false;
  assert.equal(selection.read(0,100,1000,140),undefined);
  selection.bind(0,100,1000,layout,180);
  assert.ok(selection.read(0,100,1000,200));
});
