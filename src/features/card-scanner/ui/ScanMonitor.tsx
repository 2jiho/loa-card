import {memo,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import Button from '@mui/material/Button';
import PictureInPictureAltOutlined from '@mui/icons-material/PictureInPictureAltOutlined';
import type {ScanMonitorState,ScanMonitorStore} from './scan-monitor-store';
import {projectScanMonitorState} from './scan-monitor-store';
import {scanMonitorOutcome,scanMonitorRecentCounts} from '../session/scan-monitor-outcome';
import {estimatedMonitorCell,projectMonitorCell} from './monitor-estimated-cell';
import {gridReady,type ScanGridCell,type ScanGridSnapshot} from '../session/scan-grid';
import {commitScanMonitorFeedback} from './scan-monitor-feedback-dom';
import type {ScannerFeedback} from './scanner-feedback';
import styles from '../scan-monitor.css?inline';
import {useLiveObstructionHint} from './use-live-obstruction-hint';
import {hasScanInputLoss} from './scan-read-detail';
import {scanMonitorMessage} from './scan-monitor-message';

type PipApi={requestWindow(options:{width:number;height:number}):Promise<Window>};
type Props={state:ScanMonitorState|null;busy:boolean;sharing:boolean;engineReady?:boolean;recognizedNames?:readonly string[];onStop:()=>void;feedback?:ScannerFeedback};
type RowProps={row:number;inventory:ScanGridCell[]|undefined;grid:ScanGridSnapshot|undefined;sharing:boolean;capacity:number|null|undefined;expected:number|null|undefined};
const labels={unknown:'위치 기록 없음 · 카드 미판독을 뜻하지 않음',waiting:'판독 대기',reading:'판독 중',read:'완료',review:'다시 보여주기',empty:'카드 없음'};

const MonitorRow=memo(function MonitorRow({row,grid,sharing,capacity,expected}:RowProps) {
  return <div role="row" className="monitor-map-row"><span role="rowheader">{row+1}</span>{Array.from({length:10},(_,column)=>{
    const index=row*10+column,{cell,estimate,estimatedPrimary}=projectMonitorCell(grid,index,capacity,expected,sharing),status=cell.status;
    const statusLabel=status==='review'&&cell.reason?.startsWith('인식 필요')?'인식 필요':labels[status];
    const label=(row+1)+'행 '+(column+1)+'열 · '+(estimatedPrimary?'위치 추정 · ':'')+(status==='unknown'&&cell.historical?'현재 판독 정보 없음':statusLabel)+(cell.historical?' · 이전에 판독 처리한 추정 위치':'')+(estimate?' · 현재 화면 위치 추정: '+labels[estimate.status]:'');
    return <span role="cell" className={'monitor-dot is-'+status+(cell.historical?' has-history':'')+(estimatedPrimary?' is-estimated':'')} key={column} title={label+(status!=='empty'&&cell.reason?' · '+cell.reason:'')} aria-label={label}>{status==='review'?'!':status==='read'?'✓':status==='reading'?'•':cell.historical?'↺':''}{cell.historical&&<i aria-hidden="true" className="monitor-history-badge"/>}{estimate&&<i aria-hidden="true" className={'monitor-estimated-badge is-'+estimate.status}/>}</span>;
  })}</div>;
},(previous,next)=>{
  if(previous.row!==next.row||previous.capacity!==next.capacity||previous.expected!==next.expected||previous.sharing!==next.sharing)return false;
  for(let column=0;column<10;column++){
    const index=next.row*10+column,a=previous.sharing?estimatedMonitorCell(previous.grid,index,previous.capacity,previous.expected):undefined,b=next.sharing?estimatedMonitorCell(next.grid,index,next.capacity,next.expected):undefined;
    if(a?.status!==b?.status||a?.reason!==b?.reason)return false;
  }
  if(previous.inventory===next.inventory)return true;
  for(let column=0;column<10;column++){
    const index=next.row*10+column,a=previous.inventory?.[index],b=next.inventory?.[index];
    if(a?.status!==b?.status||a?.reason!==b?.reason||a?.row!==b?.row||a?.historical!==b?.historical)return false;
  }
  return true;
});

const MonitorRows=memo(function MonitorRows({inventory,grid,sharing,capacity,expected,fromRow=0,toRow=55}:{inventory:ScanGridCell[]|undefined;grid:ScanGridSnapshot|undefined;sharing:boolean;capacity:number|null|undefined;expected:number|null|undefined;fromRow?:number;toRow?:number}) {
  const count=Math.max(0,toRow-fromRow);
  return <>{Array.from({length:count},(_,index)=><MonitorRow key={fromRow+index} row={fromRow+index} inventory={inventory} grid={grid} sharing={sharing} capacity={capacity} expected={expected}/>)}</>;
});

const emptyCaptureCells:ScanGridCell[]=Array.from({length:40},()=>({status:'unknown'}));
const RecentFrame=memo(function RecentFrame({cells=emptyCaptureCells}:{cells?:ScanGridCell[]}) {
  return <div className="monitor-capture" aria-label="마지막 촬영 화면의 40칸">
    <span title="가장 최근에 촬영한 화면입니다. 전체 판독 완료 수와는 별개입니다.">마지막 촬영 화면</span>
    <div className="monitor-capture-cells" role="table" aria-label="마지막 촬영 화면 4행 10열">
      {Array.from({length:4},(_,row)=><div role="row" key={row}>{cells.slice(row*10,row*10+10).map((cell,column)=>{
        const label=`수집 화면 ${row+1}행 ${column+1}열 · ${cell.status==='unknown'?'판독 정보 없음':cell.status==='review'&&cell.reason?.startsWith('인식 필요')?'인식 필요':labels[cell.status]}`;
        return <span key={column} role="cell" data-monitor-recent-slot={row*10+column} className={'monitor-dot is-'+cell.status} title={label+(cell.reason?' · '+cell.reason:'')} aria-label={label}>{cell.status==='read'?'✓':cell.status==='reading'?'•':cell.status==='review'?'!':''}</span>;
      })}</div>)}
    </div>
  </div>;
});

export function ScanMonitorPanel({state:input,busy,sharing,engineReady,recognizedNames=[],onStop,feedback}:Props) {
  const root=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{commitScanMonitorFeedback(root.current,input,feedback,{busy,sharing});},[input,feedback,busy,sharing]);
  const state=input?projectScanMonitorState(input):null;
  const preparing=!!busy&&!sharing&&engineReady===false;
  const baseOutcome=scanMonitorOutcome(state,{busy,sharing});
  const outcome=preparing?{...baseOutcome,kind:'active' as const,header:'준비 중',message:'인식 엔진을 준비하고 있어요',
    detail:'준비가 끝나면 카드 화면을 공유해 주세요.',showGrid:false}:baseOutcome;
  const inputLoss=hasScanInputLoss(state?.autoCompletionDiagnostic?.gate,state?.droppedFrames);
  const showObstruction=useLiveObstructionHint(state?.liveObstructionHint,busy&&sharing&&outcome.kind==='active'&&!inputLoss);
  const grid=state?.grid;
  // The monitor store already retains the last committed frame across the
  // begin()/record() gap. Reuse it instead of adding another per-frame state.
  const recentFrame=grid?.recentFrame;
  const recent=scanMonitorRecentCounts(recentFrame?{recentFrame}:undefined);
  const complete=outcome.kind==='complete';
  const count=state?.currentRunRead??0,total=state?.expected;
  const [peak,setPeak]=useState(0);
  const [showFullMap,setShowFullMap]=useState(true);
  useEffect(()=>{
    if(!busy||count===0){
      // oxlint-disable-next-line react/set-state-in-effect -- peak display belongs to one active scan session.
      setPeak(0);return;
    }
    // oxlint-disable-next-line react/set-state-in-effect -- retain the high-water count when the latest fields need rechecking.
    setPeak(value=>Math.max(value,count));
  },[busy,count]);
  const recheck=Math.max(0,peak-count);
  const mapped=grid?.inventory?.filter(cell=>cell.status==='read').length??0;
  const hasPosition=grid?.inventory?.some(cell=>cell.status!=='unknown'&&cell.status!=='empty')??false;
  const rows=55;
  const tops=grid?.located?grid.cells.flatMap((c,i)=>c.row===undefined?[]:[c.row-Math.floor(i/10)]):[];
  const registeredTop=tops.length&&tops.every(r=>r===tops[0])?tops[0]:undefined;
  const top=grid?.liveTracking?grid.liveTop:registeredTop??(grid?.located?grid.estimatedTop:undefined);
  const estimated=top!==undefined&&top!==registeredTop;
  const compactTop=top!==undefined&&!showFullMap;
  const fromRow=compactTop?Math.max(0,top!-2):0;
  const toRow=compactTop?Math.min(rows,fromRow+8):rows;
  const ready=sharing&&gridReady(grid)&&(!grid?.liveTracking||top!==undefined&&top===registeredTop);
  const located=grid?.located||grid?.liveTracking&&top!==undefined;
  const action=preparing?{message:'인식 엔진을 준비하고 있어요',ready:false}
    :scanMonitorMessage({outcome,sharing,inputLoss,obstructed:showObstruction,located:!!located,viewportReady:ready,
    gate:state?.autoCompletionDiagnostic?.gate,expected:total,completed:count,queued:state?.queued,reading:state?.activeReadings,
    unresolvedCount:state?.unresolvedCount,unresolvedCountUnavailable:state?.unresolvedCountUnavailable,
    unresolvedFieldChanges:state?.unresolvedFieldChanges,unresolvedFieldChangesUnavailable:state?.unresolvedFieldChangesUnavailable});
  return <section ref={root} className="scan-monitor" aria-label="실시간 스캔 진행">
    <header><strong>LoaCard <small>스캔 진행</small></strong><span>{outcome.header}</span></header>
    <div className={'monitor-action '+(action.ready?'is-ready':'')} role="status"><strong>{action.message}</strong></div>
    {outcome.detail&&<p className="monitor-pending">{outcome.detail}</p>}
    {!preparing&&<div className="monitor-total"><span>{grid?.located?'판독 완료':'마지막 판독'}</span><strong>{count}<small> / {total??'—'}종</small></strong></div>}
    {busy&&!preparing&&(()=>{const collected=state?.currentRunNames??count,missing=total==null?null:Math.max(0,total-collected);
      return (!!missing||!!state?.review)&&<div className="monitor-breakdown" role="status">
        {missing!==null&&missing>0&&<span>이름 미확인 {missing}종</span>}
        {!!state?.review&&<span className="is-review">확인 필요 {state.review}종</span>}
      </div>;})()}
    {busy&&!preparing&&recheck>0&&<div className="monitor-recheck" title="최신 관측에서 필드가 아직 확인되지 않아 생긴 차이입니다. 이전에 확인된 카드가 목록에서 삭제된 것은 아닙니다.">누적 확인 {peak}종 · 최신 재확인 {recheck}종</div>}
    {!preparing&&<div className="monitor-progress-slot">{!!total&&<progress value={count} max={total} aria-label="전체 카드 판독"/>}</div>}
    {busy&&!preparing&&<div className="monitor-work" role="group" aria-label="판독 작업 상태">
      <span>판독 대기 <b>{state?.queued??0}</b>건</span>
      <span>판독 중 <b>{state?.activeReadings??0}</b>건</span>
    </div>}
    {busy&&!preparing&&(recent?<div className="monitor-recent" aria-label="마지막 촬영 화면 판독 상태" title="마지막으로 촬영한 화면 기준입니다. 전체 판독 완료 수와는 별개입니다.">
      <span className="monitor-recent-title">마지막 촬영 화면 {recent.captured}칸 · 전체 판독과 별개</span>
      <strong className="is-read">✓ 이 화면 완료 {recent.read}</strong>
      <span className="is-waiting">판독 대기 {recent.waiting}</span>
      <strong className="is-reading">판독 중 {recent.reading??'—'}</strong>
      <span className="is-review">확인 필요 {recent.review}</span>
      <span>판독 정보 없음 {recent.unknown}</span>
      <span>카드 없음 {recent.empty}</span>
    </div>:<div className="monitor-recent" aria-label="마지막 촬영 화면 판독 상태">
      <span className="monitor-recent-title">마지막 촬영 화면을 기다리는 중</span>
    </div>)}
    {busy&&!preparing&&<RecentFrame cells={recentFrame?.cells}/>}
    {!preparing&&(outcome.showGrid?(hasPosition?<>
      <div className="monitor-grid-title"><b>보관함 · 최대 550칸</b><span>{sharing?(top!==undefined?(estimated?'약 ':'')+top+'–'+Math.min(rows,top+3)+'행 보는 중':'행 위치 확인 중'):'위치 기록'}</span>
        {top!==undefined&&<button type="button" className="monitor-map-toggle" onClick={()=>setShowFullMap(value=>!value)}>{showFullMap?'현재 위치만':'전체 지도'}</button>}</div>
      <div className="monitor-map" role="table" aria-label={compactTop?'카드 위치 '+(fromRow+1)+'–'+toRow+'행':'전체 '+rows+'행 10열 카드 위치'}>
        {sharing&&top!==undefined&&<div data-monitor-viewport-top={top} className={'monitor-viewport'+(estimated?' is-estimated':'')} style={{transform:'translateY('+((top!-1-fromRow)*12)+'px)',height:Math.min(4,toRow-top!+1)*12}} aria-hidden="true"/>}
        <MonitorRows inventory={grid?.inventory} grid={grid} sharing={sharing} capacity={state?.capacity} expected={state?.expected} fromRow={fromRow} toRow={toRow}/>
      </div>
      <div className="monitor-legend"><span><i className="is-unknown"/>위치 기록 없음</span><span><i className="is-waiting"/>판독 대기</span><span><i className="is-reading"/>판독 중</span><span><i className="is-read"/>완료</span><span><i className="is-historical"/>이전 처리 위치 추정</span><span><i className="is-review"/>다시 보기·인식 필요</span><span><i className="is-empty"/>카드 없음</span><span><i className="is-estimated"/>위치 추정</span></div>
      <small className="monitor-estimate">{complete?`위치 연결 ${mapped}/${total}`:sharing?'점선은 추정 위치의 판독 상태예요. 위치가 확인되지 않으면 위의 최근 화면을 확인하세요.':'빈 표시: 위치 미확인 · 판독 실패를 뜻하지 않아요.'}</small>
    </>:<div className="monitor-recognized" role="status">
      <strong>인식한 카드 {count.toLocaleString('ko-KR')}종</strong>
      <p>행 위치는 확인되지 않았지만, 인식한 카드는 메인 카드 목록에 남아 있습니다.</p>
      {recognizedNames.length>0&&<ul>{recognizedNames.slice(0,12).map(name=><li key={name}>{name}</li>)}</ul>}
    </div>):<p className="monitor-pending">스크롤 범위를 확인하면 전체 카드 위치가 표시돼요.</p>)}
     {sharing&&<footer><small>진행 창은 카드 영역 밖에 두세요. 공유를 종료해도 수집된 카드 판독은 계속됩니다.</small><button onClick={onStop}>공유 종료</button></footer>}
  </section>;
}

