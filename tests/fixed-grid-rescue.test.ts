import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFixedGridRescue,confirmFixedGridRescue,duplicateRescueObservationCount,fixedGridCell,rescueFixedRowSlot} from '../src/features/card-scanner/acquisition/fixed-grid-rescue';

const match = {id:'3201013',name:'라제니스를 이끄는 니나브',correlation:.983,margin:.498};
const frame = (frameId:number,captureTime:number,gray:(slot:number)=>ArrayLike<number>|null) => ({frameId,captureTime,grayFor:gray});

test('fixed grid cell maps slots to the scanner journal rows', () => {
  assert.deepEqual(fixedGridCell(0),{x:138,y:392,width:140,height:210});
  assert.deepEqual(fixedGridCell(6),{x:1081,y:392,width:140,height:210});
  assert.deepEqual(fixedGridCell(39),{x:1553,y:1121,width:140,height:210});
  assert.equal(fixedGridCell(-1),null);
  assert.equal(fixedGridCell(40),null);
});

test('canonical-row evidence is accepted as an independent rescue attempt', () => {
  const result=rescueFixedRowSlot({slot:6,captureTime:2.4,source:'canonical-row',
    frames:[frame(73,2.4,()=>new Float32Array(768))],match:()=>match});
  assert.equal(result.evidence[0]?.source,'canonical-row');
});

test('confirmation requires two distinct frames, one ID, standard gates and a new card', () => {
  const evidence=(frameId:number,id='3201013')=>({...match,id,source:'canonical-row' as const,frameId,captureTime:2.4,slot:6});
  const record=(order:number,frameId:number,id='3201013')=>({version:1 as const,group:1,order,slot:6,captureTime:2.4,
    pending:false,frameCount:1,unavailable:false,evidence:[evidence(frameId,id)]});
  const confirmed=confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71),record(2,73)],existingIds:new Set()});
  assert.equal(confirmed?.id,'3201013');
  assert.equal(confirmed?.evidence.length,2);
  assert.equal(confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71)],existingIds:new Set()}),null);
  assert.equal(confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71),record(2,71)],existingIds:new Set()}),null);
  assert.equal(confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71),record(2,73,'3200012')],existingIds:new Set()}),null);
  assert.equal(confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71),record(2,73)],existingIds:new Set(['3201013'])}),null);
  assert.equal(confirmFixedGridRescue({slot:6,captureTime:2.4,records:[record(1,71),record(2,73)],existingIds:new Set(),minCorrelation:1}),null);
});

test('rescue re-runs only the requested slot within the bounded time window', () => {
  const seen:number[]=[];
  const result=rescueFixedRowSlot({slot:6,captureTime:2.4,source:'retained-frame',
    frames:[frame(70,2.35,slot=>{seen.push(slot);return new Float32Array(768).fill(.5);}),
      frame(71,3.2,()=>{throw Error('outside window');})],
    match:gray=>{assert.equal(gray.length,768);return match;}});
  assert.deepEqual(seen,[6]);
  assert.equal(result.frameCount,1);
  assert.equal(result.unavailable,false);
  assert.deepEqual(result.evidence,[{...match,source:'retained-frame',frameId:70,captureTime:2.35,slot:6}]);
});

test('rescue records no identity when the matcher rejects or frames are unavailable', () => {
  const rejected=rescueFixedRowSlot({slot:3,captureTime:1,source:'observation-feature',
    frames:[frame(1,1,()=>new Float32Array(768))],match:()=>null});
  assert.equal(rejected.frameCount,1);
  assert.deepEqual(rejected.evidence,[]);
  const evicted=rescueFixedRowSlot({slot:3,captureTime:1,source:'retained-frame',
    frames:[frame(1,3,()=>new Float32Array(768))],match:()=>match});
  assert.equal(evicted.unavailable,true);
  assert.deepEqual(evicted.evidence,[]);
  const malformed=rescueFixedRowSlot({slot:3,captureTime:1,source:'retained-frame',
    frames:[frame(1,1,()=>new Float32Array(768))],match:()=>({id:'',name:'x',correlation:1,margin:1})});
  assert.deepEqual(malformed.evidence,[]);
});

test('appending evidence leaves inventory and unknown lists untouched', () => {
  const cards = [{ id: '3200813', name: '베스칼' }];
  const unidentified = [{ time: 2.4, reason: '이름 확인 필요' }];
  const before = JSON.stringify({ cards, unidentified });
  const state = appendFixedGridRescue(undefined, { version: 1, group: 4, order: 87, slot: 6,
    captureTime: 2.4, pending: false, frameCount: 1, unavailable: false,
    evidence: [{ ...match, source: 'observation-feature', frameId: 73, captureTime: 2.4, slot: 6 }] });
  assert.equal(JSON.stringify({ cards, unidentified }), before);
  assert.equal(Object.hasOwn(state, 'cards'), false);
  assert.equal(Object.hasOwn(state, 'unidentified'), false);
  assert.equal(state.matched, 1);
});

