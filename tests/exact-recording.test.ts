import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packPixels,unpackPixels,deflate,pixelHash,entryParts,exactPixels,exactEntries,executionSummary,inflate,fastCompress,fastInflate} from '../src/features/card-scanner/exact-recording-codec';
const signal=()=>new AbortController().signal;
async function archive(images:Uint8Array[]){const parts:BlobPart[]=[];for(let i=0;i<images.length;i++)parts.push(...entryParts({kind:'frame',id:i+1,time:i/10,width:images[i].length/4,height:1,key:i===0||images[i].length!==images[i-1].length,hash:await pixelHash(images[i] as Uint8Array<ArrayBuffer>)},await deflate(packPixels(images[i],images[i-1]))));return new Blob(parts);}
test('lossless deltas preserve one pixel changes, identical frames, final short blocks and resize',async()=>{
 const first=new Uint8Array(40000);crypto.getRandomValues(first);const second=first.slice();second[16384]=second[16384]^1;const small=new Uint8Array(24).fill(17);
 const values=[first,second,second,small],input=await archive(values);let n=0;
 for await(const frame of exactPixels(input,signal())){assert.deepEqual(frame.pixels,values[n++]);}assert.equal(n,4);assert.equal(packPixels(second,second).length,4);
});
test('truncated, corrupt, oversized or reordered input fails instead of silently reusing pixels',async()=>{
 const frame=new Uint8Array(16),valid=await archive([frame]);await assert.rejects(async()=>{for await(const f of exactPixels(valid.slice(0,-1),signal()))void f;},/길이/);
 const bad=new Blob(entryParts({kind:'frame',id:1,time:0,width:4,height:1,key:true,hash:'0'.repeat(64)},await deflate(packPixels(frame))));
 await assert.rejects(async()=>{for await(const f of exactPixels(bad,signal()))void f;},/픽셀 불일치/);
 const double=new Blob([valid,valid]);await assert.rejects(async()=>{for await(const f of exactPixels(double,signal()))void f;},/순서/);
 const delta=packPixels(frame);new DataView(delta.buffer).setUint32(4,99,true);assert.throws(()=>unpackPixels(delta,new Uint8Array(16)),/블록/);
 await assert.rejects(inflate(new Blob([await deflate(new Uint8Array(10000))]),100),/용량/);
});
test('cancelled playback does not decode the next frame',async()=>{const a=new AbortController();a.abort();await assert.rejects(async()=>{for await(const f of exactPixels(await archive([new Uint8Array(4)]),a.signal))void f;},{name:'AbortError'});});
test('execution events preserve order and keep only latest result per card in summary',async()=>{
 const events=[{kind:'event' as const,seq:1,time:0,type:'read-start',value:{id:1}},{kind:'event' as const,seq:2,time:1,type:'card',value:{id:'a',name:'카드',awakening:1,extraCopies:4}},{kind:'event' as const,seq:3,time:2,type:'card',value:{id:'a',name:'카드',awakening:2,extraCopies:2}}];
 const blob=new Blob(events.flatMap(e=>entryParts(e))),summary=await executionSummary(blob,signal());assert.equal(summary.events,3);assert.equal(summary.cards.length,1);assert.equal(summary.cards[0].awakening,2);
 await assert.rejects(executionSummary(new Blob([blob,...entryParts(events[0])]),signal()),/순서/);
 let count=0;for await(const entry of exactEntries(blob,signal())){assert.equal(entry.payload.size,0);count++;}assert.equal(count,3);
});

test('speed-first codec round trips zeros, noise, tiny blocks and large repeating images',async()=>{
 for(const length of [0,1,4,12,16384,65536,2*1024*1024]){
  for(const noise of [false,true]){
   const input=new Uint8Array(length);if(noise)for(let i=0;i<length;i+=65536)crypto.getRandomValues(input.subarray(i,Math.min(length,i+65536)));
   const packed=fastCompress(input);assert.deepEqual(fastInflate(packed,length),input);
   if(length)assert.throws(()=>fastInflate(packed,length-1),/용량/);
  }
 }
 const input=new Uint8Array(200000).fill(42),packed=fastCompress(input),blob=new Blob(entryParts({kind:'frame',id:1,time:0,width:50000,height:1,key:true,hash:await pixelHash(input),codec:'lz4'},fastCompress(packPixels(input))));
 for await(const frame of exactPixels(blob,signal()))assert.deepEqual(frame.pixels,input);
 assert.throws(()=>fastInflate(packed.slice(0,8),200000));
 const invalid=new Uint8Array([1,4,0,0,0,0,0,0]);assert.throws(()=>fastInflate(invalid,4),/오프셋/);
});
test('event reading is buffered instead of doing an I/O for every tiny header',async()=>{
 const entries=Array.from({length:3000},(_,i)=>({kind:'event' as const,seq:i+1,time:i/100,type:'stage',value:{id:i,stage:'duplicate'}}));
 const blob=new Blob(entries.flatMap(e=>entryParts(e)));let reads=0;const slice=blob.slice.bind(blob);blob.slice=(...args)=>{reads++;return slice(...args);};
 const result=await executionSummary(blob,signal());assert.equal(result.events,3000);
 // Payload slices themselves are cheap; at most two additional buffered reads.
 assert.ok(reads<=3002);
});

test('XOR deltas reconstruct exact prior-frame changes including transparent pixels',async()=>{
 let previous:Uint8Array|undefined;const expected:Uint8Array[]=[],parts:BlobPart[]=[];
 for(let i=0;i<8;i++){
  const data=previous?.slice()??new Uint8Array(120000);for(let n=0;n<1000;n++)data[(n*31+i*17)%data.length]=(n+i)%256;
  parts.push(...entryParts({kind:'frame',id:i+1,time:i/10,width:30000,height:1,key:i===0,hash:await pixelHash(data as Uint8Array<ArrayBuffer>),codec:'lz4',xor:true},fastCompress(packPixels(data,previous,true))));expected.push(data);previous=data;
 }
 let i=0;for await(const frame of exactPixels(new Blob(parts),signal()))assert.deepEqual(frame.pixels,expected[i++]);assert.equal(i,8);
});

test('execution summary bounds imported card and event dictionaries',async()=>{
 const cards=Array.from({length:1001},(_,i)=>({kind:'event' as const,seq:i+1,time:i,type:'card',value:{id:String(i)}}));
 await assert.rejects(executionSummary(new Blob(cards.flatMap(e=>entryParts(e))),signal()),/카드 기록 한도/);
 const kinds=Array.from({length:65},(_,i)=>({kind:'event' as const,seq:i+1,time:i,type:i===0?'__proto__':String(i),value:null}));
 await assert.rejects(executionSummary(new Blob(kinds.flatMap(e=>entryParts(e))),signal()),/이벤트 종류 한도/);
});
