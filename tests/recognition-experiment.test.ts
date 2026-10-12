import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMaskedMatcher,rarityHint} from '../dev/recognition-experiment/masked-matcher.ts';
import {alignCardBorders,visibleIdentity} from '../dev/recognition-experiment/geometry.ts';
import {consensus} from '../src/features/card-scanner/consensus.ts';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
import {identityObservation} from '../dev/recognition-experiment/identity-observation.ts';
import {CaptureObservations} from '../src/features/card-scanner/capture-quality.ts';

function fixture() {
  let seed=19;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
  const gray=Uint8Array.from({length:48*64},random),other=Uint8Array.from({length:48*64},random);
  const indices=Array.from({length:10*38},(_,i)=>(18+Math.floor(i/38))*48+5+i%38);
  const cards=[{id:'a',name:'A',rarity:1},{id:'b',name:'B',rarity:4}];
  const atlas={width:48,height:64,indices,cards:{a:Buffer.from(gray).toString('base64'),b:Buffer.from(other).toString('base64')}};
  const pixels=Uint8Array.from({length:gray.length*4},(_,i)=>i%4===3?255:gray[Math.floor(i/4)]);
  return {gray,pixels,cards,atlas};
}

test('masked refinement ignores all pixels outside its fixed guarded artwork region, including banner/font and counters',()=>{
  const {pixels,cards,atlas}=fixture(),match=createMaskedMatcher(cards,atlas);
  assert.equal(match({pixels,width:48,height:64})?.card.id,'a');
  const changed=pixels.slice();
  for(let y=32;y<64;y++)for(let x=0;x<48;x++)for(let c=0;c<3;c++)changed[(y*48+x)*4+c]=(x+y+c)*17%256;
  assert.equal(match({pixels:changed,width:48,height:64})?.card.id,'a');
  const tied=createMaskedMatcher(cards,{...atlas,cards:{...atlas.cards,b:atlas.cards.a}});
  assert.equal(tied({pixels,width:48,height:64}),null);
  assert.equal(match({pixels,width:48,height:64},{id:'b',ocrConfidence:100,score:1,gap:1}),null);
});

test('a false rarity hint cannot remove the correct identity or its shared-artwork competitor',()=>{
  const {pixels,cards,atlas}=fixture();
  for(let y=5;y<14;y++)for(let x=3;x<45;x++)pixels.set([250,160,10,255],(y*48+x)*4);
  const input={pixels,width:48,height:64};assert.equal(rarityHint(input),4);
  assert.equal(createMaskedMatcher(cards,atlas)(input)?.card.id,'a');
  assert.equal(createMaskedMatcher(cards,{...atlas,cards:{...atlas.cards,b:atlas.cards.a}})(input),null);
});

