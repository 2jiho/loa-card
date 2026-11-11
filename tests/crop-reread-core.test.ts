import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cropRereadPlan,diagnosticIdentityComparison} from '../dev/crop-reread-core';
import type {RecognitionInputMeta} from '../src/features/card-scanner/recognition/recognition-input-observer';
import type {SavedOutcome} from '../dev/crop-reread-core';

const meta={stage:'short'} as RecognitionInputMeta;
const result:SavedOutcome={admitted:true,identifyExecuted:true,timedOut:false,error:null,status:'read',
 identified:{id:'123',name:'카드'},acceptedIdentity:{id:'123',name:'카드'}};
test('단건 재판독은 미승인과 유지된 이름 경로를 식별 재현으로 취급하지 않는다',()=>{
 assert.equal(cropRereadPlan(meta,{...result,admitted:false}).kind,'unsupported');
 assert.equal(cropRereadPlan(meta,{...result,identifyExecuted:false}).kind,'unsupported');
 assert.equal(cropRereadPlan({...meta,stage:'visual'},result).kind,'visual');
 assert.equal(cropRereadPlan(meta,result).kind,'identity');
});
test('이름 ID 비교는 진단으로 유지하고 양쪽 미식별은 일치로 확정하지 않는다',()=>{
 assert.equal(diagnosticIdentityComparison(result,{id:'123',name:'카드'}).same,true);
 assert.equal(diagnosticIdentityComparison(result,{id:'124',name:'카드'}).same,false);
 assert.equal(diagnosticIdentityComparison({...result,identified:null},null).same,null);
});