function LiveScanMonitorPanel(props:Props&{store:ScanMonitorStore;inline?:boolean;forceVisible?:boolean}) {
  const live=useSyncExternalStore(props.store.subscribe,props.store.getSnapshot);
  // The scanner publishes this store synchronously. Full list props can still
  // be an older React transition when an urgent busy=false update commits.
  // Start/reset/import/restore clear the store before replacing that session.
  const state=live??props.state,outcome=scanMonitorOutcome(state,{busy:props.busy,sharing:props.sharing});
  if(props.inline&&!props.busy&&!props.sharing&&!props.forceVisible&&outcome.kind!=='review'&&outcome.kind!=='interrupted'&&outcome.kind!=='complete')return null;
  return <ScanMonitorPanel {...props} state={state} feedback={live?props.store.getFeedback():undefined}/>;
}

export function ScanMonitor(props:Props&{store:ScanMonitorStore}) {
  const [pip,setPip]=useState<Window|null>(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
  const canOpen=props.busy||props.sharing||!!props.state?.grid||(props.state?.currentRunRead??0)>0||props.state?.expected!=null;
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
    <Button startIcon={<PictureInPictureAltOutlined/>} disabled={opening||!canOpen} title={canOpen?undefined:'스캔을 시작하면 진행 창을 열 수 있습니다.'} onClick={()=>void open()}>{pip?'진행 창 보기':'진행 창 띄우기'}</Button>
    {error&&<p role="status">{error} {!props.busy&&<button className="text-button" onClick={()=>setError('')}>진행 표시 닫기</button>}</p>}
    {!pip&&<LiveScanMonitorPanel {...props} inline forceVisible={!!error}/>}
    {pip&&createPortal(<LiveScanMonitorPanel {...props}/>,pip.document.body)}
  </div>;
}
