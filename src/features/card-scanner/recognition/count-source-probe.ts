import {CountObservations,type CountObservationBarrier,type CountObservationSource} from './count-confidence';
import {CountSourceProvenance,type CountProvenanceEvent} from './count-source-provenance';
import type {ObservationSource} from '../session/observation-execution';
import type {SourceRasterReceipt} from '../acquisition/source-raster-receipt';

export interface CountSourceProbeStats {
  requested:number;measured:number;reused:number;missing:number;mismatch:number;errors:number;
  reads:number;unverified:number;conditional:number;late:number;readWithoutSource:number;
  recordingRequested:boolean;recordingComplete:boolean|null;cleaned:boolean;retainedPixelBytes:number;
}
/** DEV-only adapter. Never returns evidence to recognition/completion policy. */
export class CountSourceProbe {
 private readonly provenance:CountSourceProvenance;private readonly counts=new CountObservations();private closed=false;
 readonly stats:CountSourceProbeStats;
 constructor(privateSession:string,stream:string,emit?: (event:CountProvenanceEvent)=>boolean){
  this.stats={requested:0,measured:0,reused:0,missing:0,mismatch:0,errors:0,reads:0,unverified:0,conditional:0,late:0,readWithoutSource:0,
   recordingRequested:!!emit,recordingComplete:emit?true:null,cleaned:false,retainedPixelBytes:0};
  this.provenance=new CountSourceProvenance(privateSession,stream,emit);this.counts.beginSourceBoundSession(privateSession);
 }
 acquire(source:ObservationSource,receipt:SourceRasterReceipt|undefined):CountObservationSource|undefined{
  if(this.closed)return;this.stats.requested++;
  try {
   let raster:SourceRasterReceipt|null=receipt??null;
   if(raster&&(raster.acquisitionFrameId!==source.frameId||raster.captureTime!==source.captureTime)){this.stats.mismatch++;raster=null;}
   const result=this.provenance.apply({version:1,source,raster});this.stats[result.relation]++;
   this.stats.recordingComplete=this.provenance.snapshot().recordingComplete;return result.source;
  }catch{
   this.stats.errors++;this.stats.recordingComplete=this.provenance.snapshot().recordingComplete;
   // A broken receipt is never repaired by guessing. Keep this slot unbound.
   return;
  }
 }
 read(id:string,source:CountObservationSource|undefined,vector:Uint8Array,input:Parameters<CountObservations['offerSourceBound']>[2],after:CountObservationBarrier):void{
  if(this.closed)return;this.stats.reads++;
  if(!source){this.stats.readWithoutSource++;return;}
  try{const result=this.counts.offerSourceBound(id,vector,input,source,after);this.stats[result.status]++;
   if(result.status==='unverified'&&result.reason==='older than retained evidence')this.stats.late++;
   this.stats.retainedPixelBytes=this.counts.sourceBoundStats().pixelBytes;
  }catch{this.stats.errors++;}
 }
 finish(){if(this.closed)return;this.closed=true;this.stats.recordingComplete=this.provenance.snapshot().recordingComplete;
  this.provenance.clear();this.counts.clearSourceBound();this.stats.retainedPixelBytes=0;this.stats.cleaned=true;}
}
