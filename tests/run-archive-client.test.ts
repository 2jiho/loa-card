import {test} from 'node:test';
import assert from 'node:assert/strict';
import {archiveCorpusRun} from '../dev/run-archive-client';

const id='a'.repeat(64),hash='b'.repeat(64),report=new Blob(['{}'],{type:'application/json'});
const reply=(change:Record<string,unknown>={})=>new Response(JSON.stringify({created:true,id,sha256:hash,
  file:`cases/${id}/runs/run-${hash}.json`,summary:{classification:'completed',verification:'unverified'},...change}),{status:201});

test('archive posts the bounded original report to the selected local case without claiming truth',async()=>{
  let calls=0;
  const request=(async(url,init)=>{
    calls++;assert.equal(url,`/__corpus/cases/${id}/runs`);assert.equal(init?.method,'POST');
    assert.equal(init?.body,report);assert.equal((init?.headers as Record<string,string>)['Content-Type'],'application/json;charset=utf-8');
    return reply();
  }) as typeof fetch;
  const result=await archiveCorpusRun(id,report,new AbortController().signal,request);
  assert.equal(calls,1);assert.equal(result.sha256,hash);assert.equal(result.classification,'completed');
});

test('invalid case, oversized report, aborted input and foreign server responses are rejected',async()=>{
  const never=(async()=>assert.fail('request must not start')) as typeof fetch;
  await assert.rejects(archiveCorpusRun('../other',report,new AbortController().signal,never));
  await assert.rejects(archiveCorpusRun(id,new Blob([new Uint8Array(16*1024*1024+1)]),new AbortController().signal,never));
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(archiveCorpusRun(id,report,aborted.signal,never));
  for(const change of [{id:'c'.repeat(64)},{file:'../outside.json'},{summary:{classification:'completed',verification:'verified'}}])
    await assert.rejects(archiveCorpusRun(id,report,new AbortController().signal,(async()=>reply(change)) as typeof fetch));
  await assert.rejects(archiveCorpusRun(id,report,new AbortController().signal,(async()=>new Response('',{status:500})) as typeof fetch));
  await assert.rejects(archiveCorpusRun(id,report,new AbortController().signal,(async()=>new Response('x'.repeat(5000))) as typeof fetch),/너무 큽니다/);
});

test('archive timeout aborts its request even when a backend never settles',{timeout:1000},async()=>{
  let requestSignal:AbortSignal|undefined;
  const pending=(async(_url,init)=>{requestSignal=init?.signal??undefined;return new Promise<Response>(()=>{});}) as typeof fetch;
  await assert.rejects(archiveCorpusRun(id,report,new AbortController().signal,pending,10),/시간이 초과/);
  assert.equal(requestSignal?.aborted,true);
});

test('cancelling an in-flight archive preserves the abort and never retries automatically',async()=>{
  const controller=new AbortController();let calls=0;
  const request=(async(_url,init)=>{
    calls++;
    return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
  }) as typeof fetch;
  const saving=archiveCorpusRun(id,report,controller.signal,request);
  controller.abort();await assert.rejects(saving);assert.equal(calls,1);
});
