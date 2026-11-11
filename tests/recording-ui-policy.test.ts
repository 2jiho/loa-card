import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultDetailedRecording,detailedRecordingResult,noRecordedInputMessage} from '../src/features/card-scanner/ui/recording-ui-policy';

test('detailed replay recording is automatic in development but opt-in in production',()=>{
 assert.equal(defaultDetailedRecording(true),true);assert.equal(defaultDetailedRecording(false),false);
});
test('missing legacy input does not claim whether recording was disabled',()=>{
 assert.match(noRecordedInputMessage({status:'partial',hasInput:false})!,/설정은 확인되지 않았습니다/);
 assert.equal(noRecordedInputMessage({status:'open',hasInput:false,record:false}),null);
 assert.equal(noRecordedInputMessage({status:'complete',hasInput:true,record:true}),null);
});
test('an incomplete session, absent pixels or interrupted scan is never presented as a complete input',()=>{
 const complete={metadata:{completed:true,recordState:'complete',exact:{complete:true,dropped:0,error:'',frames:1}}};
 assert.match(detailedRecordingResult(true,complete),/^입력 기록 보관됨/);
 for(const file of [undefined,{metadata:{}},{metadata:{recordState:'partial',exact:{complete:true}}},
   {metadata:{recordState:'complete',exact:{complete:false}}},{metadata:{...complete.metadata,recordState:'failed'}},
   {metadata:{...complete.metadata,exact:{...complete.metadata.exact,dropped:1}}}]){
  assert.doesNotMatch(detailedRecordingResult(true,file),/^입력 기록 보관됨/);
 }
 assert.equal(detailedRecordingResult(false,complete),'');
 assert.doesNotMatch(detailedRecordingResult(true,undefined),/요약.*보관/,'an absent file does not prove a diagnostic was saved');
});
