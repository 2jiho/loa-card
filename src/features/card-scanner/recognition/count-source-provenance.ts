import {parseObservationFact,type ObservationSource} from '../session/observation-execution';
import {parseSourceRasterReceipt,type SourceRasterReceipt} from '../acquisition/source-raster-receipt';
import type {CountObservationSource} from './count-confidence';

/** Measured raster metadata describes one acquisition, not a physical-device
 * attestation. A parsed or replayed receipt never becomes a private authority. */
export interface CountProvenanceEvent {readonly version:1;readonly source:ObservationSource;readonly raster:SourceRasterReceipt|null}
export interface CountProvenanceResult {readonly source:CountObservationSource;readonly relation:'missing'|'measured'|'reused';
 readonly physicalSourceVerified:false;readonly independentRepeatVerified:false}
const LIMIT=4096;
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160;
function event(input:CountProvenanceEvent):CountProvenanceEvent {
 if(!input||typeof input!=='object'||input.version!==1||Object.keys(input).sort().join(',')!=='raster,source,version')throw Error('Invalid count provenance event');
 const source=parseObservationFact({version:1,kind:'queued',attemptId:0,source:input.source}).source;
 const raster=input.raster===null?null:parseSourceRasterReceipt(input.raster);
 if(raster&&(raster.acquisitionFrameId!==source.frameId||raster.captureTime!==source.captureTime))throw Error('Count provenance acquisition mismatch');
 return Object.freeze({version:1,source,raster});
}
/** Independent recorder/reducer. Entries are bounded and never evicted, because
 * eviction would silently permit a later alias. Overflow fails closed. No pixels
 * are retained. The optional receipt callback must be bounded and must report
 * losses separately. Parsing replay events cannot authenticate their producer. */
export class CountSourceProvenance {
 private readonly sessionId:string;private readonly streamId:string;private readonly emit?: (event:CountProvenanceEvent)=>boolean;
 private readonly frames=new Map<number,{time:number;width:number;height:number;hash:string}>();
 private readonly acquisitions=new Map<number,{sourceFrameId:number;time:number;width:number;height:number;hash:string;kind:SourceRasterReceipt['kind'];origin:number|null}>();
 private readonly observations=new Map<string,string>();private failures=0;private closed=false;
 constructor(sessionId:string,streamId:string,emit?:(event:CountProvenanceEvent)=>boolean){
  if(!id(sessionId)||!id(streamId))throw Error('Invalid count provenance session');this.sessionId=sessionId;this.streamId=streamId;this.emit=emit;
 }
 apply(input:CountProvenanceEvent):CountProvenanceResult {
  if(this.closed)throw Error('Count provenance closed');
  try{return this.transition(input);}catch(error){this.failures++;throw error;}
 }
 private transition(input:CountProvenanceEvent):CountProvenanceResult {
  const fact=event(input),s=fact.source,r=fact.raster;if(s.sessionId!==this.sessionId)throw Error('Count provenance session mismatch');
  const alias=JSON.stringify(s),prior=this.observations.get(s.observationId);if(prior&&prior!==alias)throw Error('Count provenance observation alias changed');
  if(!prior&&this.observations.size>=LIMIT)throw Error('Count provenance observation limit');
  if(r){
   const frame=this.frames.get(r.sourceFrameId),acquisition=this.acquisitions.get(r.acquisitionFrameId);
   if(frame&&(frame.time!==r.captureTime||frame.width!==r.width||frame.height!==r.height||frame.hash!==r.hash))throw Error('Count provenance frame alias changed');
   if(acquisition&&(acquisition.sourceFrameId!==r.sourceFrameId||acquisition.time!==r.captureTime||acquisition.width!==r.width||acquisition.height!==r.height||acquisition.hash!==r.hash||acquisition.kind!==r.kind||acquisition.origin!==(r.kind==='analysis-reused'?r.originAcquisitionFrameId:null)))throw Error('Count provenance acquisition alias changed');
   if(!frame&&this.frames.size>=LIMIT||!acquisition&&this.acquisitions.size>=LIMIT)throw Error('Count provenance frame limit');
   if(r.kind==='analysis-reused'){
    const origin=this.acquisitions.get(r.originAcquisitionFrameId);
    if(!origin||origin.kind!=='measured'||origin.sourceFrameId!==r.sourceFrameId||origin.time!==r.captureTime||origin.width!==r.width||origin.height!==r.height||origin.hash!==r.hash)
      throw Error('Count provenance reuse origin unavailable or different');
   }
   if(!frame)this.frames.set(r.sourceFrameId,{time:r.captureTime,width:r.width,height:r.height,hash:r.hash});
   if(!acquisition)this.acquisitions.set(r.acquisitionFrameId,{sourceFrameId:r.sourceFrameId,time:r.captureTime,width:r.width,height:r.height,hash:r.hash,kind:r.kind,origin:r.kind==='analysis-reused'?r.originAcquisitionFrameId:null});
  }
  if(!prior)this.observations.set(s.observationId,alias);
  if(this.emit)try{if(!this.emit(fact))this.failures++;}catch{this.failures++;}
  const source:CountObservationSource=Object.freeze({sessionId:s.sessionId,observationId:s.observationId,captureOrder:s.captureOrder,
   captureTime:s.captureTime,slot:s.slot,canonicalFrameId:r?.sourceFrameId??null,canonicalStreamId:r?this.streamId:null,provenance:'unverified'});
  return {source,relation:r?.kind==='analysis-reused'?'reused':r?'measured':'missing',physicalSourceVerified:false,independentRepeatVerified:false};
 }
 snapshot(){return Object.freeze({version:1 as const,sessionId:this.sessionId,streamId:this.streamId,frames:this.frames.size,
  acquisitions:this.acquisitions.size,observations:this.observations.size,stateRetained:!this.closed,recordingComplete:this.emit?this.failures===0:null,physicalSourceVerified:false as const});}
 clear(){this.closed=true;this.frames.clear();this.acquisitions.clear();this.observations.clear();}
}
