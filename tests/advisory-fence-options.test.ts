import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAdvisoryFence,validateAdvisoryFenceInput} from '../dev/latest-pixel-gate-report';
const valid={enabled:true,images:false,replay:false,mode:'live',captureOnly:false,cropRecording:false,recording:false,batch:false,caseId:'registered',mediaTypes:['video/mp4']};
test('advisory fence query is explicitly enabled and rejects other experiments',()=>{
 assert.equal(parseAdvisoryFence(''),false);assert.equal(parseAdvisoryFence('?advisoryFence=0'),false);
 assert.equal(parseAdvisoryFence('?advisoryFence=1'),true);
 for(const query of ['?advisoryFence=1&advisoryFence=1','?advisoryFence=1&fps=30','?advisoryFence=yes'])assert.throws(()=>parseAdvisoryFence(query));
});
test('advisory fence only runs a registered single video through live recognition',()=>{
 assert.doesNotThrow(()=>validateAdvisoryFenceInput(valid));
 for(const change of [{images:true},{replay:true},{mode:'offline'},{captureOnly:true},{cropRecording:true},{recording:true},{batch:true},{caseId:null},{mediaTypes:[]},{mediaTypes:['image/png']},{mediaTypes:['video/mp4','video/mp4']}])
  assert.throws(()=>validateAdvisoryFenceInput({...valid,...change}));
 assert.doesNotThrow(()=>validateAdvisoryFenceInput({...valid,enabled:false,replay:true,mode:'offline'}));
});
