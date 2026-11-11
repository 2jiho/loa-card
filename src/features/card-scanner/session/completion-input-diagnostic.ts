import type {InputStamp, LiveInputAdmissionDecision} from '../capture/live-input-admission';
import {parseLiveCaptureDecision,type LiveCaptureDecision} from '../capture/live-capture-pipeline';

type LossReason='replaced'|'capacity'|'error'|'disposed'|'rejected';
type PipelineEntry={captureTime:number;state:'offered'|'started'|'finished';outcome?:'completed'|'error';replaced?:true};
const reasons:readonly LossReason[]=['replaced','capacity','error','disposed','rejected'];

/** A bounded diagnostic, not freshness or completion evidence. IDs cover
 * callbacks delivered to this process only; they do not attest source frames. */
export class CompletionInputDiagnostic {
 private arrival:InputStamp|null=null;
 private completed:InputStamp|null=null;
 private skipped={ended:0,verification:0,'source-capacity':0,cadence:0};
 private lastSkipped:{[K in keyof CompletionInputDiagnostic['skipped']]:number|null}={ended:null,verification:null,'source-capacity':null,cadence:null};
 private arrivals=0;private complete=0;private failed=0;private gaps=0;private clockErrors=0;private orderErrors=0;
 private callbackMissed=0;private sourceClockUnknown=0;
 private pipelineSeq=0;private pipelineAt=-Infinity;private pipelineErrors=0;
 private pipelineOpen=new Map<number,PipelineEntry>();
 private losses:Record<LossReason,number>={replaced:0,capacity:0,error:0,disposed:0,rejected:0};
 private lastLoss:Record<LossReason,number|null>={replaced:null,capacity:null,error:null,disposed:null,rejected:null};
 private releaseFailures=0;private lastReleaseFailure:number|null=null;
 private increment(value:number,amount=1){return Math.min(Number.MAX_SAFE_INTEGER,value+amount);}

