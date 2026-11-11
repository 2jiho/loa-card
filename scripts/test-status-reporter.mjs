import {relative} from 'node:path';

// Node treats a failing TODO as a successful test run. Report that distinction
// explicitly; the exit status remains Node's and npm test is unchanged.
export default async function* report(source) {
  let summary;
  for await (const event of source) {
    const {type,data}=event;
    if ((type==='test:fail'||type==='test:pass') && data.details?.type==='test') {
      const location=data.file?relative(process.cwd(),data.file):'(unknown file)';
      const label=`${location}: ${data.name}`;
      if (data.skip!==undefined && data.skip!==false) {
        yield `건너뜀: ${label}\n`;
      } else if (data.todo!==undefined && data.todo!==false) {
        yield `${type==='test:fail'?'실패한 TODO':'통과한 TODO (상태 검토 필요)'}: ${label}\n`;
      } else if (type==='test:fail') {
        const error=data.details.error?.cause ?? data.details.error;
        yield `실패: ${label}${error?.message?`\n  ${error.message}`:''}\n`;
      }
    }
    if (type==='test:summary' && !data.file) summary=data;
  }
  if (!summary) {
    yield '전체 테스트 요약을 받지 못했습니다. 실행 결과를 확인하세요.\n';
    return;
  }
  const {tests,passed,failed,skipped,todo,cancelled}=summary.counts;
  yield `테스트 ${tests}개 · 통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped} · TODO ${todo} · 취소 ${cancelled}\n`;
  yield '테스트 통과만으로 독립적인 인식 정확도나 실제 화면 공유 성능을 증명할 수 없습니다.\n';
}
