import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutoCompletionHold,canStopSharing,type CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {CompletionDrainReservation} from '../src/features/card-scanner/session/completion-drain-reservation';
import {CompletionViewSnapshot,commitWithCurrentView,type CompletionView} from '../src/features/card-scanner/session/completion-current-view';
import {createLiveInputAdmission} from '../src/features/card-scanner/capture/live-input-admission';

// Synthetic orchestration of the actual reservation, pixel comparison,
// admission and completion primitives. It is not scanner.ts, a browser media
// pipeline, physical frame provenance, or a real screen-sharing test.
const original=[12,24,36,255,48,60,72,255];
const changed=[12,24,36,255,48,60,73,255];
const view=(inputId:number,pixels:number[]):CompletionView=>({sessionId:'scenario',inputId,captureTime:inputId,
  geometry:'2x1-roi',width:2,height:1,pixels:Uint8Array.from(pixels)});
const ready=():CaptureCompletion=>({expected:1,finalExpected:1,headerAvailable:true,inputSettled:true,fieldChangesSettled:true,unresolved:0,dropped:0,
  cards:[{id:'a',name:'a',awakening:0,extraCopies:0,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
  latest:new Map([['a',1]]),confirmed:new Map([['a',1]]),confirmedNames:new Map([['a',1]])});

function scenario(timeoutMs=500) {
  let stopped=0,headerTotal:number|null=null,acceptedHeader=0;
  let pixels=original,recordedId=1;
  const releases:string[]=[],hold=new AutoCompletionHold(),input=ready(),reference=new CompletionViewSnapshot(view(1,original));
  const admission=createLiveInputAdmission(),first=admission.stamp(1,1);
  assert.equal(admission.consider(first,{capturing:true,checkingCompletion:false}).kind,'freeze');
  admission.frozen(first,{succeeded:true,freezeMs:1});
  assert.equal(hold.observe(input,0),false);assert.equal(hold.observe(input,1000),true);
  const reservation=new CompletionDrainReservation(reason=>{headerTotal=null;releases.push(reason);},timeoutMs);
  const token=reservation.start();
  return {
    token,releases,
    arrive(next:number[],observed=true){
      pixels=next;
      const stamp=admission.stamp(++recordedId,recordedId*100);
      // In scanner.ts a guarded callback compares the current view before
      // admission. A blind callback is intentionally not called a comparison.
      if(observed&&reservation.active&&!reference.matches(view(stamp.inputId,pixels),stamp.inputId))
        reservation.finish(reservation.id,'invalidated');
      const decision=admission.consider(stamp,{capturing:true,checkingCompletion:reservation.active});
      if(decision.kind==='freeze')admission.frozen(stamp,{succeeded:true,freezeMs:1});
      return decision.kind==='freeze'?'freeze':decision.reason;
    },
    header(id:number,total:number){if(!reservation.valid(id))return false;headerTotal=total;acceptedHeader++;return true;},
    commit(id:number,override:Partial<CaptureCompletion>={}){
      if(!reservation.valid(id)||headerTotal===null)return false;
      const last=admission.snapshot().lastConsideredId;
      return commitWithCurrentView(reference,last,()=>view(last,pixels),
        ()=>canStopSharing({...input,...override,finalExpected:headerTotal}),()=>{stopped++;reservation.finish(id,'finished');});
    },
    dispose(){reservation.dispose();},
    snapshot(){return {stopped,acceptedHeader,active:reservation.active};},
  };
}

test('guarded changed pixels reopen admission and a later return cannot revive the old OCR token',()=>{
 const s=scenario();
 assert.equal(s.arrive(changed),'freeze');
 assert.deepEqual(s.releases,['invalidated']);
 assert.equal(s.arrive(original),'freeze');
 assert.equal(s.header(s.token,1),false,'a delayed header cannot certify the retired reservation');
 assert.equal(s.commit(s.token),false);assert.equal(s.snapshot().stopped,0);s.dispose();
});

test('matching callbacks and a matching final sample commit only with the current verified header',()=>{
 const s=scenario();assert.equal(s.arrive(original),'verification');
 assert.equal(s.header(s.token,1),true);assert.equal(s.commit(s.token),true);
 assert.deepEqual(s.snapshot(),{stopped:1,acceptedHeader:1,active:false});
 assert.deepEqual(s.releases,['finished']);s.dispose();
});

test('unsettled input, stale fields, missing header, or inconsistent count cannot be certified by matching pixels',()=>{
 for(const change of [
  {inputSettled:false},{fieldChangesSettled:false},{headerAvailable:false},{expected:2},
  {confirmed:new Map<string,number>()},{confirmedNames:new Map<string,number>()},
  {cards:[{...ready().cards[0],extraCopies:null,countReliable:false}]},
 ] as Partial<CaptureCompletion>[]) {
  const s=scenario();s.arrive(original);s.header(s.token,1);
  assert.equal(s.commit(s.token,change),false);assert.equal(s.snapshot().stopped,0);s.dispose();
 }
 const mismatch=scenario();mismatch.arrive(original);mismatch.header(mismatch.token,2);
 assert.equal(mismatch.commit(mismatch.token),false);mismatch.dispose();
 const missing=scenario();missing.arrive(original);assert.equal(missing.commit(missing.token),false);missing.dispose();
});

test('expiration and cancellation discard delayed header results and permit further input',async()=>{
 const expired=scenario(20);await new Promise(resolve=>setTimeout(resolve,60));
 assert.deepEqual(expired.releases,['expired']);assert.equal(expired.header(expired.token,1),false);
 assert.equal(expired.commit(expired.token),false);assert.equal(expired.arrive(original),'freeze');expired.dispose();
 const cancelled=scenario();cancelled.dispose();assert.deepEqual(cancelled.releases,['disposed']);
 assert.equal(cancelled.header(cancelled.token,1),false);assert.equal(cancelled.commit(cancelled.token),false);
});

test('legacy unbuffered blind callbacks cannot reveal a changed-then-restored frame from the final sample',()=>{
 const s=scenario();assert.equal(s.arrive(changed,false),'verification');assert.equal(s.arrive(original,false),'verification');
 assert.equal(s.header(s.token,1),true);
 // Characterizes an unbuffered historical scenario only. It does not model
 // or bypass the current scanner's buffer and drain-input-loss debt.
 assert.equal(s.commit(s.token),true);assert.equal(s.snapshot().stopped,1);s.dispose();
});
