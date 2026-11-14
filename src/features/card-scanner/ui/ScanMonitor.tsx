import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import Button from '@mui/material/Button';
import PictureInPictureAltOutlined from '@mui/icons-material/PictureInPictureAltOutlined';
import type {ScanMonitorState,ScanMonitorStore} from './scan-monitor-store';
import {projectScanMonitorState} from './scan-monitor-store';
import {monitorAction} from './monitor-action';
import {scanMonitorOutcome} from '../session/scan-monitor-outcome';
import type {ListGuidanceMap} from '../session/list-guidance';
import styles from '../scan-monitor.css?inline';

type PipApi={requestWindow(options:{width:number;height:number}):Promise<Window>};
type Props={state:ScanMonitorState|null;busy:boolean;sharing:boolean;engineReady?:boolean;onStop:()=>void;
  /** In the separate progress window: the panel takes the window and the list map its free height. */
  fill?:boolean};


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
        <p className={counts.card?'is-strong':'is-off'}><i className="is-card"/>각성·장수 못 읽음 {counts.card}줄</p>
        <p className={counts.cell?'is-strong':'is-off'}><i className="is-cell"/>카드 이름 못 읽음 {counts.cell}줄</p>
        <p className={counts.unseen?'':'is-off'}><i className="is-unseen"/>아직 안 봄 {counts.unseen}줄</p>
        <p><i className="is-done"/>다 읽음 {doneRows}줄</p>
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
  const outcome=preparing?{...baseOutcome,kind:'active' as const,header:'준비 중',message:'스캔을 준비하고 있어요',
    detail:'준비가 끝나면 게임의 카드 성장 탭 화면을 공유해 주세요.'}:baseOutcome;
  const count=state?.currentRunRead??0,total=state?.expected;
  const action=preparing?{message:'스캔을 준비하고 있어요',ready:false}:monitorAction(outcome,sharing,state);
  return <section className={'scan-monitor'+(fill?' is-fill':'')} aria-label="스캔 진행 상황">
    <header><strong>LoaCard <small>스캔 진행</small></strong><span>{outcome.header}</span></header>
    <div className={'monitor-action '+(action.ready?'is-ready':'')} role="status"><strong>{action.message}</strong></div>
    <p className="monitor-pending">{outcome.detail??''}</p>
    {!preparing&&<div className="monitor-total"><span>읽기 완료</span><strong>{count}<small> / {total??'—'}종</small></strong></div>}
    {/* Kept after the share too, so the window does not jump when the scan ends. */}
    {!preparing&&(busy||!!state)&&(()=>{const collected=state?.currentRunNames??count,missing=total==null?null:Math.max(0,total-collected);
      // Cards not confirmed yet are progress while the scan runs; what is left to check is counted once it ends.
      const review=busy?0:state?.review??0;
      return <div className="monitor-breakdown" role="status">
        <span>{busy?'이름 남음':'이름 못 읽음'} {missing??'—'}종</span>
        <span className={review?'is-review':''}>값 못 읽음 {review}종</span>
        <span>읽기 대기 {state?.queued??0}개</span>
      </div>;})()}
    {!preparing&&<div className="monitor-progress-slot">{!!total&&<progress value={count} max={total} aria-label="전체 카드 읽기 진행"/>}</div>}
    {!preparing&&state?.map&&<MonitorListMap map={state.map} sharing={sharing} fill={fill}/>}
    {sharing&&<footer><small>진행 창이 카드를 가리지 않게 두세요. 공유를 끝내도 이미 받은 화면은 계속 읽어요.</small><button onClick={onStop}>공유 종료</button></footer>}
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
    if(!api){setError('이 브라우저에서는 진행 창을 따로 띄울 수 없어요. 진행 상황은 이 페이지 아래에 보여요.');return;}
    setOpening(true);setError('');
    try {
      const win=await api.requestWindow({width:340,height:860});
      if(!mounted.current){win.close();return;}
      win.document.title='LoaCard · 스캔 진행';
      win.document.documentElement.lang='ko';
      const style=win.document.createElement('style');style.textContent=styles+'html,body{height:100%;margin:0;background:#161a20}';win.document.head.append(style);
      current.current=win;
      win.addEventListener('pagehide',()=>{if(current.current===win){current.current=null;if(mounted.current){setPip(null);setError('진행 창이 닫혔어요. 진행 상황은 이 페이지 아래에도 보여요.');}}},{once:true});
      setPip(win);
    }catch{if(mounted.current)setError('진행 창을 열지 못했어요. 진행 상황은 이 페이지 아래에 보여요.');}
    finally{if(mounted.current)setOpening(false);}
  };
  return <div className="scan-monitor-host">
    <style>{styles}</style>
    <Button startIcon={<PictureInPictureAltOutlined/>} disabled={opening||!canOpen} title={canOpen?undefined:'스캔을 시작하면 진행 창을 띄울 수 있어요.'} onClick={()=>void open()}>{pip?'진행 창 보기':'진행 창 띄우기'}</Button>
    {error&&<p role="status">{error} {!props.busy&&<button className="text-button" onClick={()=>setError('')}>진행 표시 닫기</button>}</p>}
    {!pip&&<LiveScanMonitorPanel {...props} inline forceVisible={!!error}/>}
    {pip&&createPortal(<LiveScanMonitorPanel {...props} fill/>,pip.document.body)}
  </div>;
}