 consider(decision:LiveInputAdmissionDecision, missedFrames:number|undefined):void {
  const stamp=decision.stamp,previous=this.arrival;
  if(!Number.isSafeInteger(stamp.inputId)||stamp.inputId<1||!Number.isFinite(stamp.captureTime)||stamp.captureTime<0||
    !Number.isFinite(stamp.observedAtMs)||stamp.observedAtMs<0){this.orderErrors=this.increment(this.orderErrors);return;}
  if(previous){
   if(stamp.inputId<=previous.inputId)this.orderErrors=this.increment(this.orderErrors);
   else if(stamp.inputId>previous.inputId+1)this.gaps=this.increment(this.gaps,stamp.inputId-previous.inputId-1);
   if(stamp.captureTime<previous.captureTime||stamp.observedAtMs<previous.observedAtMs)this.clockErrors=this.increment(this.clockErrors);
  }else if(stamp.inputId>1)this.gaps=this.increment(this.gaps,stamp.inputId-1);
  if(!previous||stamp.inputId>previous.inputId)this.arrival={...stamp};
  this.arrivals=this.increment(this.arrivals);
  if(decision.kind==='skip'){
   this.skipped[decision.reason]=this.increment(this.skipped[decision.reason]);
   this.lastSkipped[decision.reason]=Math.max(this.lastSkipped[decision.reason]??0,stamp.inputId);
  }
  if(missedFrames===undefined)this.sourceClockUnknown=this.increment(this.sourceClockUnknown);
  else if(Number.isSafeInteger(missedFrames)&&missedFrames>=0)this.callbackMissed=this.increment(this.callbackMissed,missedFrames);
  else this.clockErrors=this.increment(this.clockErrors);
 }
 /** Reports the linked acquisition, not OCR completion or decoded-source identity. */
 finish(stamp:InputStamp,successful:boolean):void {
  if(!Number.isSafeInteger(stamp.inputId)||stamp.inputId<1||!Number.isFinite(stamp.captureTime)||stamp.captureTime<0||
    !Number.isFinite(stamp.observedAtMs)||stamp.observedAtMs<0||!this.arrival||stamp.inputId>this.arrival.inputId){
   this.orderErrors=this.increment(this.orderErrors);return;
  }
  if(stamp.inputId===this.arrival.inputId&&(stamp.captureTime!==this.arrival.captureTime||stamp.observedAtMs!==this.arrival.observedAtMs)){
   this.orderErrors=this.increment(this.orderErrors);return;
  }
  if(!successful){this.failed=this.increment(this.failed);return;}
  this.complete=this.increment(this.complete);
  if(this.completed&&stamp.inputId<this.completed.inputId){this.orderErrors=this.increment(this.orderErrors);return;}
  this.completed={...stamp};
 }
 /** Input pipeline facts are diagnostics, not evidence that a lost frame was
  * unchanged. Track at most one active, two pending and one incoming frame. */
 pipelineDecision(event:LiveCaptureDecision):void {
  const bad=()=>{this.pipelineErrors=this.increment(this.pipelineErrors);};
  try{event=parseLiveCaptureDecision(event);}catch{bad();return;}
  if(!Number.isSafeInteger(event.seq)||event.seq!==this.pipelineSeq+1||
    !Number.isFinite(event.atMs)||event.atMs<0||event.atMs<this.pipelineAt){bad();return;}
  this.pipelineSeq=event.seq;this.pipelineAt=event.atMs;
  if(event.kind==='replaced'){
   const old=this.pipelineOpen.get(event.oldInputId),next=this.pipelineOpen.get(event.newInputId);
   if(!old||old.state!=='offered'||!next||event.oldInputId>=event.newInputId){bad();return;}
   old.replaced=true;return;
  }
  if(!Number.isSafeInteger(event.inputId)||event.inputId<1||!Number.isFinite(event.captureTime)||event.captureTime<0){bad();return;}
  if(event.kind==='offered'){
   const arrival=this.arrival;
   if(!arrival||arrival.inputId!==event.inputId||arrival.captureTime!==event.captureTime||
     arrival.observedAtMs!==event.observedAtMs||event.atMs<event.observedAtMs||
     this.pipelineOpen.has(event.inputId)||this.pipelineOpen.size>=4){bad();return;}
   this.pipelineOpen.set(event.inputId,{captureTime:event.captureTime,state:'offered'});return;
  }
  const entry=this.pipelineOpen.get(event.inputId);
  if(!entry||entry.captureTime!==event.captureTime){bad();return;}
  if(event.kind==='started'){
   if(entry.state!=='offered'||entry.replaced){bad();return;}entry.state='started';return;
  }
  if(event.kind==='finished'){
   if(entry.state!=='started'){bad();return;}entry.state='finished';entry.outcome=event.outcome;return;
  }
  if(event.kind==='released'){
   const valid=event.reason==='normal'?entry.state==='finished'&&entry.outcome==='completed':
     event.reason==='replaced'?entry.state==='offered'&&entry.replaced===true:
     event.reason==='error'?entry.state==='offered'||entry.state==='finished'&&entry.outcome==='error':
     entry.state==='offered'&&!entry.replaced;
   if(!valid){bad();return;}
   if(event.reason!=='normal'){
    this.losses[event.reason]=this.increment(this.losses[event.reason]);
    this.lastLoss[event.reason]=Math.max(this.lastLoss[event.reason]??0,event.inputId);
   }
   if(event.failed){this.releaseFailures=this.increment(this.releaseFailures);this.lastReleaseFailure=Math.max(this.lastReleaseFailure??0,event.inputId);}
   this.pipelineOpen.delete(event.inputId);
  }
 }
 /** The producer explicitly reported that its decision stream was lost. */
 pipelineRecordError():void {this.pipelineErrors=this.increment(this.pipelineErrors);}
 snapshot(){
  const arrival=this.arrival,completed=this.completed;
  const comparable=!!completed&&this.orderErrors===0&&this.clockErrors===0&&this.gaps===0;
  const skippedAfterLastCompletion={
   ended:comparable?this.lastSkipped.ended!==null&&this.lastSkipped.ended>completed!.inputId:null,
   verification:comparable?this.lastSkipped.verification!==null&&this.lastSkipped.verification>completed!.inputId:null,
   'source-capacity':comparable?this.lastSkipped['source-capacity']!==null&&this.lastSkipped['source-capacity']>completed!.inputId:null,
   cadence:comparable?this.lastSkipped.cadence!==null&&this.lastSkipped.cadence>completed!.inputId:null,
  };
  // A replacement or finished consumer must be followed by its release fact.
  // If that event is unavailable, no negative loss comparison is safe.
  const missingRelease=[...this.pipelineOpen.values()].some(entry=>entry.replaced||entry.state==='finished');
  const pipelineComparable=comparable&&this.pipelineSeq>0&&this.pipelineErrors===0&&!missingRelease;
  const newerOpen=comparable?[...this.pipelineOpen.keys()].some(id=>id>completed!.inputId):null;
  const currentOrNewerOpen=comparable?[...this.pipelineOpen.keys()].some(id=>id>=completed!.inputId):null;
  const afterCompletion=(id:number|null):boolean|null=>!pipelineComparable?null:
    id!==null&&id>completed!.inputId?true:newerOpen?null:false;
  // The acquired frame is released *after* collect finishes. A failed release
  // of that same frame is relevant, even though its input ID is equal.
  const releaseFailureAtOrAfterLastAcquisition=!pipelineComparable?null:
    this.lastReleaseFailure!==null&&this.lastReleaseFailure>=completed!.inputId?true:currentOrNewerOpen?null:false;
  const lossesAfterLastCompletion=Object.fromEntries(reasons.map(reason=>
    [reason,afterCompletion(this.lastLoss[reason])])) as Record<LossReason,boolean|null>;
  return {version:1 as const, scope:'delivered-input-only' as const, freshness:'unproven' as const,
   individualHistory:'not-recorded' as const,
   arrivals:this.arrivals,acquisitions:this.complete,failedAcquisitions:this.failed,
   lastArrival:arrival?{inputId:arrival.inputId,captureTime:arrival.captureTime,observedAtMs:arrival.observedAtMs}:null,
   lastCompleted:completed?{inputId:completed.inputId,captureTime:completed.captureTime,observedAtMs:completed.observedAtMs}:null,
   newerDeliveredInput:comparable&&arrival&&completed?arrival.inputId>completed.inputId:null,
   skipped:{...this.skipped},lastSkippedInputId:{...this.lastSkipped},skippedAfterLastCompletion,
   missingArrivalIds:this.gaps,sourceCallbackMissed:this.callbackMissed,
   sourceClockUnknown:this.sourceClockUnknown,clockErrors:this.clockErrors,orderErrors:this.orderErrors,
   pipeline:{events:this.pipelineSeq,errors:this.pipelineErrors,open:this.pipelineOpen.size,newerOpen,missingRelease,
    losses:{...this.losses},lastLossInputId:{...this.lastLoss},lossesAfterLastCompletion,
    releaseFailures:this.releaseFailures,lastReleaseFailureInputId:this.lastReleaseFailure,
    releaseFailureAtOrAfterLastAcquisition}};
 }
}
