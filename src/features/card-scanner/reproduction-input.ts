import {exactReplayFrames} from './exact-recording-codec';
import {recordedFrames} from './continuous-capture';
import {RGBA_WINDOW_POLICY} from './rgba-window-policy';
import {replaySettings,replayNameConfiguration,type ReproductionFile} from './scan-reproduction';

/** Shared pixel input for app and development replay; never substitutes saved results. */
export function reproductionInput(file:ReproductionFile,signal:AbortSignal,onVerified?:(count:number)=>void){
  signal.throwIfAborted();
  const replay=replaySettings(file);
  const {configuration,recorded}=replayNameConfiguration(file);
  return {
    seed:structuredClone(replay.seed),
    configurationRecorded:recorded,
    options:{
      nameConfiguration:configuration,
      replay,
      replayInputs:file.exact
        ?exactReplayFrames(file.exact,signal,onVerified,
          file.metadata.exact?.complete?file.metadata.exact.frames:undefined,
          file.metadata.exact?.complete===false,file.metadata.version===5?1:0,
          file.metadata.version===6?RGBA_WINDOW_POLICY:undefined)
        :recordedFrames({blob:file.video,duration:file.metadata.duration},signal),
    },
  };
}
