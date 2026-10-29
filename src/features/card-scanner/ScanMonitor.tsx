import {memo,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import Button from '@mui/material/Button';
import PictureInPictureAltOutlined from '@mui/icons-material/PictureInPictureAltOutlined';
import type {ScanMonitorState,ScanMonitorStore} from './scan-monitor-store';
import {projectScanMonitorState} from './scan-monitor-store';
import {scanMonitorOutcome,scanMonitorRecentCounts} from './scan-monitor-outcome';
import {gridReady,isLockedInventorySlot,type ScanGridCell} from './scan-grid';
import {commitScanMonitorFeedback} from './scan-monitor-feedback-dom';
import type {ScannerFeedback} from './scanner-feedback';
import styles from './scan-monitor.css?inline';

type PipApi={requestWindow(options:{width:number;height:number}):Promise<Window>};
type Props={state:ScanMonitorState|null;busy:boolean;sharing:boolean;onStop:()=>void;feedback?:ScannerFeedback};
type RowProps={row:number;inventory:ScanGridCell[]|undefined;capacity:number|null|undefined;expected:number|null|undefined};
const labels={unknown:'위치 기록 없음 · 카드 미판독을 뜻하지 않음',waiting:'판독 대기',reading:'판독 중',read:'완료',review:'다시 보여주기',empty:'카드 없음'};

const MonitorRow=memo(function MonitorRow({row,inventory,capacity,expected}:RowProps) {
  return <div role="row" className="monitor-map-row"><span role="rowheader">{row+1}</span>{Array.from({length:10},(_,column)=>{
    const cell=inventory?.[row*10+column],status=isLockedInventorySlot(row*10+column,capacity,expected)?'empty':cell?.status??'unknown';
    const label=(row+1)+'행 '+(column+1)+'열 · '+labels[status];
    return <span role="cell" className={'monitor-dot is-'+status} key={column} title={label+(status!=='empty'&&cell?.reason?' · '+cell.reason:'')} aria-label={label}>{status==='review'?'!':status==='read'?'✓':status==='reading'?'•':''}</span>;
  })}</div>;
},(previous,next)=>{
  if(previous.row!==next.row||previous.capacity!==next.capacity||previous.expected!==next.expected)return false;
  if(previous.inventory===next.inventory)return true;
  for(let column=0;column<10;column++){
    const index=next.row*10+column,a=previous.inventory?.[index],b=next.inventory?.[index];
    if(a?.status!==b?.status||a?.reason!==b?.reason||a?.row!==b?.row)return false;
  }
  return true;
});

const MonitorRows=memo(function MonitorRows({inventory,capacity,expected}:{inventory:ScanGridCell[]|undefined;capacity:number|null|undefined;expected:number|null|undefined}) {
  return <>{Array.from({length:55},(_,row)=><MonitorRow key={row} row={row} inventory={inventory} capacity={capacity} expected={expected}/>)}</>;
});

const emptyCaptureCells:ScanGridCell[]=Array.from({length:40},()=>({status:'unknown'}));
const RecentFrame=memo(function RecentFrame({cells=emptyCaptureCells}:{cells?:ScanGridCell[]}) {
  return <div className="monitor-capture" aria-label="최근 수집한 화면의 40칸">
    <span title="가장 최근에 수집한 화면입니다. 전체 보관함 위치가 연결되기 전에도 판독 상태를 표시합니다.">최근 수집 화면</span>
    <div className="monitor-capture-cells" role="table" aria-label="최근 수집 화면 4행 10열">
      {Array.from({length:4},(_,row)=><div role="row" key={row}>{cells.slice(row*10,row*10+10).map((cell,column)=>{
        const label=`수집 화면 ${row+1}행 ${column+1}열 · ${cell.status==='unknown'?'판독 정보 없음':labels[cell.status]}`;
        return <span key={column} role="cell" data-monitor-recent-slot={row*10+column} className={'monitor-dot is-'+cell.status} title={label+(cell.reason?' · '+cell.reason:'')} aria-label={label}>{cell.status==='read'?'✓':cell.status==='reading'?'•':cell.status==='review'?'!':''}</span>;
      })}</div>)}
    </div>
  </div>;
});

export function ScanMonitorPanel({state:input,busy,sharing,onStop,feedback}:Props) {
  const root=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{commitScanMonitorFeedback(root.current,input,feedback,{busy,sharing});},[input,feedback,busy,sharing]);
  const state=input?projectScanMonitorState(input):null;
  const outcome=scanMonitorOutcome(state,{busy,sharing});
  const grid=state?.grid;
  const recent=scanMonitorRecentCounts(grid);
  const complete=outcome.kind==='complete';
  const count=state?.currentRunRead??0,total=state?.expected;
  const mapped=grid?.inventory?.filter(cell=>cell.status==='read').length??0;
  const rows=55;
  const tops=grid?.located?grid.cells.flatMap((c,i)=>c.row===undefined?[]:[c.row-Math.floor(i/10)]):[];
  const registeredTop=tops.length&&tops.every(r=>r===tops[0])?tops[0]:undefined;
  const top=grid?.liveTracking?grid.liveTop:registeredTop??(grid?.located?grid.estimatedTop:undefined);
  const estimated=top!==undefined&&top!==registeredTop;
  const ready=sharing&&gridReady(grid)&&(!grid?.liveTracking||top!==undefined&&top===registeredTop);
  const located=grid?.located||grid?.liveTracking&&top!==undefined;
  const message=outcome.kind!=='active'?outcome.message:!sharing?'남은 카드를 읽고 있어요':!located?'카드 성장 탭을 보여 주세요':ready?'아래로 스크롤하세요':'잠깐 멈춰 주세요';
  return <section ref={root} className="scan-monitor" aria-label="실시간 스캔 진행">
    <header><strong>LoaCard <small>스캔 진행</small></strong><span>{outcome.header}</span></header>
    <div className={'monitor-action '+(ready||complete?'is-ready':'')} role="status"><strong>{message}</strong></div>
    {outcome.detail&&<p className="monitor-pending">{outcome.detail}</p>}
    <div className="monitor-total"><span>전체 카드 판독</span><strong>{count}<small> / {total??'—'}종</small></strong></div>
    {!!total&&<progress value={count} max={total} aria-label="전체 카드 판독"/>}
    {busy&&<div className="monitor-work" role="group" aria-label="판독 작업 상태">
      <span>판독 대기 <b>{state?.queued??0}</b>건</span>
      <span>판독 중 <b>{state?.activeReadings??0}</b>건</span>
    </div>}
    {busy&&!!recent?.captured&&<div className="monitor-recent" aria-label="최근 수집 화면 판독 상태">
      <span>최근 화면 {recent.captured}칸</span>
      <strong className="is-read">✓ 완료 {recent.read}</strong>
      {!!recent.waiting&&<span className="is-waiting">판독 대기 {recent.waiting}</span>}
      {!!(recent.reading??0)&&<strong className="is-reading">판독 중 {recent.reading??0}</strong>}
      {!!recent.review&&<span className="is-review">확인 필요 {recent.review}</span>}
      {!!recent.unknown&&<span>판독 정보 없음 {recent.unknown}</span>}
      {!!recent.empty&&<span>카드 없음 {recent.empty}</span>}
    </div>}
    {busy&&<RecentFrame cells={grid?.recentFrame?.cells}/>}
    {outcome.showGrid?<>
      <div className="monitor-grid-title"><b>보관함 · 최대 550칸</b><span>{sharing?(top!==undefined?(estimated?'약 ':'')+top+'–'+Math.min(rows,top+3)+'행 보는 중':'행 위치 확인 중'):'위치 기록'}</span></div>
      <div className="monitor-map" role="table" aria-label={'전체 '+rows+'행 10열 카드 위치'}>
        {sharing&&top!==undefined&&<div data-monitor-viewport-top={top} className={'monitor-viewport'+(estimated?' is-estimated':'')} style={{transform:'translateY('+((top-1)*12)+'px)',height:Math.min(4,rows-top+1)*12}} aria-hidden="true"/>}
        <MonitorRows inventory={grid?.inventory} capacity={state?.capacity} expected={state?.expected}/>
      </div>
      <div className="monitor-legend"><span><i className="is-unknown"/>위치 기록 없음</span><span><i className="is-waiting"/>판독 대기</span><span><i className="is-reading"/>판독 중</span><span><i className="is-read"/>완료</span><span><i className="is-review"/>다시 보기</span><span><i className="is-empty"/>카드 없음</span></div>
      <small className="monitor-estimate">{complete?`위치 연결 ${mapped}/${total}`:sharing&&top===undefined?'맨 위부터 겹치는 행이 보이도록 스크롤해 주세요.':'빈 표시: 위치 미확인 · 판독 실패를 뜻하지 않아요.'}</small>
    </>:<p className="monitor-pending">스크롤 범위를 확인하면 전체 카드 위치가 표시돼요.</p>}
    {sharing&&<footer><small>진행 창은 카드 영역 밖에 두세요.</small><button onClick={onStop}>공유 중지</button></footer>}
  </section>;
}

