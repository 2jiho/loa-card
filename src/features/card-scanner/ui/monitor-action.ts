import type {ScanMonitorState} from './scan-monitor-store';

/** What to do now, in a few words. Where to go is shown on the list map (highlighted rows), not
 * spelled out as a number of rows. */
export function monitorAction(outcome:{kind:string;message:string},sharing:boolean,state:ScanMonitorState|null):{message:string;ready:boolean} {
  if(outcome.kind!=='active')return {message:outcome.message,ready:outcome.kind==='complete'};
  if(!sharing)return {message:'남은 카드를 읽고 있어요',ready:false};
  if(state?.located===false)return {message:'카드 성장 탭을 보여 주세요',ready:false};
  const targets=state?.map?.targets??[];
  if(targets.some(target=>target.kind!=='unseen'))return {message:'지도에 표시된 줄을 다시 보여 주세요',ready:true};
  if(targets.length)return {message:'목록을 천천히 끝까지 넘겨 주세요',ready:false};
  const total=state?.expected,read=state?.currentRunRead??0;
  if(total!=null&&total>0&&read>=total)return {message:'마지막으로 확인하고 있어요',ready:false};
  return {message:'목록을 천천히 끝까지 넘겨 주세요',ready:false};
}
