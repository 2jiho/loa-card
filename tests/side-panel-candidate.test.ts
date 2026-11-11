import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alignCardBorders} from '../src/features/card-scanner/acquisition/card-borders';
import {sidePanelCandidate} from '../src/features/card-scanner/acquisition/overlay-quality';

const width=140,height=210;
function textured(){
  const rgba=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    rgba.set([(x*11+y*17)%200+32,(x*7+y*13)%200+32,(x*5+y*19)%200+32,255],i);
  }
  return rgba;
}
function band(rgba:Uint8Array,side:'left'|'right'){
  const left=side==='left'?0:Math.floor(width*.71),right=side==='left'?Math.ceil(width*.29):width;
  for(let y=0;y<height;y++)for(let x=left;x<right;x++)rgba.set([20,24,27,255],(y*width+x)*4);
}

test('flat side margins over incomplete cards are candidates in either direction, not proven tooltips',()=>{
  for(const side of ['left','right'] as const){
    const rgba=textured();band(rgba,side);
    const value=sidePanelCandidate(rgba,width,height,[.2,.4,.6,.3]);
    assert.equal(value.status,'candidate');assert.equal(value.candidate?.side,side);
    assert.equal(value.canConcludeAbsence,false);
  }
});
test('complete cards, blank panes, noisy cards and non-sampled tooltip shapes do not claim absence',()=>{
  const rgba=textured();band(rgba,'left');
  assert.equal(sidePanelCandidate(rgba,width,height,[1,1,1,1]).status,'unsupported');
  const blank=new Uint8Array(width*height*4);for(let i=0;i<blank.length;i+=4)blank.set([20,24,27,255],i);
  assert.equal(sidePanelCandidate(blank,width,height,[0,0,0,0]).status,'none');
  const none=sidePanelCandidate(textured(),width,height,[.2,.3,.4,.1]);
  assert.equal(none.status,'none');assert.equal(none.canConcludeAbsence,false);
});
test('a dark flat margin can be artwork and is deliberately only a candidate',()=>{
  const darkArt=textured();band(darkArt,'left');
  assert.equal(sidePanelCandidate(darkArt,width,height,[.2,.2,.2,.2]).status,'candidate');
});
test('actual intact border fixtures are not candidates; invalid and costly inputs remain unverified',()=>{
  type Sample={intact:boolean;width:number;height:number;rgba:string;box:{x:number;y:number;width:number;height:number}};
  const samples:Sample[]=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8'));
  for(const sample of samples.filter(item=>item.intact)){
    const source=Uint8Array.from(Buffer.from(sample.rgba,'base64'));
    const aligned=alignCardBorders(source,sample.width,sample.height,sample.box),box=aligned.content;
    const crop=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=((box.y+y)*sample.width+box.x+x)*4;crop.set(source.subarray(i,i+4),(y*width+x)*4);
    }
    assert.equal(sidePanelCandidate(crop,width,height,aligned.borderSides).status,'unsupported');
  }
  const rgba=textured();band(rgba,'left');
  assert.equal(sidePanelCandidate(rgba,width,height,[1,1,1]).status,'invalid');
  assert.equal(sidePanelCandidate(rgba.subarray(0,10),width,height,[0,0,0,0]).status,'invalid');
  assert.equal(sidePanelCandidate(new Uint8Array(1025*105*4),1025,105,[0,0,0,0]).status,'unsupported');
  for(let i=3;i<rgba.length;i+=4)rgba[i]=0;
  assert.equal(sidePanelCandidate(rgba,width,height,[0,0,0,0]).status,'invalid');
});
