import test from 'node:test';
import assert from 'node:assert/strict';
import {correlateSourceFrame,parseSourceFrameCorrelation,sameSourceFrameCorrelation} from '../src/features/card-scanner/source-frame-correlation';

test('source correlation is small detached immutable metadata, preserving native signed offsets',()=>{
  const input={mediaTime:4.5,presentedFrames:135,frameTimestampUs:4_500_000};
  const value=parseSourceFrameCorrelation(input);
  assert.deepEqual(value,input);assert.notEqual(value,input);assert.equal(Object.isFrozen(value),true);
  input.mediaTime=9;assert.equal(value.mediaTime,4.5);
  assert.deepEqual(parseSourceFrameCorrelation({frameTimestampUs:-1000}),{frameTimestampUs:-1000});
  assert.equal(sameSourceFrameCorrelation(value,{frameTimestampUs:4_500_000,presentedFrames:135,mediaTime:4.5}),true);
  assert.equal(sameSourceFrameCorrelation(value,{...value,mediaTime:4.6}),false);
  assert.equal(sameSourceFrameCorrelation(value,undefined),false);
  assert.equal(sameSourceFrameCorrelation(undefined,undefined),true);
});

test('source metadata rejects handles, extension keys, coercion and inexact scalar coordinates',()=>{
  for(const invalid of [undefined,null,[],{},Object.create({mediaTime:1}),new Date(),
    {mediaTime:undefined},{mediaTime:-1},{mediaTime:NaN},{mediaTime:Infinity},{mediaTime:'1'},
    {presentedFrames:-1},{presentedFrames:1.5},{presentedFrames:Number.MAX_SAFE_INTEGER+1},
    {frameTimestampUs:0.5},{frameTimestampUs:NaN},{frameTimestampUs:'100'},{frameTimestampUs:Number.MAX_SAFE_INTEGER+1},
    {mediaTime:1,pixels:[]},{frameTimestampUs:1,source:{}},
  ])assert.throws(()=>parseSourceFrameCorrelation(invalid),TypeError);
});

test('callback coordinates attach only when immutable native timestamp corroborates the same media instant',()=>{
  const callback={mediaTime:.03333333333333333,presentedFrames:2};
  const matched=correlateSourceFrame(33_333,callback);
  assert.deepEqual(matched,{...callback,frameTimestampUs:33_333});
  callback.mediaTime=9;assert.equal(matched.mediaTime,1/30);
  assert.deepEqual(correlateSourceFrame(4_500_000,{mediaTime:4.5}),{mediaTime:4.5,frameTimestampUs:4_500_000});
  assert.deepEqual(correlateSourceFrame(3_000_000,{mediaTime:4.5,presentedFrames:135}),{frameTimestampUs:3_000_000},
    'different captureStream timestamp origins do not prove original mediaTime');
  assert.deepEqual(correlateSourceFrame(1),{frameTimestampUs:1});
  assert.deepEqual(correlateSourceFrame(-1000,{mediaTime:0,presentedFrames:0}),{frameTimestampUs:-1000});
});
