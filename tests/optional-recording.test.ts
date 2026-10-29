import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startOptionalRecording,shouldRecordContinuous} from '../src/features/card-scanner/optional-recording';

test('basic diagnostics do not record video; detailed capture is explicitly selected',()=>{
 for(const development of [true,false]){
  assert.equal(shouldRecordContinuous(undefined,undefined,development),false);
  assert.equal(shouldRecordContinuous('diagnostic',undefined,development),false);
  assert.equal(shouldRecordContinuous('detailed',undefined,development),true);
 }
 assert.equal(shouldRecordContinuous('detailed','disabled',true),false);
 assert.equal(shouldRecordContinuous('diagnostic','fail-start',true),true);
 assert.equal(shouldRecordContinuous('diagnostic','fail-start',false),false);
 assert.equal(shouldRecordContinuous('detailed','disabled',false),true);
 assert.throws(()=>shouldRecordContinuous('invalid' as never,undefined,false),TypeError);
});
test('disabled recording never constructs or allocates the recording backend',()=>{
  const result=startOptionalRecording(false,()=>{assert.fail('must not start');});
  assert.equal(result.status,'disabled');assert.ok(!('recording' in result));
});
test('start failure remains explicit and does not escape into live processing',()=>{
  const result=startOptionalRecording(true,()=>{throw Error('codec unavailable');});
  assert.equal(result.status,'failed');assert.ok('warning' in result);
  assert.match(result.warning,/codec unavailable/);assert.ok(!('recording' in result));
});
test('successful recording preserves the exact owned backend',()=>{
  const owned={finish:()=>Promise.resolve()};
  const result=startOptionalRecording(true,()=>owned);
  assert.equal(result.status,'active');assert.ok('recording' in result);assert.equal(result.recording,owned);
});
