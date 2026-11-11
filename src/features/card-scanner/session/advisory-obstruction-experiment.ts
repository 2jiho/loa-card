import {UnidentifiedObstructionFence} from './completion-obstruction-debt';

/** Development-only counterfactual. Advisory is a bounded, sampled heuristic;
 * its absence is never evidence of visibility or coverage. A notice is bound
 * to the acquired slot's session, frame, time and exact pixel key. The shared
 * fence demands fresh name AND field proof for every identity after a notice. */
export interface AdvisorySource {sessionId:string;acquisitionFrameId:number;processingFrame:number;observationId:string;captureTime:number;slot:number;pixelKey:string;phase:'input'|'recovery'}
export interface AdvisoryExperimentSummary {
  scope:'sampled-advisory-not-complete';sampling:'up-to-four-candidates-per-frame';coverage:'unknown';notices:number;pending:number;lastCaptureTime:number|null;
  records:readonly AdvisorySource[];noticeRecordsComplete:boolean;readerPixelsVerified:false;replaySupported:false;
}
export class AdvisoryObstructionExperiment {
  private readonly fence=new UnidentifiedObstructionFence();
  private readonly sessionId:string;private readonly seedOrder:number;private readonly limit:number;
  private readonly records:AdvisorySource[]=[];private notices=0;private lost=false;
  private last:number|null=null;private pendingCount=0;
  constructor(sessionId:string,seedOrder:number,limit=512){
    if(!sessionId||sessionId.length>160||!Number.isSafeInteger(seedOrder)||seedOrder<0||!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid advisory experiment');
    this.sessionId=sessionId;this.seedOrder=seedOrder;this.limit=limit;
  }
  /** Call only when the same acquisition cell positively carries the advisory. */
  notice(source:AdvisorySource):void {
    if(!source||source.sessionId!==this.sessionId||!Number.isSafeInteger(source.acquisitionFrameId)||source.acquisitionFrameId<1||
      !Number.isSafeInteger(source.processingFrame)||source.processingFrame<1||typeof source.observationId!=='string'||!source.observationId||source.observationId.length>160||
      !Number.isFinite(source.captureTime)||source.captureTime<0||!Number.isSafeInteger(source.slot)||source.slot<0||source.slot>=40||
      typeof source.pixelKey!=='string'||!source.pixelKey||source.pixelKey.length>512||!['input','recovery'].includes(source.phase)){
      this.lost=true;return;
    }
    this.fence.notice(source.captureTime,this.seedOrder);
    this.notices++;this.last=Math.max(this.last??-Infinity,source.captureTime);
    if(this.records.length<this.limit)this.records.push(Object.freeze({...source}));else this.lost=true;
  }
  pending(expected:number|null,ids:readonly string[],names:ReadonlyMap<string,number>,fields:ReadonlyMap<string,number>):number {
    const pending=this.fence.pending(expected,ids,names,fields);
    return this.pendingCount=this.lost?Math.max(1,pending):pending;
  }
  needsProof(id:string,names:ReadonlyMap<string,number>,fields:ReadonlyMap<string,number>):boolean {
    return this.lost||this.fence.needsProof(id,names,fields);
  }
  snapshot():AdvisoryExperimentSummary{return {scope:'sampled-advisory-not-complete',sampling:'up-to-four-candidates-per-frame',coverage:'unknown',notices:this.notices,pending:this.pendingCount,
    lastCaptureTime:this.last,records:[...this.records],noticeRecordsComplete:!this.lost,readerPixelsVerified:false,replaySupported:false};}
}
