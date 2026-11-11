import {exactReplayFrames} from './exact-recording-codec';
import {recordedFrames} from '../capture/continuous-capture';
import {RGBA_WINDOW_POLICY} from './rgba-window-policy';
import {replaySettings,replayNameConfiguration,replayDevRecognitionOptions,type DevRecognitionOptions,type ReproductionFile} from './scan-reproduction';
import type {ScannerNameConfiguration} from '../session/scanner-name-configuration';
import {exactStreamDeclaredComplete} from './reproduction-coverage';

/** Explicit DEV runner opt-in; missing settings remain unknown. */
export function devReplayRecognitionOptions(name:ScannerNameConfiguration,recorded:DevRecognitionOptions|undefined,
  requested:{fractionalPortrait:boolean;grayNameFallback:boolean}={fractionalPortrait:false,grayNameFallback:false}) {
  if(requested.fractionalPortrait||requested.grayNameFallback)
    throw Error('저장된 입력은 URL의 개발 판독 옵션 없이 실행하세요.');
  if(recorded&&(name.rawResultPolicy==='continue'||name.contrastNameFallback)&&
    (recorded.fractionalPortrait||recorded.grayNameFallback))
    throw Error('기록된 이름 판독 설정과 개발 판독 설정을 함께 적용할 수 없습니다.');
  return Object.freeze({recorded:recorded??null,applied:Object.freeze({
    fractionalPortrait:recorded?.fractionalPortrait??false,grayNameFallback:recorded?.grayNameFallback??false,
  }),scope:'recognition-retries-only' as const});
}

/** Shared pixel input for app and development replay; never substitutes saved results. */
export function reproductionInput(file:ReproductionFile,signal:AbortSignal,onVerified?:(count:number)=>void){
  signal.throwIfAborted();
  const replay=replaySettings(file);
  const completeStream=exactStreamDeclaredComplete(file.metadata);
  const {configuration,recorded}=replayNameConfiguration(file);
  return {
    seed:structuredClone(replay.seed),
    configurationRecorded:recorded,
    // Provenance only. The ordinary app does not enable DEV experiments;
    // the development runner explicitly validates and opts in separately.
    devRecognitionOptions:replayDevRecognitionOptions(file),
    options:{
      nameConfiguration:configuration,
      replay,
      replayInputs:file.exact
        ?exactReplayFrames(file.exact,signal,onVerified,
          completeStream?file.metadata.exact?.frames:undefined,
          !completeStream,file.metadata.version===5?1:0,
          file.metadata.version===6?RGBA_WINDOW_POLICY:undefined)
        :recordedFrames({blob:file.video,duration:file.metadata.duration},signal),
    },
  };
}
