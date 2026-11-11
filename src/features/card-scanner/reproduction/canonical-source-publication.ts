import type {CanonicalRasterReceipt} from './canonical-capture';

type Phase='input'|'recovery';
type CanonicalSource={use(sourceFrameId:number|undefined,acquisitionFrameId:number,phase:Phase,captureTime:number,receipt?:CanonicalRasterReceipt):void};
type MissingSource={kind:'source-unavailable'|'ephemeral-unrecorded';sourceFrameId:number|null;acquisitionFrameId:number;phase:Phase;captureTime:number};

/** Publish the gap and independently downgrade the producer even if a
 * diagnostic sink fails. Missing input must not suppress source draining. */
export function reportCanonicalSourceGap(value:MissingSource,trace:(value:MissingSource)=>void,
  recorder?:{missingInput(reason:string):void}):void {
  try{trace(value);}catch{/* Optional diagnostics cannot interrupt acquisition. */}
  try{recorder?.missingInput('수집에 사용한 원본 입력이 기록되지 않았습니다.');}catch{/* Recording cannot stop scanning. */}
}

/** Record the physical source of an acquired frame, or explicitly report the
 * absence of a durable one. This owns no frames or collection history. */
export function publishCanonicalSource(source:CanonicalSource|undefined,sourceFrameId:number|undefined,acquisitionFrameId:number,
  phase:Phase,captureTime:number,receipt:CanonicalRasterReceipt|undefined,options:{recordingExpected:boolean;preparedPersistent?:boolean},
  report:(fact:MissingSource)=>void):void {
  if(!source)return;
  if(sourceFrameId===undefined){
    // The internal temporary store is also used when no exact recording was
    // requested. Only claim missing *recorded* input when one was requested.
    if(options.recordingExpected)report({kind:'source-unavailable',sourceFrameId:null,acquisitionFrameId,phase,captureTime});
    return;
  }
  if(options.preparedPersistent===false){
    report({kind:'ephemeral-unrecorded',sourceFrameId,acquisitionFrameId,phase,captureTime});
    return;
  }
  source.use(sourceFrameId,acquisitionFrameId,phase,captureTime,receipt);
}
