import {createElement} from 'react';

/** State replay and source pixels need independently recorded complete totals. */
export function ExecutionCompletenessNotice({complete}:{complete:boolean|null}) {
  if(complete===true)return createElement('p',{className:'muted'},
    '실행 기록이 종료된 것으로 표시됩니다. 저장되지 않은 화면과 판독 정확도는 확인하지 않습니다.');
  return createElement('p',{className:'notice'},complete===false
    ?'부분 기록입니다. 남아 있는 상태만 재생하며 원래 실행과의 전체 일치는 확인할 수 없습니다.'
    :'기록 전체 여부를 확인할 수 없습니다. 남아 있는 상태만 재생하며 원래 실행과의 전체 일치는 미확인입니다.');
}
