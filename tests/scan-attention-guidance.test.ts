import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attentionCardAdvice,attentionCountAdvice,attentionScanMode,unidentifiedAttention,unidentifiedDisplayKey,unidentifiedReferenceAdvice,unmatchedPendingFields} from '../src/features/card-scanner/ui/scan-attention-guidance';
import type {PortraitDiagnostics} from '../src/features/card-scanner/recognition/portrait-diagnostics';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import type {PendingCardFields} from '../src/features/card-scanner/session/current-scan-fields';
import {pendingScanFields} from '../src/features/card-scanner/session/current-scan-fields';

test('count advice uses only the newest unresolved structured field observation',()=>{
  const card:ScannedCard={id:'1',name:'card',awakening:0,extraCopies:null,confidence:1,review:['장수 확인'],image:'',time:1,observations:1,captureOrder:10};
  const pattern={value:null,candidate:null,score:0,gap:0,reason:'장수 숫자 미검출 또는 불명확'};
  const countDiagnostics={maximum:15,reason:'숫자 획 부족',readings:[],reliability:'unconfirmed' as const,pattern};
  const pending:PendingCardFields={id:'1',name:'card',image:'',time:2,captureOrder:11,reason:'추가 장수 확인',countDiagnostics};
  assert.equal(attentionCountAdvice(card,pending),'장수 숫자를 읽지 못했어요. 숫자가 가려지지 않았는지 봐 주세요.');
  assert.equal(attentionCountAdvice({...card,captureOrder:11},pending),'장수 숫자를 읽지 못했어요. 숫자가 가려지지 않았는지 봐 주세요.');
  assert.equal(attentionCountAdvice(card,undefined),null);
  assert.equal(attentionCountAdvice(card,{...pending,id:'2'}),null);
  assert.equal(attentionCountAdvice(card,{...pending,captureOrder:9}),null);
  assert.equal(attentionCountAdvice(card,{...pending,captureOrder:undefined}),null);
  assert.equal(attentionCountAdvice({...card,captureOrder:undefined},pending),null);
  assert.equal(attentionCountAdvice(card,{...pending,countDiagnostics:undefined}),null);
  assert.equal(attentionCountAdvice(card,{...pending,countDiagnostics:{...countDiagnostics,reliability:'clear-pattern'}}),null);
  assert.equal(attentionCountAdvice(card,{...pending,countDiagnostics:{...countDiagnostics,pattern:{...pattern,value:1}}}),null);
  assert.equal(attentionCountAdvice(card,{...pending,countDiagnostics:{...countDiagnostics,pattern:{...pattern,reason:'숫자 획 부족'}}}),null);
  assert.equal(attentionCountAdvice(card,{...pending,countDiagnostics:{...countDiagnostics,pattern:undefined}}),null);
  const observation={card:{...card,captureOrder:11,countDiagnostics},borderAlignment:1};
  const visible=pendingScanFields([observation],{latest:new Map([['1',11]]),confirmed:new Map()});
  assert.equal(attentionCountAdvice(card,visible[0]),'장수 숫자를 읽지 못했어요. 숫자가 가려지지 않았는지 봐 주세요.');
  const stale=pendingScanFields([observation],{latest:new Map([['1',12]]),confirmed:new Map()});
  assert.equal(attentionCountAdvice(card,stale[0]),null,'a newer observation excludes old diagnostics');
  const resolved=pendingScanFields([observation],{latest:new Map([['1',11]]),confirmed:new Map([['1',11]])});
  assert.equal(attentionCountAdvice(card,resolved[0]),null,'confirmed fields do not keep an old warning');
});

test('only a rejected missing competitor diagnostic explains that a re-scan may remain unresolved',()=>{
  const calls=(outcome:string,reason:string)=>[{diagnostic:{outcome,reason}}] as unknown as PortraitDiagnostics;
  assert.equal(unidentifiedReferenceAdvice(undefined),null);
  assert.equal(unidentifiedReferenceAdvice(null),null);
  assert.equal(unidentifiedReferenceAdvice([]),null);
  assert.equal(unidentifiedReferenceAdvice(calls('rejected','all-stages-rejected')),null);
  assert.equal(unidentifiedReferenceAdvice(calls('accepted','missing-competitor-reference')),null);
  assert.match(unidentifiedReferenceAdvice(calls('rejected','missing-competitor-reference'))!,/비슷한 카드/);
});

