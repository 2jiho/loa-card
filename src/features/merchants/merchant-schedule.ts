// Korean mainland schedule supplied 2026-10-08; provenance in docs/merchant-alerts.md.
// A session belongs to the weekday on which it starts, including 22:00–03:30.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST = 9 * HOUR;
export const MERCHANT_HOURS = [4, 10, 16, 22] as const;
export type ScheduleGroup = 1 | 2 | 3;
const morningGroups: readonly (readonly ScheduleGroup[])[] = [[1,3],[1,2],[2,3],[1,2],[2],[1],[3]];
const regionGroups: Readonly<Record<string, ScheduleGroup>> = {
  'merchant-1':1, 'merchant-9':1, 'merchant-12':1, 'merchant-15':1,
  'merchant-16':1, 'merchant-17':1, 'merchant-21':1, 'merchant-22':1,
  'merchant-2':2, 'merchant-4':2, 'merchant-7':2, 'merchant-10':2,
  'merchant-13':2, 'merchant-18':2, 'merchant-20':2,
  'merchant-3':3, 'merchant-5':3, 'merchant-6':3, 'merchant-8':3,
  'merchant-11':3, 'merchant-14':3, 'merchant-19':3,
};
export interface MerchantSession { start: number; end: number; groups: readonly ScheduleGroup[] }
function dayStart(now: number) { return Math.floor((now + KST) / DAY) * DAY - KST; }
export function merchantSessions(now: number): MerchantSession[] {
  if (!Number.isFinite(now)) return [];
  const today = dayStart(now);
  return [-1,0,1,2].flatMap(offset => {
    const day = today + offset * DAY;
    const morning = morningGroups[new Date(day + KST).getUTCDay()];
    const evening = ([1,2,3] as const).filter(group => !morning.includes(group));
    return MERCHANT_HOURS.map(hour => ({start:day + hour * HOUR, end:day + (hour + 5.5) * HOUR,
      groups:hour === 4 || hour === 16 ? morning : evening}));
  });
}
export function merchantSchedule(id: string, now: number) {
  const group = regionGroups[id];
  if (!group || !Number.isFinite(now)) return null;
  const sessions = merchantSessions(now).filter(session => session.groups.includes(group));
  return {group, current:sessions.find(s => s.start <= now && now < s.end),
    next:sessions.find(s => s.start > now),
    today:sessions.filter(s => dayStart(s.start) === dayStart(now))};
}
export function koreanTime(timestamp: number) {
  const date = new Date(timestamp + KST);
  return `${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;
}
export function sessionTime(session: MerchantSession) {
  return `${koreanTime(session.start)}–${dayStart(session.start) === dayStart(session.end) ? '' : '다음 날 '}${koreanTime(session.end)}`;
}
export function relativeKoreanTime(timestamp: number, now: number) {
  const days = (dayStart(timestamp) - dayStart(now)) / DAY;
  return `${days === -1 ? '어제' : days === 0 ? '오늘' : days === 1 ? '내일' : `${new Date(timestamp+KST).getUTCMonth()+1}/${new Date(timestamp+KST).getUTCDate()}`} ${koreanTime(timestamp)}`;
}
export function remainingTime(timestamp: number, now: number) {
  const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes/60)}시간${minutes%60 ? ` ${minutes%60}분` : ''}` : `${minutes}분`;
}
