import AccessTimeOutlined from '@mui/icons-material/AccessTimeOutlined';
import {merchantSessions, koreanTime, sessionTime, remainingTime,relativeKoreanTime} from './merchant-schedule';

export function MerchantSchedule({now}:{now:number}) {
  const sessions = merchantSessions(now);
  const current = sessions.find(s => s.start <= now && now < s.end);
  const next = sessions.find(s => s.start > now);
  // Find today's four sessions even while yesterday's last session is active.
  const today = sessions.slice(4,8);
  return <aside className="merchant-schedule" aria-label="떠돌이 상인 시간표">
    <div className="merchant-schedule-heading"><strong><AccessTimeOutlined fontSize="small" /> 오늘 시간표 <small>한국 시간</small></strong>
      <span>{current ? `${relativeKoreanTime(current.start,now)} 회차 · ${koreanTime(current.end)} 종료 · ${remainingTime(current.end,now)} 남음` : next ? `${koreanTime(next.start)} 등장 · ${remainingTime(next.start,now)} 후` : ''}</span>
    </div>
    <div className="merchant-sessions">{today.map(session => <div key={session.start} className={current?.start===session.start?'is-active':''}>
      <strong>{sessionTime(session)}</strong><small>{session.groups.join('·')}그룹</small>
    </div>)}</div>
    <p>하루 2번, 한 번에 5시간 30분 열려요. 시간표로 계산한 것이라 실제로 파는 카드는 게임에서 확인해 주세요.</p>
  </aside>;
}