test('unidentified guidance appears only for final unresolved inputs, never for pending or empty input',()=>{
  assert.equal(unidentifiedAttention([]).advice,undefined);
  const pending={pending:true,id:'pending'},final={pending:false,id:'final'};
  assert.equal(unidentifiedAttention([pending]).advice,undefined);
  const result=unidentifiedAttention([pending,final]);
  assert.deepEqual(result.unresolved,[final]);
  assert.match(result.advice!,/커서와 툴팁/);
  assert.match(result.advice!,/그래도 남으면 공유를 끝내고 다시 스캔/);
});

test('rescan advice waits for queued work and distinguishes stopped screen sharing',()=>{
  const live={sharing:true,busy:true,queued:0,activeReadings:0};
  assert.equal(attentionScanMode(live),'sharing');
  assert.equal(attentionScanMode({...live,queued:1}),'processing');
  assert.equal(attentionScanMode({...live,activeReadings:1}),'processing');
  assert.equal(attentionScanMode({...live,queued:undefined}),'processing');
  assert.equal(attentionScanMode({...live,queued:-1}),'processing');
  assert.equal(attentionScanMode({...live,sharing:false}),'processing');
  assert.equal(attentionScanMode({...live,sharing:false,busy:false}),'restart');
  assert.match(attentionCardAdvice('processing'),/아직 읽는 중/);
  assert.doesNotMatch(attentionCardAdvice('processing'),/보여 주세요|다시 스캔해/);
  assert.match(attentionCardAdvice('restart'),/다시 스캔해 주세요/);
});

test('unknown inputs without a location request the whole list; estimated locations remain estimates',()=>{
  const unknown={pending:false},located={pending:false,location:{percent:42,column:4,row:18}};
  const during=unidentifiedAttention([unknown,located],'processing');
  assert.match(during.advice!,/아직 읽는 중/);assert.doesNotMatch(during.advice!,/다시 보여/);
  assert.match(unidentifiedAttention([unknown],'sharing').advice!,/목록 전체/);
  assert.match(unidentifiedAttention([located],'sharing').advice!,/표시된 위치 근처를/);
  assert.match(unidentifiedAttention([located,unknown],'sharing').advice!,/위치 근처와 목록 전체/);
  assert.match(unidentifiedAttention([unknown],'restart').advice!,/다시 스캔해 주세요/);
  assert.equal(unidentifiedAttention([unknown],'restart').hasLocation,false);
  assert.equal(unidentifiedAttention([located],'restart').hasLocation,true);
});

test('a final unidentified input can be re-shown during other queued work only while sharing',()=>{
  const pending={pending:true,location:{percent:12,column:1}},final={pending:false,location:{percent:42,column:4,row:18}};
  const live=unidentifiedAttention([pending,final],'processing',true);
  assert.deepEqual(live.unresolved,[final]);
  assert.doesNotMatch(live.advice!,/다시 스캔/);
  assert.match(live.advice!,/표시된 위치 근처를 다시 보여/);
  assert.match(live.advice!,/커서와 툴팁은 카드 밖으로/);
  const stopped=unidentifiedAttention([pending,final],'processing',false);
  assert.match(stopped.advice!,/아직 읽는 중/);
  assert.doesNotMatch(stopped.advice!,/다시 보여|다시 스캔해/);
  assert.equal(unidentifiedAttention([pending],'processing',true).advice,undefined);
});

test('same-group unknown observations retain distinct stable display keys',()=>{
  const source={sessionId:'scan',frameId:1,observationId:'a',captureOrder:10,captureTime:1,phase:'input' as const,slot:0};
  const a={group:4,source},b={group:4,source:{...source,frameId:2,observationId:'b'}};
  assert.notEqual(unidentifiedDisplayKey(a,0),unidentifiedDisplayKey(b,1));
  assert.equal(unidentifiedDisplayKey(a,0),unidentifiedDisplayKey(a,99),'list order is not observation identity');
  assert.notEqual(unidentifiedDisplayKey({group:4},0),unidentifiedDisplayKey(a,0));
  assert.notEqual(unidentifiedDisplayKey({},0),unidentifiedDisplayKey({},1),'legacy ungrouped items remain distinct');
});

test('a pending input without a published card remains visible once without inventing another identity',()=>{
  const entries=[{id:'existing',image:'a'},{id:'unmatched',image:'b'},
    {id:'unmatched',image:'c'},{id:'missing',image:'d'}];
  assert.deepEqual(unmatchedPendingFields(entries,[{id:'existing'},{id:'missing'}]),[{id:'unmatched',image:'b'}]);
  assert.deepEqual(unmatchedPendingFields([],[]),[]);
});
