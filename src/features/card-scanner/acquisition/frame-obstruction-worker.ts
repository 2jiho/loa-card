import {frameObstructionCandidates} from './frame-obstruction-candidate';
import type {ObstructionCell} from './frame-obstruction-candidate';

/** A hash attests only the bytes of this ROI, not capture time, ordering or
 * physical source. WebCrypto may make an additional internal copy. */
export type ObstructionRoiHash={status:'ok'|'failed';algorithm:'sha256';hex:string|null;hashMs:number;scope:'roi-rgba-content-only';captureTimeVerified:false;physicalSourceVerified:false;reason?:string};
/** The transferred ROI is a single bounded, immutable acquisition copy. */
let busy=false;
const failedHash=(reason:string,hashMs=0):ObstructionRoiHash=>({status:'failed',algorithm:'sha256',hex:null,hashMs,
  scope:'roi-rgba-content-only',captureTimeVerified:false,physicalSourceVerified:false,reason});
self.onmessage=async(event:MessageEvent<{id:number;time:number;roi:{x:number;y:number;width:number;height:number};readbackMs:number;readbackBytes:number;pixels:Uint8ClampedArray;width:number;height:number;cells:ObstructionCell[];hashRoi?:boolean}>)=>{
  const started=performance.now();
  const value=event.data;
  if(busy){self.postMessage({id:value.id,time:value.time,roi:value.roi,readbackMs:value.readbackMs,readbackBytes:value.readbackBytes,error:'diagnostic-worker-busy',result:null,computeMs:0,
    ...(value.hashRoi?{roiHash:failedHash('diagnostic-worker-busy')}:{})});return;}
  busy=true;
  try{
    const result=frameObstructionCandidates(value.pixels,value.width,value.height,value.cells);
    const computeMs=performance.now()-started;
    let roiHash:ObstructionRoiHash|undefined;
    if(value.hashRoi){
      const hashStarted=performance.now();
      try{
        if(!result||!(value.pixels instanceof Uint8ClampedArray)||!(value.pixels.buffer instanceof ArrayBuffer)||
          value.pixels.byteLength!==value.width*value.height*4||value.pixels.byteLength>8*1024*1024||
          value.readbackBytes!==value.pixels.byteLength||value.roi.width!==value.width||value.roi.height!==value.height)throw Error('invalid-roi');
        const bytes=new Uint8Array(value.pixels.buffer,value.pixels.byteOffset,value.pixels.byteLength);
        const digest=await crypto.subtle.digest('SHA-256',bytes);
        roiHash={status:'ok',algorithm:'sha256',hex:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),
          hashMs:performance.now()-hashStarted,scope:'roi-rgba-content-only',captureTimeVerified:false,physicalSourceVerified:false};
      }catch(error){roiHash=failedHash(String(error).slice(0,200),performance.now()-hashStarted);}
    }
    self.postMessage({id:value.id,time:value.time,roi:value.roi,readbackMs:value.readbackMs,readbackBytes:value.readbackBytes,result,computeMs,...(roiHash?{roiHash}:{})});
  }catch(error){self.postMessage({id:value.id,time:value.time,roi:value.roi,readbackMs:value.readbackMs,readbackBytes:value.readbackBytes,error:String(error).slice(0,300),result:null,computeMs:performance.now()-started,
    ...(value.hashRoi?{roiHash:failedHash('analysis-failed')}:{})});}
  finally{busy=false;}
};
