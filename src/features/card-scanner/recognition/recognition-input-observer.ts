import type {NameAttempt} from './name-diagnostics';
import type {ObservationSource} from '../session/observation-execution';

export interface RecognitionBox {x:number;y:number;width:number;height:number}
/** Diagnostic identity only. It is not a recorded execution attempt ID. */
export interface RecognitionInputMeta {
  diagnosticReadId:number;processingFrame:number;slot:number;
  source:ObservationSource;group:number;trace:number;pixelKey:string;
  stage:'visual'|'short'|'full';stable:boolean;borderAlignment:number;
  sourceBox:RecognitionBox;sourceWidth:number;sourceHeight:number;
  cropWidth:number;cropHeight:number;
}
/** Initial canvas label before masks/resizing. This is not the model tensor. */
export interface NameLabelRecipe {
  region:'initial-name-label';sourceBox:RecognitionBox;
  targetWidth:128;targetHeight:36;offsetY:number;
  quick:boolean;allowRaw:boolean;bypassCache:boolean;
}
export interface RecognitionPixels {width:number;height:number;data:Uint8ClampedArray}
/** Optional diagnostic claim, supplied by the acquisition client. This is
 * never an identity, successful model execution or completion proof. */
export interface ReaderCropClaim {
  readonly frame:{readonly version:1;readonly kind:'measured';readonly sourceFrameId:number;readonly acquisitionFrameId:number;
    readonly captureTime:number;readonly width:number;readonly height:number;readonly hash:string};
  readonly crop:{readonly slot:number;readonly content:RecognitionBox;readonly sha256:string};
}
export interface RecognitionInputOutcome {
  admitted:boolean;identifyExecuted:boolean;nameMatchCount:number;
  /** An admission refusal has no reserved budget, not a 3-second budget. */
  budgetRemainingAtStart:number|null;budgetRemainingAtEnd:number|null;
  elapsedMs:number;timedOut:boolean;error:string|null;
  identified:{id:string;name:string;review:string[];confidence:number}|null;
  acceptedIdentity:{id:string;name:string}|null;status:string;retained:boolean;
  diagnostics:NameAttempt[];
}
/** Diagnostic only: never read a stand-in budget as if it was reserved. */
export function reservedRecognitionBudget(attempt:{budget:{remaining():number}}|null|undefined):number|null {
  return attempt?.budget.remaining()??null;
}
export interface RecognitionInspection {
  /** Actual candidate canvas immediately before recognition. Borrowed only during this call. */
  captureInput?(canvas:HTMLCanvasElement,claim?:ReaderCropClaim):void;
  /** Borrowed until this call returns. Copy synchronously if retaining it. */
  captureCard(canvas:HTMLCanvasElement):void;
  /** Reader-owned RGBA must never be mutated or transferred. */
  captureLabel(pixels:RecognitionPixels,recipe:NameLabelRecipe):void;
  finish(outcome:RecognitionInputOutcome):void;
}
export interface RecognitionInputObserver {
  begin(meta:RecognitionInputMeta):RecognitionInspection|undefined;
}
/** Optional diagnostics must not reject a card or change its retry schedule. */
export function beginRecognitionInspection(observer:RecognitionInputObserver|undefined,meta:RecognitionInputMeta):RecognitionInspection|undefined {
  let inspection:RecognitionInspection|undefined;
  try{inspection=observer?.begin(meta);}catch{return undefined;}
  if(!inspection)return undefined;
  return {
    captureInput(canvas,claim){try{inspection.captureInput?.(canvas,claim);}catch{/* Optional evidence only. */}},
    captureCard(canvas){try{inspection.captureCard(canvas);}catch{/* Optional evidence only. */}},
    captureLabel(pixels,recipe){try{inspection.captureLabel(pixels,recipe);}catch{/* Optional evidence only. */}},
    finish(outcome){try{inspection.finish(outcome);}catch{/* Optional evidence only. */}},
  };
}
export type NameLabelObserver=(pixels:RecognitionPixels,recipe:NameLabelRecipe)=>void;
export function observeNameLabel(observer:NameLabelObserver|undefined,pixels:RecognitionPixels,recipe:NameLabelRecipe){
  try{observer?.(pixels,recipe);}catch{/* Debug retention cannot reject OCR. */}
}
