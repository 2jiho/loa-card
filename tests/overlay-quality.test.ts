import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasPanelOverlay} from '../src/features/card-scanner/overlay-quality';
import {inspectCapture} from '../src/features/card-scanner/capture-quality';
type Sample={name:string;intact:boolean;width:number;height:number;rgba:string;box:{x:number;y:number;width:number;height:number}};
const samples:Sample[]=JSON.parse(readFileSync('tests/fixtures/border-integrity-samples.json','utf8'));
test('real intact rarity crops survive while a text-bearing panel inside their borders is rejected',()=>{
  for(const sample of samples.filter(s=>s.intact)){
    const source=Buffer.from(sample.rgba,'base64'),b=sample.box,rgba=new Uint8Array(b.width*b.height*4);
    for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){
      const offset=((b.y+y)*sample.width+b.x+x)*4;rgba.set(source.subarray(offset,offset+4),(y*b.width+x)*4);
    }
    assert.equal(hasPanelOverlay(rgba,b.width,b.height),false,sample.name);
    const covered=rgba.slice(),top=Math.round(b.height*.4);
    for(let y=top;y<top+Math.round(b.height*.2);y++)for(let x=0;x<b.width;x++){
      const v=y===top?110:20;covered.set([v,v,v,255],(y*b.width+x)*4);
    }
    // The tooltip contains text; the existing flat-name gate alone cannot see it.
    for(let x=25;x<60;x+=4)for(let y=top+12;y<top+19;y++)covered.set([200,200,200,255],(y*b.width+x)*4);
    assert.equal(hasPanelOverlay(covered,b.width,b.height),true,sample.name);
    assert.match(inspectCapture(covered,b.width,b.height,true,true,true,true).reason,/툴팁/);
    assert.equal(inspectCapture(rgba,b.width,b.height,true,true,true,true).usable,true,sample.name);
  }
});
