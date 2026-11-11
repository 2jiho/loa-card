import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {loadPortraitCompetitors,validatedPortraitCompetitors} from '../src/features/card-scanner/recognition/portrait-competitors';

const read=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const {cards}=read('../public/scanner/cards.json'),atlas=read('../public/scanner/artwork-details.json');
const screen=read('../public/scanner/screen-artwork-details.json').cards;
const source=read('../public/scanner/portrait-competitors.json');

test('only the pinned client feature can become a competitor; corrupted/mislabeled features fail closed',async()=>{
  const valid=await validatedPortraitCompetitors(source);
  assert.deepEqual(Object.keys(valid),['3201001']);
  const changed=structuredClone(source),raw=Buffer.from(changed.cards['3201001'],'base64');raw[0]^=255;
  changed.cards['3201001']=raw.toString('base64');
  assert.deepEqual(await validatedPortraitCompetitors(changed),{});
  changed.cards={'3200002':source.cards['3201001']};
  assert.deepEqual(await validatedPortraitCompetitors(changed),{});
  assert.deepEqual(await validatedPortraitCompetitors({version:2,kind:source.kind,cards:source.cards}),{});
});

test('optional competitor loading times out on a stalled fetch or body and propagates caller cancellation',async()=>{
  const previous=globalThis.fetch;let received:AbortSignal|undefined;
  try{
    globalThis.fetch=((_input,init)=>{received=init?.signal as AbortSignal;return new Promise(()=>{});}) as typeof fetch;
    assert.deepEqual(await loadPortraitCompetitors('/',undefined,20),{});assert.equal(received?.aborted,true);
    globalThis.fetch=async(_input,init)=>{received=init?.signal as AbortSignal;return {ok:true,json:()=>new Promise(()=>{})} as Response;};
    assert.deepEqual(await loadPortraitCompetitors('/',undefined,20),{});assert.equal(received?.aborted,true);
    const stop=new AbortController(),pending=loadPortraitCompetitors('/',stop.signal,1000);stop.abort(new Error('stop requested'));
    await assert.rejects(pending,/stop requested/);assert.equal(received?.aborted,true);
    globalThis.fetch=async()=>({ok:true,json:async()=>source}) as Response;
    assert.ok((await loadPortraitCompetitors('/',undefined,1000))['3201001']);
  }finally{globalThis.fetch=previous;}
});

test('the client feature participates in ranking but cannot identify its own card',async()=>{
  const competitors=await validatedPortraitCompetitors(source),bytes=Buffer.from(competitors['3201001'],'base64');
  const image=new Uint8Array(768);
  for(let y=0;y<32;y++)for(let x=0;x<24;x++)image[y*24+x]=(x*17+y*13)%256;
  for(let y=0;y<10;y++)for(let x=0;x<20;x++)image[(y+9)*24+x+2]=bytes[y*20+x];
  for(const fractionalRegistration of [false,true]){
    const matcher=createPortraitMatcher(cards,atlas,screen,{competitors,fractionalRegistration});
    assert.equal(matcher(image)?.card.id,undefined,'competitor feature alone cannot identify its owner');
    assert.equal(matcher(image,{id:'3201001',rawText:'찢겨진 발탄',canonicalName:'찢겨진 발탄',complete:true,ocrConfidence:99,score:1,gap:1})?.card.id,undefined);
  }
});

test('adding the bounded competitor cannot lose or change previously accepted regression identities',async()=>{
  const competitors=await validatedPortraitCompetitors(source),fixture=read('./fixtures/screen-portrait-regression.json');
  const before=createPortraitMatcher(cards,atlas,screen),after=createPortraitMatcher(cards,atlas,screen,{competitors});
  let beforeAccepted=0,afterAccepted=0,changed=0,empty=0;
  for(const row of fixture.rows){
    const image=Uint8Array.from(Buffer.from(row.gray,'base64'));
    const old=before(image)?.card.id??null,current=after(image)?.card.id??null;
    if(old!==null){beforeAccepted++;assert.equal(old,row.expected);assert.equal(current,old,`lost previous identity ${row.page}/${row.slot}`);}
    if(current!==null){afterAccepted++;assert.equal(current,row.expected,`wrong identity ${row.page}/${row.slot}`);}
    if(row.expected===null){empty++;assert.equal(current,null);}
    changed+=Number(old!==current);
  }
  assert.equal(fixture.rows.length,400);assert.equal(empty,16);assert.ok(beforeAccepted>=375);
  assert.equal(afterAccepted,beforeAccepted+changed);
});
