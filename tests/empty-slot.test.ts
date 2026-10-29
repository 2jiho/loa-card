import{test}from"node:test";
import assert from"node:assert/strict";
import{readFileSync}from"node:fs";
import{emptySlotVector,isEmptySlotVector}from"../src/features/card-scanner/empty-slot.ts";
import{inspectCapture}from"../src/features/card-scanner/capture-quality.ts";
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

function addCursor(vector:Float32Array,x:number,y:number) {
 for(const [dx,dy,delta]of[[0,0,70],[0,1,120],[1,1,90],[1,2,20]])
  vector[(y+dy)*20+x+dx]=Math.min(255,vector[(y+dy)*20+x+dx]+delta);
 return vector;
}

test('one small cursor preserves the fixed back across locations and exposure',()=>{
 for(const [x,y]of[[1,10],[6,8],[11,14],[17,21]])for(const gain of[.8,1,1.2]) {
  const vector=addCursor(Float32Array.from(cursorBack,v=>v*gain+5),x,y);
  assert.equal(isEmptySlotVector(vector),true,`${x}/${y}/${gain}`);
 }
});

test('cursor exceptions cannot conceal name ink, broad overlays or scattered changes',()=>{
 assert.equal(isEmptySlotVector(addCursor(cursorBack.slice(),6,2)),false,'name band must remain intact');
 const broad=cursorBack.slice();for(let y=10;y<15;y++)for(let x=5;x<10;x++)broad[y*20+x]+=100;
 assert.equal(isEmptySlotVector(broad),false,'wide overlay');
 const scattered=addCursor(addCursor(cursorBack.slice(),1,10),17,21);
 assert.equal(isEmptySlotVector(scattered),false,'separate regions');
 const dark=cursorBack.slice();for(const [x,y]of[[1,10],[1,11],[2,11],[2,12]])dark[y*20+x]=0;
 assert.equal(isEmptySlotVector(dark),false,'dark defects alone are not a white cursor');
 const noisy=addCursor(Float32Array.from(cursorBack,(v,i)=>v+(i%2?8:-8)),1,10);
 assert.equal(isEmptySlotVector(noisy),false,'the rest of the motif must still match');
});

test('a cursor on any of the 768 owned portraits never makes it an empty slot',()=>{
 let checked=0;
 for(const sample of samples.filter(s=>!s.empty))for(const [x,y]of[[1,10],[6,8],[11,14],[17,21]]) {
  const vector=addCursor(Float32Array.from(Buffer.from(sample.vector,'base64')),x,y);
  assert.equal(isEmptySlotVector(vector),false,`${sample.group}/${sample.page}/${sample.row}/${sample.column}: ${x}/${y}`);
  checked++;
 }
 assert.equal(checked,3072);
});

test('a cursor-covered back is rejected before structural border acceptance',()=>{
 const vector=addCursor(cursorBack.slice(),1,10),image=new Uint8Array(140*210*4);
 // Paint the synthetic low-resolution back into the same sampling cells.
 for(let y=0;y<28;y++)for(let x=0;x<20;x++) {
  const top=Math.round(6+198*y/28),bottom=Math.round(6+198*(y+1)/28);
  const left=Math.round(6+128*x/20),right=Math.round(6+128*(x+1)/20),v=vector[y*20+x];
  for(let yy=top;yy<bottom;yy++)for(let xx=left;xx<right;xx++)image.set([v,v,v,255],(yy*140+xx)*4);
 }
 const result=inspectCapture(image,140,210,true,false,true,true);
 assert.equal(result.usable,false);
 assert.equal(result.reason,'미보유 카드 뒷면 · 빈 슬롯');
});

// Existing public fixed-back motif; all cursor/occlusion pixels below are synthetic.
const cursorBack=Float32Array.from(Buffer.from("HSAgIR0dICQdMSUbJR0dHR8fHxwkJCUlJSUlJicpKCcmJiYlJSUkIyUlJicnJicoKSsqKScnJicnJiUkJScmJigqKCgpLCsoKSkoJyYmJiQlJicoJycoKSowLyooKCgoKCcmJCUmJygoKCgpLi8wLSkoJygoJycjJycoKCgqKywwNDYvLCwqJygoKCYnKCgpKiwtMTI2NzIwLi4rKCgnJycoKiwuLTAwNjM0NDExLS4sKSgnKCgsLi4uLjQ1MzI0MS8vLi0rKCcoKy0vMi4xNDY2NjU0MDEyLi0pJyotLjEyNDI1Nzg4NzUxNTIwLiwoKy0vMjQ3NDc7NzU6NzM4NTEvLCkrLzAzNTg1OzY5NTg5NTg2MzAuKSouMTM2MTI5Mjw6MzcyNDc0Mi8pLC8xMzgxMTE0OjgzNDIzODYwLissMDIzMzAvNDI5NzQ0MTI0MzIvKyouNDw1NjY1Nzo4Nzg4Njk8MCwoJy0yNDs+PT08Ojs9PkBBOTEyLCcrLTExNTg7Ojk4OTs8OjwzMjAuKikrMjQzLDY2Ozg5Ojc1LTQzLywpKy4vMjMxLjU2Ojs2NS0wMjAuLioqLi4uLTAuMDQ5OjQwLjEvLi4tKSotLi8vLCwxMTQ0MTAtLi8uLi0oKiwuLS4vLS8qNTMsLy4vLy4uLisrLi0uLy8uLCstJysuLi4vLi4uKysuLi4vMDAxMzIyMzEvLy8uLi0sKy0uLi8vLzAxMDAxLy8uLi4tLSw=","base64"));
