/** Metadata describes the recorder's claim. It never authenticates stored
 * bytes or proves every live input was received; decoding verifies the stream. */
export type RecordedCoverage = 'declared-complete'|'partial'|'unknown';
export interface CoverageMetadata {
 readonly completed?:boolean; readonly recordState?:string;
 readonly exact?:{readonly complete?:boolean;readonly dropped?:number|null;readonly error?:string;readonly frames?:number};
}

/** Independent of session completion: an interrupted session can contain a
 * structurally complete exact stream, but that is still a partial session. */
export function exactStreamDeclaredComplete(metadata:CoverageMetadata):boolean {
 const e=metadata.exact;
 return !!e&&e.complete===true&&e.dropped===0&&e.error===''&&Number.isSafeInteger(e.frames)&&e.frames!>0;
}

/** Missing older fields are unknown, never evidence of zero dropped frames. */
export function recordedCoverage(metadata:CoverageMetadata):RecordedCoverage {
 const e=metadata.exact;
 if(metadata.completed===false||metadata.recordState==='partial'||metadata.recordState==='failed'||
   e?.complete===false||typeof e?.dropped==='number'&&e.dropped>0||typeof e?.error==='string'&&e.error!=='')return 'partial';
 if(metadata.completed===true&&metadata.recordState==='complete'&&exactStreamDeclaredComplete(metadata))return 'declared-complete';
 return 'unknown';
}

export function recordedCoverageLabel(metadata:CoverageMetadata):string {
 switch(recordedCoverage(metadata)) {
  case 'declared-complete':return '기록 종료로 표시됨 · 전체 화면 보존 미확인';
  case 'partial':return '부분 또는 실패한 입력 기록';
  case 'unknown':return '입력 기록 범위 미확인';
 }
}

/** Presentation only; the presence of a section is not an integrity audit. */
export function replayInputScope(hasExact:boolean,hasVideo:boolean,hasExactFrames=true):string {
 if(hasExact&&!hasExactFrames)return '저장된 입력 프레임이 없어 재판독할 수 없습니다.'+
  (hasVideo?' 압축 영상은 미리보기로만 제공됩니다.':'');
 if(hasExact)return '저장된 선택·획득 화면의 픽셀과 기록 시각으로 다시 판독합니다. 저장되지 않은 화면과 당시 실시간 처리 속도는 재현하지 못합니다.'+
  (hasVideo?' 미리보기 압축 영상은 판독에 쓰는 픽셀과 다를 수 있습니다.':'');
 if(hasVideo)return '이전 형식의 압축 영상으로 다시 판독합니다. 원래 입력 픽셀과 실시간 처리 속도는 같지 않을 수 있습니다.';
 return '재현할 픽셀이나 영상 입력이 없습니다.';
}
