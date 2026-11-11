import {recordedCoverage,type CoverageMetadata} from '../reproduction/reproduction-coverage';
/** Detailed input recording starts automatically only on the development server. */
export function defaultDetailedRecording(development:boolean):boolean {return development;}

/** A missing input alone cannot prove whether recording was enabled or failed. */
export function noRecordedInputMessage(item:{hasInput:boolean;status:string;record?:boolean}):string|null {
 if(item.hasInput||item.status==='open')return null;
 if(item.record===false)return '상세 입력 기록이 꺼져 있어 입력을 재현할 수 없습니다.';
 if(item.record===true)return '상세 입력이 보관되지 않아 입력을 재현할 수 없습니다.';
 return '입력이 보관되지 않아 재현할 수 없습니다. 당시 기록 설정은 확인되지 않았습니다.';
}

/** A completed pixel stream from an interrupted scan is still a partial session. */
export function detailedRecordingResult(enabled:boolean,file:{metadata:CoverageMetadata}|undefined):string {
 if(!enabled)return '';
 if(!file)return '입력 기록을 확인할 수 없습니다 · 스캔 진단에서 저장 상태 확인';
 const coverage=recordedCoverage(file.metadata);
 return coverage==='declared-complete'?'입력 기록 보관됨 · 스캔 진단에서 확인':
  coverage==='partial'?'부분 입력 기록 보관됨 · 스캔 진단에서 확인':'입력 기록 범위 미확인 · 스캔 진단에서 확인';
}