test('blank, random backgrounds and one matching half do not become accepted identities',()=>{
  const {pixels,cards,atlas}=fixture(),match=createMaskedMatcher(cards,atlas);
  assert.equal(match({pixels:new Uint8Array(pixels.length).fill(90),width:48,height:64}),null);
  let seed=231;
  for(let sample=0;sample<50;sample++) {
    const random=Uint8Array.from({length:pixels.length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
    assert.equal(match({pixels:random,width:48,height:64}),null);
  }
  for(let y=23;y<29;y++)pixels.fill(90,y*48*4,(y+1)*48*4);
  assert.equal(match({pixels,width:48,height:64}),null);
});

test('partial cards require a continuous upper perimeter and cannot borrow lower-field values',()=>{
  const width=160,height=230,pixels=new Uint8Array(width*height*4),box={x:10,y:10,width:140,height:210};
  const paint=(x:number,y:number)=>pixels.set([150,150,150,255],(y*width+x)*4);
  for(let y=10;y<104;y++){paint(10,y);paint(148,y);}for(let x=10;x<150;x++)paint(x,12);
  assert.equal(visibleIdentity(pixels,width,height,box,1),true);
  pixels.fill(0,12*width*4,13*width*4);
  assert.equal(visibleIdentity(pixels,width,height,box,1),false);
  const identity:ScannedCard={id:'a',name:'A',confidence:.99,awakening:null,extraCopies:null,review:['각성 확인','추가 장수 확인'],image:'partial',time:1,observations:1,captureOrder:1,countReliable:false};
  const partial=consensus([identity]);assert.equal(partial.extraCopies,null);assert.equal(partial.awakening,null);
  const later={...identity,awakening:2,extraCopies:12,review:[],countReliable:true,captureOrder:2};
  const complete=consensus([identity,later]);assert.equal(complete.awakening,2);assert.equal(complete.extraCopies,12);assert.deepEqual(complete.review,[]);
  const latePartial=consensus([later,{...identity,captureOrder:3}]);assert.equal(latePartial.extraCopies,12);assert.equal(latePartial.awakening,2);
});

test('tooltip animation cannot requeue identity-only work; full-card observations remain independent',()=>{
  const a=new Uint8Array(3240).fill(80),b=a.slice();
  b.fill(190,864,2592);b.fill(140,2592+8*12*3);
  assert.deepEqual(identityObservation(a),identityObservation(b));
  const groups=new CaptureObservations();
  assert.equal(groups.offer(identityObservation(a),10,5,true),'new');
  assert.equal(groups.offer(identityObservation(b),10,5,true),'duplicate');
  assert.equal(groups.offer(a,0,5,true),'new');
  b.fill(140,0,864);assert.equal(groups.offer(identityObservation(b),10,5,true),'new');
  assert.equal(a[1000],80);
});

test('geometry refinement never stretches an intact card, flat crop or isolated tooltip edge',()=>{
  const width=200,height=250,pixels=new Uint8Array(width*height*4).fill(20),box={x:20,y:20,width:140,height:210};
  const paint=(x:number,y:number)=>pixels.set([160,160,160,255],(y*width+x)*4);
  for(let y=20;y<230;y++){paint(20,y);paint(158,y);}for(let x=20;x<160;x++){paint(x,22);paint(x,227);}
  assert.deepEqual(alignCardBorders(pixels,width,height,box).content,box);
  pixels.fill(20);assert.deepEqual(alignCardBorders(pixels,width,height,box).content,box);
  for(let y=20;y<230;y++)paint(18,y);
  const isolated=alignCardBorders(pixels,width,height,box);
  assert.equal(isolated.intact,false);assert.deepEqual(isolated.content,box);
});

test('malformed masks are rejected before sampling outside the crop',()=>{
  const {cards,atlas}=fixture();
  assert.throws(()=>createMaskedMatcher(cards,{...atlas,indices:[...atlas.indices,atlas.indices[0]]}));
  assert.throws(()=>createMaskedMatcher(cards,{...atlas,indices:[...atlas.indices.slice(1),48*20]}));
  assert.throws(()=>createMaskedMatcher(cards,{...atlas,cards:{...atlas.cards,a:'AA=='}}));
});

test('projection bounds preserve exhaustive winner, competitor margin and abstention on shifted noisy crops',()=>{
  const {pixels,cards,atlas}=fixture(),fast=createMaskedMatcher(cards,atlas),full=createMaskedMatcher(cards,atlas,true);
  for(const dx of [-1,0,1])for(const dy of [-1,0,1])for(const noise of [0,10,60]) {
    const shifted=pixels.slice();
    for(let y=1;y<63;y++)for(let x=1;x<47;x++)for(let c=0;c<3;c++)
      shifted[(y*48+x)*4+c]=Math.max(0,Math.min(255,pixels[((y+dy)*48+x+dx)*4+c]+((x+y)%3-1)*noise));
    const input={pixels:shifted,width:48,height:64};assert.deepEqual(fast(input),full(input));
  }
});
