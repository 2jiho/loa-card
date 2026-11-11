import {parseScannerNameConfiguration,type ScannerNameConfiguration} from '../src/features/card-scanner/session/scanner-name-configuration';
import {parseDevRecognitionOptions,type DevRecognitionOptions} from '../src/features/card-scanner/reproduction/scan-reproduction';

export type ReplayComparisonMode='baseline'|'fractional';

/** Only the explicit, isolated comparison accepts an override. Unknown or
 * repeated URL fields are rejected rather than silently changing the input. */
export function parseReplayComparisonOptions(search:string):ReplayComparisonMode|null {
  const parameters=new URLSearchParams(search),values=parameters.getAll('replayCompare');
  if(!values.length)return null;
  if(values.length!==1||(values[0]!=='baseline'&&values[0]!=='fractional')||
    [...parameters.keys()].some(key=>key!=='replayCompare'))
    throw Error('저장 입력 비교는 replayCompare=baseline 또는 fractional만 단독으로 사용하세요.');
  return values[0];
}

/** This is a new counterfactual read, not a claim about the old scan. Missing
 * recorded options remain null; the applied A/B configuration is explicit. */
export function selectReplayComparison(mode:ReplayComparisonMode,name:ScannerNameConfiguration,
  nameRecorded:boolean,recorded:DevRecognitionOptions|undefined) {
  if(mode!=='baseline'&&mode!=='fractional'||typeof nameRecorded!=='boolean')throw Error('지원하지 않는 저장 입력 비교 설정입니다.');
  const parsedName=parseScannerNameConfiguration(name);
  const parsedRecorded=recorded===undefined?undefined:parseDevRecognitionOptions(recorded);
  if(parsedName.rawResultPolicy!=='resample'||parsedName.contrastNameFallback===true||
    parsedRecorded?.fractionalPortrait===true||parsedRecorded?.grayNameFallback===true)
    throw Error('기록된 다른 판독 실험과 저장 입력 비교는 함께 실행하지 않습니다.');
  return Object.freeze({requested:mode,scope:'stored-input-counterfactual-recognition' as const,
    recordedNameConfiguration:nameRecorded?parsedName:null,
    recordedDevRecognition:parsedRecorded??null,
    appliedNameConfiguration:parsedName,
    applied:Object.freeze({fractionalPortrait:mode==='fractional',grayNameFallback:false})});
}
