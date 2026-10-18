import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import Button from '@mui/material/Button';
import PictureInPictureAltOutlined from '@mui/icons-material/PictureInPictureAltOutlined';
import type {ScanMonitorState,ScanMonitorStore} from './scan-monitor-store';
import {gridReady,isLockedInventorySlot} from './scan-grid';
import styles from './scan-monitor.css?inline';

type PipApi={requestWindow(options:{width:number;height:number}):Promise<Window>};
type Props={state:ScanMonitorState|null;busy:boolean;sharing:boolean;onStop:()=>void};

export function ScanMonitorPanel({state,busy,sharing,onStop}:Props) {
  const grid=state?.grid;
  const complete=!busy&&!!state?.expected&&state.currentRunRead===state.expected&&!state.interrupted;
  const count=state?.currentRunRead??0,total=state?.expected;
  const mapped=grid?.inventory?.filter(cell=>cell.status==='read').length??0;
  const rows=55;
  const tops=grid?.located?grid.cells.flatMap((c,i)=>c.row===undefined?[]:[c.row-Math.floor(i/10)]):[];
  const registeredTop=tops.length&&tops.every(r=>r===tops[0])?tops[0]:undefined;
  const top=grid?.liveTracking?grid.liveTop:registeredTop??(grid?.located?grid.estimatedTop:undefined);
  const estimated=top!==undefined&&top!==registeredTop;
  const ready=sharing&&gridReady(grid)&&(!grid?.liveTracking||top!==undefined&&top===registeredTop);
  const message=complete?'스캔 완료':!busy?'화면 공유를 시작해 주세요':!sharing?'남은 카드를 읽고 있어요':!grid?.located?'카드 성장 탭을 보여 주세요':ready?'아래로 스크롤하세요':'잠깐 멈춰 주세요';
  const labels={unknown:'위치 기록 없음 · 카드 미판독을 뜻하지 않음',waiting:'읽는 중',read:'완료',review:'다시 보여주기',empty:'카드 없음'};
  return <section className="scan-monitor" aria-label="실시간 스캔 진행">
    <header><strong>LoaCard <small>스캔 진행</small></strong><span>{sharing?'공유 중':busy?'처리 중':complete?'완료':'대기'}</span></header>
    <div className={'monitor-action '+(ready||complete?'is-ready':'')} role="status"><strong>{message}</strong></div>
    <div className="monitor-total"><span>전체 카드 판독</span><strong>{count}<small> / {total??'—'}종</small></strong></div>
    {!!total&&<progress value={count} max={total} aria-label="전체 카드 판독"/>}
    {busy||complete?<>
      <div className="monitor-grid-title"><b>보관함 · 최대 550칸</b><span>{sharing?(top!==undefined?(estimated?'약 ':'')+top+'–'+Math.min(rows,top+3)+'행 보는 중':'행 위치 확인 중'):'위치 기록'}</span></div>
      <div className="monitor-map" role="table" aria-label={'전체 '+rows+'행 10열 카드 위치'}>
        {sharing&&top!==undefined&&<div className={'monitor-viewport'+(estimated?' is-estimated':'')} style={{transform:'translateY('+((top-1)*12)+'px)',height:Math.min(4,rows-top+1)*12}} aria-hidden="true"/>}
        {Array.from({length:rows},(_,r)=><div role="row" className="monitor-map-row" key={r}><span role="rowheader">{r+1}</span>{Array.from({length:10},(_,c)=>{
          const cell=grid?.inventory?.[r*10+c],status=isLockedInventorySlot(r*10+c,state?.capacity,state?.expected)?'empty':cell?.status??'unknown';
          const label=(r+1)+'행 '+(c+1)+'열 · '+labels[status];
          return <span role="cell" className={'monitor-dot is-'+status} key={c} title={label+(status!=='empty'&&cell?.reason?' · '+cell.reason:'')} aria-label={label}>{status==='review'?'!':status==='read'?'✓':''}</span>;
        })}</div>)}
      </div>
      <div className="monitor-legend"><span><i className="is-unknown"/>위치 기록 없음</span><span><i className="is-waiting"/>읽는 중</span><span><i className="is-read"/>완료</span><span><i className="is-review"/>다시 보기</span><span><i className="is-empty"/>카드 없음</span></div>
      <small className="monitor-estimate">{complete?`전체 카드 판독 완료 · 위치 연결 ${mapped}/${total}`:sharing&&top===undefined?'맨 위부터 겹치는 행이 보이도록 스크롤해 주세요.':'빈 표시: 위치 미확인 · 판독 실패를 뜻하지 않아요.'}</small>
    </>:<p className="monitor-pending">스크롤 범위를 확인하면 전체 카드 위치가 표시돼요.</p>}
    {sharing&&<footer><small>진행 창은 카드 영역 밖에 두세요.</small><button onClick={onStop}>공유 중지</button></footer>}
  </section>;
}

export function ScanMonitor(props:Props&{store:ScanMonitorStore}) {
  const live=useSyncExternalStore(props.store.subscribe,props.store.getSnapshot);
  const display={...props,state:props.busy&&live?live:props.state};
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
    {!pip&&(props.busy||error)&&<ScanMonitorPanel {...display}/>}
    {pip&&createPortal(<ScanMonitorPanel {...display}/>,pip.document.body)}
  </div>;
}
