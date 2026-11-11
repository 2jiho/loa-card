import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectCapture,preBorderEvidence} from '../src/features/card-scanner/acquisition/capture-quality';
import {UnidentifiedObstructionFence,unidentifiedObstruction} from '../src/features/card-scanner/session/completion-obstruction-debt';
import {FreshObservations} from '../src/features/card-scanner/session/fresh-observation';
import {timedCaptureOrder} from '../src/features/card-scanner/session/live-scan-policy';
import {autoCompletionMessage} from '../src/features/card-scanner/session/auto-completion-diagnostics';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing} from '../src/features/card-scanner/session/auto-completion';

test('real card texture with synthetic tooltip and hidden name produces obstruction evidence; clipped/empty do not',()=>{
 const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8'));
 const sample=samples.find((row:{intact:boolean})=>row.intact),b=sample.box;
 const original=Buffer.from(sample.rgba,'base64'),pixels=new Uint8Array(b.width*b.height*4);
 for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){
  const at=((b.y+y)*sample.width+b.x+x)*4;pixels.set(original.subarray(at,at+4),(y*b.width+x)*4);
 }
 const covered=pixels.slice(),top=Math.round(b.height*.4);
 for(let y=top;y<top+Math.round(b.height*.2);y++)for(let x=0;x<b.width;x++){
  const v=y===top?110:20;covered.set([v,v,v,255],(y*b.width+x)*4);
 }
 for(let x=25;x<60;x+=4)for(let y=top+12;y<top+19;y++)covered.set([200,200,200,255],(y*b.width+x)*4);
 const tooltip=inspectCapture(covered,b.width,b.height,true,true,true,true);
 assert.equal(unidentifiedObstruction({complete:true,intact:false,quality:tooltip,preBorder:preBorderEvidence(tooltip)}),true);
 const hidden=pixels.slice();for(let y=17;y<30;y++)for(let x=12;x<128;x++)hidden.set([20,20,20,255],(y*b.width+x)*4);
 const name=inspectCapture(hidden,b.width,b.height,true,true,true,true);
 assert.equal(preBorderEvidence(name).kind,'name-hidden');
 assert.equal(unidentifiedObstruction({complete:true,intact:true,quality:name,preBorder:preBorderEvidence(name)}),true);
 assert.equal(unidentifiedObstruction({complete:true,intact:false,quality:name,preBorder:preBorderEvidence(name)}),false,'flat locked background is not a known card');
 const clipped=inspectCapture(covered,b.width,b.height,false,true,true,true);
 assert.equal(unidentifiedObstruction({complete:false,intact:false,quality:clipped,preBorder:preBorderEvidence(clipped)}),false);
 assert.equal(unidentifiedObstruction({complete:true,intact:true,quality:{usable:false,reason:'empty',sharpness:0},
  preBorder:{kind:'empty',reason:'미보유 카드 뒷면 · 빈 슬롯'}}),false);
 assert.equal(unidentifiedObstruction({complete:true,intact:true,quality:tooltip}),false,'legacy evidence absence does not invent a cause');
});

test('unknown obstruction stays after scrolling or re-sorting until every card is proven strictly after its captured frame',()=>{
 const fence=new UnidentifiedObstructionFence(),names=new Map<string,number>(),fields=new Map<string,number>(),ids=['a','b'];
 for(const id of ids){names.set(id,timedCaptureOrder(0,1,0));fields.set(id,timedCaptureOrder(0,1,0));}
 fence.notice(2,0);assert.equal(fence.pending(2,ids,names,fields),2);
 // Later slot of same input, matching total, same fuzzy group, empty viewport
 // or a reorder are not input identity/field proofs after the frame boundary.
 names.set('a',timedCaptureOrder(0,2,39));fields.set('a',timedCaptureOrder(0,2,39));
 assert.equal(fence.pending(2,['b','a'],names,fields),2);
 names.set('b',timedCaptureOrder(0,3,0));fields.set('b',timedCaptureOrder(0,3,0));
 assert.equal(fence.pending(2,['b','a'],names,fields),1);
 names.set('a',timedCaptureOrder(0,3,1));
 assert.equal(fence.pending(2,ids,names,fields),1,'name without fresh fields does not settle');
 fields.set('a',timedCaptureOrder(0,3,1));assert.equal(fence.pending(2,ids,names,fields),0);
 fence.notice(4,0);assert.equal(fence.pending(2,ids,names,fields),2,'a newer obstruction renews the debt');
 assert.match(autoCompletionMessage('occluded'),/가려진 카드/);
});

test('duplicate identities, unknown totals and invalid capture chronology remain unresolved',()=>{
 const fence=new UnidentifiedObstructionFence(),names=new Map([['a',1000]]),fields=new Map([['a',1000]]);
 fence.notice(1,0);assert.ok(fence.pending(null,['a'],names,fields));
 assert.ok(fence.pending(2,['a','a'],names,fields));
 fence.notice(NaN,0);assert.ok(fence.pending(1,['a'],names,fields));
 assert.ok(fence.needsProof('a',names,fields));
});

test('an unchanged previously identified crop is reopened for fresh source evidence',()=>{
 const fence=new UnidentifiedObstructionFence(),names=new Map([['a',timedCaptureOrder(0,1,0)]]),fields=new Map(names);
 const old={stable:true,id:'a'},observations=new FreshObservations<typeof old>(5,()=>true);
 observations.remember(3,'pixels',1,old,'fields');observations.finish(old);fence.notice(2,0);
 const retry=observations.retryPlan(3,'pixels',3,true,()=>true,value=>fence.needsProof(value.id,names,fields),'fields');
 assert.equal(retry?.reason,'latest-proof');assert.equal(retry?.exactConfirmed,old);
});

test('latest unnamed obstruction blocks sharing and saved-original shortcuts until every card has newer evidence',()=>{
 const fence=new UnidentifiedObstructionFence(),ids=['a','b'],order=timedCaptureOrder(0,1,0);
 const names=new Map(ids.map(id=>[id,order])),fields=new Map(names),latest=new Map(names);
 const cards=ids.map(id=>({id,name:id,awakening:0,extraCopies:0,countReliable:true,review:[],confidence:1,image:'',time:1,observations:1}));
 const state=()=>({expected:2,finalExpected:2,cards,latest,confirmedNames:names,confirmed:fields,inputSettled:true,headerAvailable:true,unresolved:0,dropped:0,
   fieldChangesSettled:fence.pending(2,ids,names,fields)===0});
 const hold=new AutoCompletionHold();assert.equal(hold.observe(state(),0),false);assert.equal(hold.observe(state(),1000),true);
 fence.notice(2,0);
 assert.equal(canStopSharing(state()),false,'previously confirmed values do not certify the newly obstructed input');
 assert.equal(hold.observe(state(),1001),false);
 const covered=()=>({...state(),inputClosed:true,headerVerified:true,metadataSettled:true,tailFresh:true,dropped:0});
 assert.equal(canSkipCoveredOriginals(covered()),false);
 assert.equal(canFinishEndedCapture({...covered(),pending:0,unresolved:0}),false);
 names.set('a',timedCaptureOrder(0,3,0));fields.set('a',timedCaptureOrder(0,3,0));
 assert.equal(canStopSharing(state()),false,'only one card was reobserved');
 names.set('b',timedCaptureOrder(0,4,0));fields.set('b',timedCaptureOrder(0,4,0));
 assert.equal(canStopSharing(state()),true);
 assert.equal(hold.observe(state(),1100),false,'clearance restarts the hold');
 assert.equal(hold.observe(state(),2100),true);
});
