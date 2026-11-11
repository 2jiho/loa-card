import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openVerifiedReplayCase,verifiedReplayRun} from '../dev/replay-run-integrity';
import {hashReplayOriginalChunks} from '../dev/replay-original-hash-core';

const bytes=new Uint8Array([1,2,3,4]);
const sha256=createHash('sha256').update(bytes).digest('hex');
const input=()=>({index:0,name:'input.loareplay',bytes:4,type:'application/octet-stream',sha256,url:'/input'});
const options=(data=bytes)=>({request:(async()=>new Response(data)) as typeof fetch,hash:hashReplayOriginalChunks});
const signal=()=>new AbortController().signal;

test('proof applies only to the actual opened replay and matching one-input manifest',async()=>{
 let opened:Blob|undefined;
 const source=input();
 const {replay,proof}=await openVerifiedReplayCase('case-a',source,signal(),async blob=>{
  opened=blob;return {original:blob};
 },options());
 assert.equal(replay.original,opened);
 assert.deepEqual(new Uint8Array(await opened!.arrayBuffer()),bytes);
 const context={caseId:'case-a',inputs:[{index:source.index,name:source.name,bytes:source.bytes,type:source.type,sha256:source.sha256}],
  replay,started:true,outcome:'completed'};
 assert.equal(verifiedReplayRun(proof,context),true);
 assert.equal(verifiedReplayRun(proof,{...context,caseId:'case-b'}),false);
 assert.equal(verifiedReplayRun(proof,{...context,replay:{original:new Blob([bytes])}}),false);
 assert.equal(verifiedReplayRun(proof,{...context,started:false}),false);
 assert.equal(verifiedReplayRun(proof,{...context,outcome:'cancelled'}),false);
 assert.equal(verifiedReplayRun(undefined,context),false);
 for(const altered of [{name:'another'}, {bytes:5}, {sha256:'0'.repeat(64)}, {index:1}, {type:'video/mp4'}])
  assert.equal(verifiedReplayRun(proof,{...context,inputs:[{...context.inputs[0],...altered}]}),false);
 assert.equal(verifiedReplayRun(proof,{...context,inputs:[...context.inputs,...context.inputs]}),false);
 source.sha256='0'.repeat(64);
 assert.equal(verifiedReplayRun(proof,context),true,'manifest snapshot cannot be altered after verification');
});

test('mutated, invalid, cancelled, hash-failed and open-failed input never produces a proof',async()=>{
 let opens=0;
 const open=async()=>{opens++;return {};};
 await assert.rejects(openVerifiedReplayCase('case-a',input(),signal(),open,options(new Uint8Array([1,2,3,5]))),/SHA-256/);
 await assert.rejects(openVerifiedReplayCase('case-a',{...input(),sha256:'bad'},signal(),open,options()),/SHA-256/);
 await assert.rejects(openVerifiedReplayCase('case-a',{...input(),bytes:5},signal(),open,options()),/length/);
 await assert.rejects(openVerifiedReplayCase('case-a',input(),signal(),open,{...options(),hash:async()=>{throw Error('worker failed');}}),/worker failed/);
 const controller=new AbortController();
 await assert.rejects(openVerifiedReplayCase('case-a',input(),controller.signal,open,{...options(),hash:async()=>{
  controller.abort();return sha256;
 }}),{name:'AbortError'});
 assert.equal(opens,0);
 await assert.rejects(openVerifiedReplayCase('case-a',input(),signal(),async()=>{throw Error('invalid replay');},options()),/invalid replay/);
 const second=new AbortController();
 await assert.rejects(openVerifiedReplayCase('case-a',input(),second.signal,async()=>{second.abort();return {};},options()),{name:'AbortError'});
});
