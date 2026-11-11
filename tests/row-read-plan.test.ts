import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planRow} from '../dev/row-read-plan';
import type {ListCell} from '../src/features/card-scanner/session/list-table';

const cell=(state:ListCell['state'],card:number|null=null):ListCell=>({state,card,looks:1,firstTime:0,lastTime:0});
const all=new Set([0,1,2,3,4,5,6,7,8,9]);
/** A known list row 7 of island 3: card code = 70 + column. */
const known=(overrides:Record<number,ListCell|null>={})=>(island:number,row:number,column:number)=>
  island===3&&row===7?(column in overrides?overrides[column]:cell('card',70+column)):null;
const probes=(first:number|null,second:number|null,place=(card:number)=>({island:3,row:7,column:card-70}))=>
  [{column:2,card:first,place:first===null?null:place(first)},{column:7,card:second,place:second===null?null:place(second)}];

test('both probes at their columns of one known row: only slots without a result are read', () => {
  const complete=new Set([70,71,72,73,74,75,77,78,79]);                    // 76 still lacks a value
  const plan=planRow({columns:10,probes:probes(72,77),usable:all,
    cellAt:known({4:cell('unidentified'),9:cell('empty'),0:null}),complete:card=>complete.has(card)});
  assert.deepEqual(plan.known,{island:3,row:7});
  assert.deepEqual(plan.read,[0,4,6]);                                      // never seen, unnamed card, incomplete card
});

test('a fully read known row needs nothing, and an unusable slot is never asked for', () => {
  const plan=planRow({columns:10,probes:probes(72,77),usable:new Set([1,2,3,5,7,8]),cellAt:known({0:null}),complete:()=>true});
  assert.deepEqual(plan,{known:{island:3,row:7},read:[]});                  // slot 0 was never seen but is not usable now
});

test('anything less certain reads the whole row', () => {
  const whole=[0,1,3,4,5,6,8,9];
  const read=(input:Parameters<typeof probes>)=>planRow({columns:10,probes:probes(...input),usable:all,cellAt:known(),complete:()=>true});
  assert.deepEqual(read([72,null]),{known:null,read:whole});                // a probe not identified
  assert.deepEqual(read([72,77,card=>card===77?{island:3,row:8,column:7}:{island:3,row:7,column:2}]),{known:null,read:whole});   // different rows
  assert.deepEqual(read([72,77,card=>({island:card===77?4:3,row:7,column:card-70})]),{known:null,read:whole});                    // different islands
  assert.deepEqual(read([72,77,card=>({island:3,row:7,column:card===72?3:7})]),{known:null,read:whole});                           // a card at another column
  // A card the table has not placed yet.
  assert.deepEqual(planRow({columns:10,probes:[{column:2,card:72,place:null},{column:7,card:77,place:{island:3,row:7,column:7}}],
    usable:all,cellAt:known(),complete:()=>true}),{known:null,read:whole});
  // One probe alone never recognises a row.
  assert.deepEqual(planRow({columns:10,probes:[{column:2,card:72,place:{island:3,row:7,column:2}}],usable:all,cellAt:known(),complete:()=>true}).known,null);
});

test('a slot handed to the name reading is not read again, but only when the caller says so', () => {
  const unnamed={...cell('unidentified'),looks:3};
  const input={columns:10,probes:probes(72,77),usable:all,cellAt:known({4:unnamed}),complete:()=>true};
  assert.deepEqual(planRow(input).read,[4]);
  assert.deepEqual(planRow({...input,handedOver:seen=>seen.looks>=3}).read,[]);
  assert.deepEqual(planRow({...input,handedOver:seen=>seen.looks>=4}).read,[4]);
});
