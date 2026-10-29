import test from 'node:test';
import assert from 'node:assert/strict';
import {cardCropProofCompleted,runCardCropProofSequence} from '../dev/card-crop-proof-execution';
import {measureCardCropRgba,sha256CardCropBytes} from '../dev/card-crop-proof-core';

const settled=()=>({error:null,disposal:{completed:true}});

test('fresh mode execution is sequential and preserves input/mode order',async()=>{
  const started:string[]=[],published:string[]=[];let active=0;
  await runCardCropProofSequence({inputs:['a','b'],modes:['off','on'],signal:new AbortController().signal,
    run:async(input,mode)=>{assert.equal(active++,0);started.push(`${input}:${mode}`);await Promise.resolve();active--;return settled();},
    onRow:(input,mode)=>published.push(`${input}:${mode}`)});
  assert.deepEqual(started,['a:off','a:on','b:off','b:on']);assert.deepEqual(published,started);
});

test('a failed preparation/read or unconfirmed disposal publishes its row and stops all later readers',async()=>{
  for(const failed of [{error:'prepare timeout',disposal:null},{error:'read timeout',disposal:{completed:true}},
    {error:null,disposal:{completed:false}},{error:null,disposal:null},{error:null,disposal:{}}]){
    const calls:string[]=[],rows:Record<string,unknown>[]=[];
    await runCardCropProofSequence({inputs:['a','b'],modes:['off','on'],signal:new AbortController().signal,
      run:async(input,mode)=>{calls.push(`${input}:${mode}`);return failed;},onRow:(_input,_mode,row)=>{rows.push(row);}});
    assert.deepEqual(calls,['a:off']);assert.deepEqual(rows,[failed]);
  }
});

test('pre-abort starts no reader; abort after a completed row retains it without starting another',async()=>{
  const before=new AbortController();before.abort(Error('before'));
  await assert.rejects(runCardCropProofSequence({inputs:[1],modes:[1],signal:before.signal,
    run:async()=>{assert.fail('no reader after abort');return settled();},onRow:()=>assert.fail('no row')}),/before/);
  const after=new AbortController(),rows:Record<string,unknown>[]=[];let calls=0;
  await assert.rejects(runCardCropProofSequence({inputs:[1,2],modes:[1,2],signal:after.signal,
    run:async()=>{calls++;return settled();},onRow:(_input,_mode,row)=>{rows.push(row);after.abort(Error('after'));}}),/after/);
  assert.equal(calls,1);assert.equal(rows.length,1);
});

test('a rejected run cannot advance to the next mode',async()=>{
  let calls=0;
  await assert.rejects(runCardCropProofSequence({inputs:[1,2],modes:[1,2],signal:new AbortController().signal,
    run:async()=>{calls++;throw Error('reader crashed');},onRow:()=>assert.fail('no fabricated row')}),/reader crashed/);
  assert.equal(calls,1);
});

test('completion requires all settled rows, unchanged source and no late cancellation/error',()=>{
  const complete={rows:[settled(),settled()],expectedRows:2,sourceChanged:false,cancelled:false,error:null};
  assert.equal(cardCropProofCompleted(complete),true);
  for(const override of [{cancelled:true},{sourceChanged:true},{sourceChanged:null},{error:'source check failed'},
    {rows:[settled()]},{rows:[]},{rows:[settled(),{error:null,disposal:{completed:false}}]},
    {expectedRows:0},{expectedRows:NaN}])assert.equal(cardCropProofCompleted({...complete,...override}),false);
});

test('cancellation while the final source check is pending cannot produce a completed comparison',async()=>{
  const controller=new AbortController();let release!:()=>void;
  const sourceCheck=new Promise<void>(resolve=>{release=resolve;});
  const finish=(async()=>{await sourceCheck;return cardCropProofCompleted({rows:[settled()],expectedRows:1,
    sourceChanged:false,cancelled:controller.signal.aborted,error:null});})();
  controller.abort();release();assert.equal(await finish,false);
});

test('a decoded RGBA mismatch retains the actual browser-measured digest and stays unverified',async()=>{
  const pixels=new Uint8ClampedArray(140*210*4);pixels.fill(255);
  const expected=await sha256CardCropBytes(pixels);
  assert.deepEqual(await measureCardCropRgba(pixels,expected),{sha256:expected,verified:true});
  assert.deepEqual(await measureCardCropRgba(pixels,'0'.repeat(64)),{sha256:expected,verified:false});
  await assert.rejects(measureCardCropRgba(new Uint8ClampedArray(4),expected),/Invalid decoded/);
});