test('evidence state is bounded and never exposes card or unknown mutation fields', () => {
  const record=(order:number)=>({version:1 as const,group:1,order,slot:2,captureTime:order,pending:false,
    frameCount:1,unavailable:false,evidence:[{...match,source:'retained-frame' as const,frameId:order,captureTime:order,slot:2}]});
  let state=appendFixedGridRescue(undefined,record(1),2);
  state=appendFixedGridRescue(state,record(2),2);
  state=appendFixedGridRescue(state,record(3),2);
  assert.equal(state.attempted,3);
  assert.equal(state.matched,3);
  assert.deepEqual(state.records.map(item=>item.order),[2,3]);
  assert.equal(Object.hasOwn(state,'cards'),false);
  assert.equal(Object.hasOwn(state,'unidentified'),false);
  assert.throws(()=>rescueFixedRowSlot({slot:40,captureTime:1,source:'retained-frame',frames:[],match:()=>match}),RangeError);
  assert.throws(()=>rescueFixedRowSlot({slot:1,captureTime:1,source:'retained-frame',frames:[],match:()=>match,maxTimeDistanceSeconds:0}),RangeError);
});

test('duplicate observation hint requires one existing card, matcher gates and optional frame agreement', () => {
  const evidence=(frameId:number,id='3201013')=>({...match,id,source:'canonical-row' as const,frameId,captureTime:2.4,slot:6});
  const record=(order:number,frames:[number,number],id='3201013')=>({version:1 as const,group:1,order,slot:6,captureTime:2.4,
    pending:false,frameCount:2,unavailable:false,evidence:[evidence(frames[0],id),evidence(frames[1],id)]});
  const existing=new Set(['3201013']);
  assert.equal(duplicateRescueObservationCount([record(1,[71,73])],existing),1);
  assert.equal(duplicateRescueObservationCount([record(1,[71,71])],existing,1),1,'one frame can be a same-card candidate when requested');
  assert.equal(duplicateRescueObservationCount([record(1,[71,71])],existing),0,'the default still requires two frames');
  assert.equal(duplicateRescueObservationCount([record(1,[71,73])],new Set()),0,'new card is not a duplicate');
  assert.equal(duplicateRescueObservationCount([record(1,[71,73],'3200012')],existing),0,'unknown ID is not a duplicate');
  const competing={...record(1,[71,73]),evidence:[evidence(71),evidence(73,'3200012')]};
  assert.equal(duplicateRescueObservationCount([competing],existing,1),0,'competing IDs are not duplicates');
  const weak={...record(1,[71,73]),evidence:[{...evidence(71),correlation:.9},{...evidence(73),correlation:.9}]};
  assert.equal(duplicateRescueObservationCount([weak],existing,1),0,'weak matcher gates are not duplicates');
  assert.equal(duplicateRescueObservationCount([record(1,[71,73]),record(2,[75,77])],existing),2);
});

test('video-7 same-card rescue candidates are counted without claiming two-frame promotion', () => {
  const item=(order:number,id:string,frameId:number,source:'canonical-row'|'observation-feature')=>({...match,id,source,frameId,captureTime:2.4,slot:order%40});
  const rec=(order:number,id:string,frameId:number,sources:('canonical-row'|'observation-feature')[])=>({version:1 as const,group:order,order,slot:order%40,captureTime:2.4,
    pending:false,frameCount:sources.length,unavailable:false,evidence:sources.map(source=>item(order,id,frameId,source))});
  const records=[
    rec(64,'3200012',73,['observation-feature','canonical-row']),
    rec(67,'3200008',73,['observation-feature','canonical-row']),
    rec(79,'3200007',73,['canonical-row','observation-feature']),
    rec(91,'3200010',81,['canonical-row','observation-feature']),
    rec(96,'3200009',92,['canonical-row','observation-feature']),
    rec(197,'3200007',128,['canonical-row','observation-feature']),
    rec(264,'3200001',132,['canonical-row','observation-feature']),
    rec(267,'3200007',132,['canonical-row']),
  ];
  const existing=new Set(['3200012','3200008','3200007','3200010','3200009','3200001']);
  assert.equal(duplicateRescueObservationCount(records,existing,1),8);
  assert.equal(duplicateRescueObservationCount(records,existing),0,'one frame per observation cannot be promoted');
});