function LiveScanMonitorPanel(props:Props&{store:ScanMonitorStore;inline?:boolean;forceVisible?:boolean}) {
  const live=useSyncExternalStore(props.store.subscribe,props.store.getSnapshot);
  // The scanner publishes this store synchronously. Full list props can still
  // be an older React transition when an urgent busy=false update commits.
  // Start/reset/import/restore clear the store before replacing that session.
  const state=live??props.state,outcome=scanMonitorOutcome(state,{busy:props.busy,sharing:props.sharing});
  if(props.inline&&!props.busy&&!props.sharing&&!props.forceVisible&&outcome.kind!=='review'&&outcome.kind!=='interrupted')return null;
  return <ScanMonitorPanel {...props} state={state} feedback={live?props.store.getFeedback():undefined}/>;
}

export function ScanMonitor(props:Props&{store:ScanMonitorStore}) {
  const [pip,setPip]=useState<Window|null>(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
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
      const style=win.document.createElement('style');style.textContent=styles+'body{margin:0;background:#161a20}';win.document.head.append(style);
      current.current=win;
      win.addEventListener('pagehide',()=>{if(current.current===win){current.current=null;if(mounted.current){setPip(null);setError('진행 창이 닫혔습니다. 이 페이지에서도 진행 상태를 확인할 수 있어요.');}}},{once:true});
      setPip(win);
    }catch{if(mounted.current)setError('진행 창을 열지 못했습니다. 아래에서 진행 상태를 확인해 주세요.');}
    finally{if(mounted.current)setOpening(false);}
  };
  return <div className="scan-monitor-host">
    <style>{styles}</style>
    <Button startIcon={<PictureInPictureAltOutlined/>} disabled={opening} onClick={()=>void open()}>{pip?'진행 창 보기':'진행 창 띄우기'}</Button>
    {error&&<p role="status">{error} {!props.busy&&<button className="text-button" onClick={()=>setError('')}>진행 표시 닫기</button>}</p>}
    {!pip&&<LiveScanMonitorPanel {...props} inline forceVisible={!!error}/>}
    {pip&&createPortal(<LiveScanMonitorPanel {...props}/>,pip.document.body)}
  </div>;
}
