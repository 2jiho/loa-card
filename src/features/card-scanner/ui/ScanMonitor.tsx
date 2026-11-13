import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import Button from '@mui/material/Button';
import PictureInPictureAltOutlined from '@mui/icons-material/PictureInPictureAltOutlined';
import type {ScanMonitorState,ScanMonitorStore} from './scan-monitor-store';
import {projectScanMonitorState} from './scan-monitor-store';
import {scanMonitorOutcome} from '../session/scan-monitor-outcome';
import type {ListGuidanceMap} from '../session/list-guidance';
import styles from '../scan-monitor.css?inline';

type PipApi={requestWindow(options:{width:number;height:number}):Promise<Window>};
type Props={state:ScanMonitorState|null;busy:boolean;sharing:boolean;engineReady?:boolean;onStop:()=>void;
  /** In the separate progress window: the panel takes the window and the list map its free height. */
  fill?:boolean};

/** What to do now, in a few words. Where to go is shown on the list map (highlighted rows), not
 * spelled out as a number of rows. */
export function monitorAction(outcome:{kind:string;message:string},sharing:boolean,state:ScanMonitorState|null):{message:string;ready:boolean} {
  if(outcome.kind!=='active')return {message:outcome.message,ready:outcome.kind==='complete'};
  if(!sharing)return {message:'남은 카드를 읽고 있어요',ready:false};
  if(state?.located===false)return {message:'카드 성장 탭을 보여 주세요',ready:false};
  const targets=state?.map?.targets??[];
  if(targets.some(target=>target.kind!=='unseen'))return {message:'강조된 미확인 부분을 다시 비춰 주세요',ready:true};
  if(targets.length)return {message:'목록을 천천히 끝까지 넘겨 주세요',ready:false};
  const total=state?.expected,read=state?.currentRunRead??0;
  if(total!=null&&total>0&&read>=total)return {message:'카드 정보를 확인하고 있어요',ready:false};
  return {message:'목록을 천천히 끝까지 넘겨 주세요',ready:false};
}

/** The list map's height on the page. In the separate progress window it fills the window's height. */
const MAP_HEIGHT=300;
/** The whole list top to bottom, as the game scrolls: rows to show again (a card or cell to read
 * again, or a row not seen yet) and the rows on the screen now. */
function MonitorListMap({map,sharing,fill}:{map:ListGuidanceMap;sharing:boolean;fill?:boolean}) {
  const {totalRows,visibleRows,targets}=map,currentRow=sharing?map.currentRow:null;
  if(!totalRows)return null;
  // Places are shares of the bar, so the bar can take any height.
  const top=(row:number)=>`${row/totalRows*100}%`,span=(rows:number)=>`${rows/totalRows*100}%`;
  const counts={card:0,cell:0,unseen:0};for(const target of targets)counts[target.kind]++;
  const doneRows=(map.done??[]).reduce((sum,run)=>sum+run.to-run.from+1,0);
  const empty=map.emptyFrom!==undefined&&map.emptyFrom<(map.lockedFrom??totalRows)?{from:map.emptyFrom+1,to:map.lockedFrom??totalRows}:null;
  const screen=currentRow===null?null:{from:currentRow+1,to:Math.min(totalRows,currentRow+visibleRows)};
  return <div className={'monitor-list'+(fill?' is-fill':'')} role="img" aria-label={`목록 지도: 다시 볼 줄 ${targets.length}곳${screen?`, 지금 화면 ${screen.from}~${screen.to}번째 줄`:''}`}>
    <div className="monitor-list-bar" style={fill?undefined:{height:MAP_HEIGHT}} aria-hidden="true">
      {map.emptyFrom!==undefined&&<span className="monitor-list-band is-empty" style={{top:top(map.emptyFrom),height:span((map.lockedFrom??totalRows)-map.emptyFrom)}}/>}
      {map.lockedFrom!==undefined&&<span className="monitor-list-band is-locked" style={{top:top(map.lockedFrom),height:span(totalRows-map.lockedFrom)}}/>}
      {(map.done??[]).map(run=><span key={'d'+run.from} className="monitor-list-done" style={{top:top(run.from),height:span(run.to+1-run.from)}}/>)}
      {targets.map(target=><span key={target.row} className={'monitor-list-target is-'+target.kind} style={{top:top(target.row),height:`max(2px,${span(1)})`}}/>)}
      {currentRow!==null&&<span className="monitor-list-screen" style={{top:top(currentRow),height:`max(6px,${span(visibleRows)})`}}/>}
    </div>
    <div className="monitor-list-side" aria-hidden="true">
      <span>1번째 줄</span>
      <div className="monitor-list-legend">
        <p className={screen?'':'is-off'}><i className="is-screen"/>지금 화면 {screen?`${screen.from}~${screen.to}번째 줄`:'—'}</p>
        <p className={counts.card?'is-strong':'is-off'}><i className="is-card"/>장수·각성 확인 필요 {counts.card}줄</p>
        <p className={counts.cell?'is-strong':'is-off'}><i className="is-cell"/>카드를 알아보지 못한 칸 {counts.cell}줄</p>
        <p className={counts.unseen?'':'is-off'}><i className="is-unseen"/>아직 안 본 줄 {counts.unseen}줄</p>
        <p><i className="is-done"/>다 읽은 줄 {doneRows}줄</p>
        {/* Always present (a dash until the storage header is read), so the legend does not move. */}
        <p className={empty?'':'is-off'}><i className="is-empty"/>빈칸 {empty?`${empty.from}~${empty.to}번째 줄`:'—'}</p>
        <p className={map.lockedFrom!==undefined?'':'is-off'}><i className="is-locked"/>잠긴 칸 {map.lockedFrom!==undefined?`${map.lockedFrom+1}~${totalRows}번째 줄`:'—'}</p>
      </div>
      <span>{totalRows}번째 줄</span>
    </div>
  </div>;
}

