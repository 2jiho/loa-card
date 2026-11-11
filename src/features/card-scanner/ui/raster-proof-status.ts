/** Header/event evidence and decoded pixel integrity are separate checks. */
export interface RasterProofSummary {
 readonly recordingComplete:boolean|null;
 readonly rasterProof?:{readonly supported:boolean;readonly complete:boolean;readonly matches:boolean|null;readonly uses:number;readonly verified:number};
}
export type RasterProofStatus='unverified'|'unsupported'|'incomplete'|'matched'|'failed';

export function rasterProofStatus(input:{hasExact:boolean;inspectionFailed:boolean;summary:RasterProofSummary|null}):RasterProofStatus {
 if(!input.hasExact)return 'unsupported';
 if(input.inspectionFailed)return 'failed';
 if(!input.summary)return 'unverified';
 const proof=input.summary.rasterProof;
 if(!proof?.supported)return 'unsupported';
 if(input.summary.recordingComplete!==true||proof.complete!==true)return 'incomplete';
 if(proof.matches!==true||proof.uses<1||proof.verified!==proof.uses)return 'failed';
 return 'matched';
}

export function rasterProofMessage(status:RasterProofStatus):string {
 switch(status){
  case 'unverified':return '판독 입력과 저장 픽셀의 일치 여부 미확인 · 원래 실행 기록을 확인해 주세요.';
  case 'unsupported':return '판독 입력과 저장 픽셀의 일치 검증 미지원 · 이 기록에는 필요한 근거가 없습니다.';
  case 'incomplete':return '판독 입력과 저장 픽셀의 일치 미확인 · 근거 또는 기록이 불완전합니다.';
  case 'failed':return '판독 입력 검증 실패 또는 기록 불일치 · 상세 오류를 확인해 주세요.';
  case 'matched':return '기록된 판독 입력과 저장 픽셀의 해시 연결 일치 · 실제 저장 픽셀의 손상 여부는 재판독 시 별도 검사합니다.';
 }
}
