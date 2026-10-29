import {parseInventoryHeaderFact} from './scroll-capture-diagnostic';
import type {CaptureFrameIdentity,InventoryHeaderFact,ScrollDiagnosticBox} from './scroll-capture-diagnostic';

export interface CapturedHeaderRegion {readonly source:CaptureFrameIdentity;readonly headerBox:ScrollDiagnosticBox}
type Total={owned:number;capacity:number};

/** Header pixels are copied by the caller before an asynchronous read starts.
 * Keep the matching source/box at that boundary, not whatever frame is current
 * when the OCR promise completes. Diagnostics cannot change the OCR outcome. */
export function createCapturedHeaderReads(emit:(fact:InventoryHeaderFact)=>boolean,onFailure:(error:unknown)=>void=()=>{}){
  let sequence=0,latestFactId:number|null=null;
  const fail=(error:unknown)=>{try{onFailure(error);}catch{/* Optional diagnostics. */}};
  return {
    get latestFactId(){return latestFactId;},
    async read<T extends Total|null>(origin:CapturedHeaderRegion|undefined,purpose:InventoryHeaderFact['purpose'],operation:()=>Promise<T>):Promise<T>{
      const factId=++sequence;
      let captured:CapturedHeaderRegion|undefined;
      try{if(origin)captured={source:{...origin.source},headerBox:{...origin.headerBox}};}catch(error){fail(error);}
      const total=await operation();
      if(total&&captured)try{
        const fact=parseInventoryHeaderFact({version:1,factId,source:captured.source,purpose,headerBox:captured.headerBox,
          owned:total.owned,capacity:total.capacity});
        // Invocation order is not capture chronology. The reference merely
        // identifies the latest successful request available to later frames.
        if(emit(fact))latestFactId=Math.max(latestFactId??0,factId);
      }catch(error){fail(error);}
      return total;
    },
  };
}
