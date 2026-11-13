import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPortraitMatcher,screenExtraReferences} from '../src/features/card-scanner/recognition/portrait-matcher.ts';
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const {cards}=json('../public/scanner/cards.json');
const region=(gray:Uint8Array)=>{const bytes=new Uint8Array(200);for(let r=0;r<10;r++)for(let c=0;c<20;c++)bytes[r*20+c]=gray[(9+r)*24+2+c];return Buffer.from(bytes).toString('base64');};

test('extra references file becomes one record per list position and skips invalid entries',()=>{
  assert.deepEqual(screenExtraReferences({cards:{a:['x','y'],b:['z'],c:'bad',d:[1,'w']}}),[{a:'x',b:'z',d:'w'},{a:'y'}]);
  assert.deepEqual(screenExtraReferences(null),[]);
});

test('an extra reference adds a card the other references cannot name, and only that card',()=>{
  const sample=json('./fixtures/portrait-corroboration.json');
  const gray=Uint8Array.from(sample.gray as number[]);
  // The atlas without this card: other identities stay as competitors, the card itself is unnamed.
  const atlas={...json('../public/scanner/artwork-details.json')};delete atlas[sample.id];
  const without=createPortraitMatcher(cards,atlas,{});
  assert.notEqual(without(gray)?.card.id,sample.id);
  const withExtra=createPortraitMatcher(cards,atlas,{},{extra:[{[sample.id]:region(gray)}]});
  assert.equal(withExtra(gray)?.card.id,sample.id);
});

test('shipped extra references name catalog cards and use the 20x10 region',()=>{
  const file=json('../public/scanner/screen-artwork-extra.json');
  const ids=new Set(cards.map((card:{id:string})=>card.id));
  for(const [id,list] of Object.entries(file.cards as Record<string,string[]>)){
    assert.ok(ids.has(id),id);
    for(const value of list)assert.equal(Buffer.from(value,'base64').length,200);
  }
});
