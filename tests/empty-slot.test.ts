import{test}from"node:test";
import assert from"node:assert/strict";
import{readFileSync}from"node:fs";
import{emptySlotVector,isEmptySlotVector}from"../src/features/card-scanner/empty-slot.ts";
const samples=JSON.parse(readFileSync(new URL('./fixtures/empty-slot-samples.json',import.meta.url),'utf8')) as {group:number;page:number;row:number;column:number;empty:boolean;vector:string}[];

test('independent screenshot slots exclude the fixed card back without excluding owned artwork',()=>{
 assert.equal(samples.length,800);
 assert.equal(samples.filter(s=>s.empty).length,32);
 for(const sample of samples){const vector=Uint8Array.from(Buffer.from(sample.vector,'base64'));
  assert.equal(isEmptySlotVector(vector),sample.empty,JSON.stringify({...sample,vector:undefined}));
 }
});
test('empty-slot matching tolerates exposure but rejects flat, corrupted and wrong-size observations',()=>{
 const vector=Uint8Array.from(Buffer.from(samples.find(s=>s.empty)!.vector,'base64'));
 assert.equal(isEmptySlotVector(Float32Array.from(vector,v=>v*.8+10)),true);
 assert.equal(isEmptySlotVector(new Uint8Array(560).fill(30)),false);
 assert.equal(isEmptySlotVector(Float32Array.from(vector,(_,i)=>vector[559-i])),false);
 assert.equal(isEmptySlotVector(vector.subarray(0,100)),false);
 assert.equal(emptySlotVector([],140,210).length,0);
});

test('visually checked compressed live card backs are rejected before expensive name retries',()=>{
 const rows=JSON.parse(readFileSync(new URL('./fixtures/compressed-empty-slots.json',import.meta.url),'utf8')) as {source:string;vector:string}[];
 assert.equal(rows.length,6);
 for(const row of rows){const bytes=Uint8Array.from(Buffer.from(row.vector,'base64'));const vector=new Float32Array(bytes.buffer);assert.equal(isEmptySlotVector(vector),true,row.source);}
});

test('coarse matching cannot hide large fine-detail corruption',()=>{
 const vector=Uint8Array.from(Buffer.from(samples.find(s=>s.empty)!.vector,'base64'));
 const changed=Float32Array.from(vector,(v,i)=>v+((Math.floor(i/20)+i%20)%2?8:-8));
 assert.equal(isEmptySlotVector(changed),false);
});
