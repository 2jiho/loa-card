export function ScanReadProgress({completed,expected}:{completed:number;expected:number|null}) {
  const total=expected!==null&&Number.isInteger(expected)&&expected>0?expected:null;
  const label=`판독 완료 ${completed.toLocaleString('ko-KR')} / ${total?.toLocaleString('ko-KR') ?? '—'}종`;
  return <div className="scan-read-progress">
    <span>{label}</span>
    {total!==null ? <progress aria-label="카드 판독 진행" aria-valuetext={label} max={total} value={Math.min(completed,total)} />
      : <small>보관함 수량 확인 중</small>}
  </div>;
}
