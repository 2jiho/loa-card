import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {LiveScrollPreview} from '../src/features/card-scanner/live-scroll-preview';
import type {Layout} from '../src/features/card-scanner/detector';
const fixture=JSON.parse(readFileSync('tests/fixtures/scrollbar-samples.json','utf8'))[0];
const strip=inflateSync(Buffer.from(fixture.rgbaZlib,'base64'));
const layout={header:{x:0,y:0,width:64,height:8},scrollbar:{x:80,y:0,width:16,height:942}} as Layout;
function setup(){let calls=0;const p=new LiveScrollPreview<number>((source,_box,_w)=>{calls++;const pixels=Uint8Array.from(strip);pixels.fill(source,0,16*16*4);if(source>=100)pixels.fill(source,pixels.length-16*16*4);return pixels;});return {p,calls:()=>calls};}
test('preview reads only tiny strips without waiting for card jobs, and limits polling',()=>{
 const {p,calls}=setup();p.bind(10,100,1000,layout,0);
 assert.ok(p.read(10,100,1000,100));assert.equal(calls(),2);
 assert.equal(p.read(10,100,1000,125),undefined);assert.equal(calls(),2);
 assert.ok(p.read(10,100,1000,150));assert.equal(calls(),3);
});

test('fresh 60 fps frames can update the guarded strip every two frames',()=>{
 const {p,calls}=setup();p.bind(10,100,1000,layout,0);
 let reads=0;
 for(let frame=0;frame<120;frame++)if(p.read(10,100,1000,frame*1000/60)!==undefined)reads++;
 assert.equal(reads,60);assert.equal(calls(),61);
});
test('moved or resized windows hide immediately, transient cover can recover at the next read',()=>{
 const {p}=setup();p.bind(10,100,1000,layout,0);
 assert.equal(p.read(100,100,1000,100),null);
 assert.ok(p.read(10,100,1000,200),'fresh matching guard pixels restore a transiently covered window');
 p.bind(10,100,1000,layout,200);assert.equal(p.read(10,101,1000,300),null);
 p.bind(10,100,1000,layout,300);assert.ok(p.read(10,100,1000,1400));
 p.bind(10,100,1000,null,1400);assert.ok(p.read(10,100,1000,1500));
});

test('slow detection does not expire healthy geometry and late binds cannot replace newer coordinates',()=>{
 const {p}=setup();p.bind(10,100,1000,layout,0);
 assert.ok(p.read(10,100,1000,1800),'first detector result may already be over one second old');
 for(let now=1850;now<=10000;now+=50)assert.ok(p.read(10,100,1000,now));
 p.bind(10,100,1000,null,9000);
 p.bind(100,100,1000,{...layout,scrollbar:{...layout.scrollbar,x:70}},100);
 assert.ok(p.read(10,100,1000,10050),'old mismatching geometry must not win');
 assert.equal(p.read(100,100,1000,10100),null);
 assert.equal(p.read(100,100,1000,12200),null);
 assert.equal(p.read(10,100,1000,12250),null,'prolonged mismatch requires fresh detection');
});

test('same-coordinate detector captures do not poison a healthy arrow guard with a cursor',()=>{
 const {p}=setup();p.bind(10,100,1000,layout,0);assert.ok(p.read(10,100,1000,100));
 p.bind(200,100,1000,layout,200);
 assert.ok(p.read(10,100,1000,250));
 p.clear();p.bind(200,100,1000,layout,0);assert.ok(p.read(200,100,1000,50));
});

test('a bad initial guard expires after sustained mismatch and can be rebound',()=>{
 const {p}=setup();p.bind(200,100,1000,layout,0);
 assert.equal(p.read(10,100,1000,50),null);
 assert.equal(p.read(10,100,1000,2050),null);
 p.bind(10,100,1000,layout,2100);assert.ok(p.read(10,100,1000,2150));
});

test('disabled or hovered endpoint arrows do not hide a thumb while the other textured arrow matches',()=>{
 const p=new LiveScrollPreview<number>(source=>{
   const pixels=Uint8Array.from(strip),part=16*16*4;
   if(source===1)pixels.fill(10,0,part);
   if(source===2)pixels.fill(10,pixels.length-part);
   if(source===3){pixels.fill(10,0,part);pixels.fill(10,pixels.length-part);}
   return pixels;
 });
 p.bind(0,100,1000,layout,0);
 assert.ok(p.read(1,100,1000,50));assert.ok(p.read(2,100,1000,100));
 p.clear();p.bind(0,100,1000,layout,0);
 assert.equal(p.read(3,100,1000,150),null,'simultaneous endpoint changes hide the position');
});

test('verified arrow appearance changes follow a top-to-bottom scroll without retaining both old endpoints',()=>{
 const p=new LiveScrollPreview<number>(source=>{
   const pixels=Uint8Array.from(strip),part=16*16*4;
   // Preserve the arrow's texture while changing its active appearance.
   if(source>=1)for(let i=0;i<part;i++)if(i%4!==3)pixels[i]=Math.min(255,pixels[i]+35);
   if(source>=2)for(let i=pixels.length-part;i<pixels.length;i++)if(i%4!==3)pixels[i]=Math.max(0,pixels[i]-30);
   return pixels;
 });
 p.bind(0,100,1000,layout,0);
 assert.ok(p.read(1,100,1000,50));assert.ok(p.read(2,100,1000,100));
 assert.ok(p.read(0,100,1000,150)===null,'both endpoints changed simultaneously is still uncertain');
});

test('an unchanged flat background cannot substitute for an arrow witness',()=>{
 const p=new LiveScrollPreview<number>(source=>{
   const pixels=Uint8Array.from(strip),part=16*16*4;
   pixels.fill(10,pixels.length-part);
   if(source)pixels.fill(200,0,part);
   return pixels;
 });
 p.bind(0,100,1000,layout,0);
 assert.equal(p.read(1,100,1000,50),null);
});
test('preview read errors stay isolated from recognition and require fresh coordinates',()=>{
 let fail=false;const p=new LiveScrollPreview<number>((_,_box,_w)=>{if(fail)throw Error('source closed');return strip;});
 p.bind(0,100,1000,layout,0);fail=true;
 assert.equal(p.read(0,100,1000,100),null);fail=false;
 assert.equal(p.read(0,100,1000,200),null);
 p.bind(0,100,1000,layout,200);assert.ok(p.read(0,100,1000,300));
 p.clear();assert.equal(p.read(0,100,1000,400),null);
});