export function ScanMonitorPanel({state:input,busy,sharing,engineReady,onStop,fill}:Props) {
  const state=input?projectScanMonitorState(input):null;
  const preparing=!!busy&&!sharing&&engineReady===false;
  const baseOutcome=scanMonitorOutcome(state,{busy,sharing});
  const outcome=preparing?{...baseOutcome,kind:'active' as const,header:'준비 중',message:'인식 엔진을 준비하고 있어요',
    detail:'준비가 끝나면 카드 화면을 공유해 주세요.'}:baseOutcome;
  const count=state?.currentRunRead??0,total=state?.expected;
  const action=preparing?{message:'인식 엔진을 준비하고 있어요',ready:false}:monitorAction(outcome,sharing,state);
  return <section className={'scan-monitor'+(fill?' is-fill':'')} aria-label="실시간 스캔 진행">
    <header><strong>LoaCard <small>스캔 진행</small></strong><span>{outcome.header}</span></header>
    <div className={'monitor-action '+(action.ready?'is-ready':'')} role="status"><strong>{action.message}</strong></div>
    <p className="monitor-pending">{outcome.detail??''}</p>
    {!preparing&&<div className="monitor-total"><span>확정</span><strong>{count}<small> / {total??'—'}종</small></strong></div>}
    {/* Kept after the share too, so the window does not jump when the scan ends. */}
    {!preparing&&(busy||!!state)&&(()=>{const collected=state?.currentRunNames??count,missing=total==null?null:Math.max(0,total-collected);
      return <div className="monitor-breakdown" role="status">
        <span>이름 미확인 {missing??'—'}종</span>
        <span className={state?.review?'is-review':''}>확인 필요 {state?.review??0}종</span>
        <span>판독 대기 {state?.queued??0}</span>
      </div>;})()}
    {!preparing&&<div className="monitor-progress-slot">{!!total&&<progress value={count} max={total} aria-label="전체 카드 판독"/>}</div>}
    {!preparing&&state?.map&&<MonitorListMap map={state.map} sharing={sharing} fill={fill}/>}
    {sharing&&<footer><small>진행 창은 카드 영역 밖에 두세요. 공유를 종료해도 수집된 카드 판독은 계속됩니다.</small><button onClick={onStop}>공유 종료</button></footer>}
  </section>;
}

function LiveScanMonitorPanel(props:Props&{store:ScanMonitorStore;inline?:boolean;forceVisible?:boolean}) {
  const live=useSyncExternalStore(props.store.subscribe,props.store.getSnapshot);
  // The scanner publishes this store synchronously. Full list props can still
  // be an older React transition when an urgent busy=false update commits.
  // Start/reset/import/restore clear the store before replacing that session.
  const state=live??props.state,outcome=scanMonitorOutcome(state,{busy:props.busy,sharing:props.sharing});
  // On the page, a complete scan is reported by the scan summary above; the panel stays only when
  // something is left to check. The separate progress window keeps its last state until closed.
  if(props.inline&&!props.busy&&!props.sharing&&!props.forceVisible&&outcome.kind!=='review'&&outcome.kind!=='interrupted')return null;
  return <ScanMonitorPanel {...props} state={state}/>;
}

export function ScanMonitor(props:Props&{store:ScanMonitorStore}) {
  const [pip,setPip]=useState<Window|null>(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
  const canOpen=props.busy||props.sharing||(props.state?.currentRunRead??0)>0||props.state?.expected!=null;
  const current=useRef<Window|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;current.current?.close();};},[]);
  const open=async()=>{
    if(current.current&&!current.current.closed){current.current.focus();return;}
    const api=(window as Window&{documentPictureInPicture?:PipApi}).documentPictureInPicture;
    if(!api){setError('이 브라우저는 항상 위 진행 창을 지원하지 않습니다. 아래에서 진행 상태를 확인해 주세요.');return;}
    setOpening(true);setError('');
    try {
      const win=await api.requestWindow({width:340,height:860});
      if(!mounted.current){win.close();return;}
      win.document.title='LoaCard · 스캔 진행';
      win.document.documentElement.lang='ko';
      const style=win.document.createElement('style');style.textContent=styles+'html,body{height:100%;margin:0;background:#161a20}';win.document.head.append(style);
      current.current=win;
      win.addEventListener('pagehide',()=>{if(current.current===win){current.current=null;if(mounted.current){setPip(null);setError('진행 창이 닫혔습니다. 이 페이지에서도 진행 상태를 확인할 수 있어요.');}}},{once:true});
      setPip(win);
    }catch{if(mounted.current)setError('진행 창을 열지 못했습니다. 아래에서 진행 상태를 확인해 주세요.');}
    finally{if(mounted.current)setOpening(false);}
  };
  return <div className="scan-monitor-host">
    <style>{styles}</style>
    <Button startIcon={<PictureInPictureAltOutlined/>} disabled={opening||!canOpen} title={canOpen?undefined:'스캔을 시작하면 진행 창을 열 수 있습니다.'} onClick={()=>void open()}>{pip?'진행 창 보기':'진행 창 띄우기'}</Button>
    {error&&<p role="status">{error} {!props.busy&&<button className="text-button" onClick={()=>setError('')}>진행 표시 닫기</button>}</p>}
    {!pip&&<LiveScanMonitorPanel {...props} inline forceVisible={!!error}/>}
    {pip&&createPortal(<LiveScanMonitorPanel {...props} fill/>,pip.document.body)}
  </div>;
}
