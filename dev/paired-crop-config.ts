export interface PairedCropTarget {processingFrame:number;slot:number}
/** Processing frame is one based; slot is the scanner's zero based 0..39. */
export function parsePairedCropTargets(value:string|null):PairedCropTarget[] {
  if(value===null)return [];
  if(value.length>160||!/^\d{1,6}:\d{1,2}(,\d{1,6}:\d{1,2}){0,3}$/.test(value))throw Error('pairs는 최대 4개의 처리프레임:칸(0~39) 쌍이어야 합니다.');
  const seen=new Set<string>();
  return value.split(',').map(pair=>{
    const [processingFrame,slot]=pair.split(':').map(Number);
    if(processingFrame<1||slot>39||seen.has(`${processingFrame}:${slot}`))throw Error('pairs의 프레임·칸 범위 또는 중복을 확인하세요.');
    seen.add(`${processingFrame}:${slot}`);return {processingFrame,slot};
  });
}

export interface NormalPairedCropRunContext {
  mode:'offline'|'live';images:boolean;inputCount:number;recording:boolean;captureOnly:boolean;
  preparedSource:boolean;nativeAcquisition:boolean;rgbaRecovery:boolean;fractionalPortrait:boolean;
  fpsRequested:boolean;grayNameFallback:boolean;localCropPixels:boolean;
  nameRawResultPolicy:'resample'|'continue';warmNameReaders:boolean;
}

/** Only for explicit pairs WITHOUT provider. Provider comparisons keep their
 * existing validation; no-pairs runs do not acquire these diagnostic limits. */
export function assertNormalPairedCropRun(context:NormalPairedCropRunContext):void {
  const experiments=[context.preparedSource,context.nativeAcquisition,context.rgbaRecovery,context.fractionalPortrait,
    context.fpsRequested,context.grayNameFallback,context.localCropPixels,context.warmNameReaders];
  if(![context.images,context.recording,context.captureOnly,...experiments].every(value=>typeof value==='boolean')||
    !Number.isSafeInteger(context.inputCount)||context.inputCount<0||
    context.mode!=='offline'&&context.mode!=='live'||context.nameRawResultPolicy!=='resample'&&context.nameRawResultPolicy!=='continue'){
    throw Error('pairs 기본 입력 진단의 실제 실행 설정을 확인하세요.');
  }
  if(context.images||context.mode!=='offline'||context.inputCount!==1||context.recording||context.captureOnly){
    throw Error('provider 없는 pairs 진단은 단일 영상·전체 프레임 순차 판독·세션 저장 끔으로 실행하세요.');
  }
  if(experiments.some(Boolean)||context.nameRawResultPolicy!=='resample'){
    throw Error('provider 없는 pairs 진단은 기본 resample 입력에서 다른 입력·인식·예열 실험 없이 실행하세요.');
  }
}
