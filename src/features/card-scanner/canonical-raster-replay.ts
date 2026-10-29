import type {ExactEntry,ExactFrame} from './exact-recording-codec';
import {parseCanonicalSourceUse,type CanonicalSourceUse} from './canonical-source-use';
import {parseSourceRasterReceipt,type SourceRasterReceipt} from './source-raster-receipt';

/** Verifies measured acquisition pixels against their physical source and use.
 * Payload integrity is verified separately by exactPixels/readCanonicalFrame.
 * No contract in old recordings means unsupported, never an inferred match. */
export class CanonicalRasterReplay {
 private declared=false;
 private deferredFailure:string|undefined;
 private useCount=0;
 private frames=new Map<number,Pick<ExactFrame,'id'|'width'|'height'|'time'|'hash'|'canonical'>>();
 private uses=new Map<number,CanonicalSourceUse>();
 private receipts=new Map<number,SourceRasterReceipt>();
 private invalid(reason:string){if(this.declared)throw Error(reason);this.deferredFailure??=reason;}
 accept(entry:ExactEntry){
  if(entry.kind==='frame'){
   if(this.frames.has(entry.id)||this.frames.size>=10_000){this.invalid('중복 또는 과도한 판독 원본');return;}
   this.frames.set(entry.id,{id:entry.id,width:entry.width,height:entry.height,time:entry.time,hash:entry.hash,canonical:entry.canonical});return;
  }
  if(entry.type==='canonical-raster-contract'){
   const value=entry.value as Record<string,unknown>|null;
   if(this.declared||!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).length!==1||value.version!==1)
    throw Error('잘못된 판독 픽셀 계약');
   this.declared=true;
   if(this.deferredFailure)throw Error(this.deferredFailure);
  }else if(entry.type==='canonical-source-use'){
   const value=parseCanonicalSourceUse(entry.value);
   this.useCount++;
   if(this.uses.has(value.acquisitionFrameId)||this.uses.size>=20_000){this.invalid('중복 또는 과도한 판독 사용');return;}
   this.uses.set(value.acquisitionFrameId,value);
  }else if(entry.type==='canonical-raster-receipt'){
   const value=parseSourceRasterReceipt(entry.value);
   if(this.receipts.has(value.acquisitionFrameId)||this.receipts.size>=20_000)throw Error('중복 또는 과도한 판독 픽셀 영수증');
   this.receipts.set(value.acquisitionFrameId,value);
  }
 }
 summary(recordingComplete:boolean){
  if(!this.declared){
   if(this.receipts.size)throw Error('계약 없는 판독 픽셀 영수증');
   return {supported:false,complete:false,matches:null,uses:this.useCount,measured:0,verified:0};
  }
  let verified=0,measured=0,reused=0;
  for(const receipt of this.receipts.values()){
   const use=this.uses.get(receipt.acquisitionFrameId),source=this.frames.get(receipt.sourceFrameId);
   if(!use||!source||source.canonical!==true||use.sourceFrameId!==receipt.sourceFrameId||
    use.captureTime!==receipt.captureTime||source.time!==receipt.captureTime||source.width!==receipt.width||source.height!==receipt.height||source.hash!==receipt.hash)
    throw Error('판독 픽셀과 원본·사용 연결 불일치');
   if(receipt.kind==='analysis-reused'){
    const origin=this.receipts.get(receipt.originAcquisitionFrameId);
    if(!origin||origin.kind!=='measured'||origin.acquisitionFrameId>=receipt.acquisitionFrameId||
      origin.sourceFrameId!==receipt.sourceFrameId||origin.captureTime!==receipt.captureTime||origin.width!==receipt.width||origin.height!==receipt.height||origin.hash!==receipt.hash)
      throw Error('재사용 분석과 실제 측정 원본 연결 불일치');
    reused++;
   }else measured++;
   verified++;
  }
  const complete=recordingComplete&&this.uses.size>0&&verified===this.uses.size;
  if(recordingComplete&&!complete)throw Error('완료 기록의 판독 픽셀 근거 누락');
  return {supported:true,complete,matches:complete?true:null,uses:this.uses.size,measured,...(reused?{reused}:{}),verified};
 }
}
