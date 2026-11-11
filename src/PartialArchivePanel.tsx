import {useEffect,useRef,useState} from 'react';
import {createPartialStore,createLatestPartialWriter,PartialStoreError,type PartialSnapshot,type PartialEntry,type PartialStore} from './features/card-scanner/persistence/partial-store';
type VisibleEntry=Extract<PartialEntry,{status:'partial'}>;

// This is an isolated, read-only record view. It never returns cards to App.
export function PartialArchivePanel({snapshot,storeFactory}:{snapshot:PartialSnapshot|null;storeFactory?:()=>PartialStore}) {
 const store=useRef<PartialStore|null>(null);
 store.current??=storeFactory?.()??createPartialStore({dbName:'loacard-dev-partial-scan-20261104-v1'});
 const writer=useRef<ReturnType<typeof createLatestPartialWriter>|null>(null);
 const initializing=useRef<Promise<ReturnType<typeof createLatestPartialWriter>>|null>(null);
 const [entries,setEntries]=useState<VisibleEntry[]>([]);
 const [message,setMessage]=useState('부분 기록을 확인하는 중');
 const [selected,setSelected]=useState<VisibleEntry|null>(null);
 const [stats,setStats]=useState<{partial:number;pending:number;deleted:number;limit:number}|null>(null);
 const [retry,setRetry]=useState(0);
 const [failed,setFailed]=useState(false);
 const halted=useRef(false);
 const operation=useRef(0);
 const alive=useRef(false);
 const refreshGeneration=useRef(0);
 async function refresh(){const generation=++refreshGeneration.current;const [items,counts]=await Promise.all([store.current!.list(),store.current!.stats()]);
  if(alive.current&&generation===refreshGeneration.current){const visible=items.filter((entry):entry is VisibleEntry=>entry.status==='partial');setEntries(visible);setStats(counts);setSelected(previous=>previous?visible.find(entry=>entry.id===previous.id)??null:null);}}
 useEffect(()=>{alive.current=true;void refresh().then(()=>{if(alive.current)setMessage(current=>current==='부분 기록을 확인하는 중'?'':current);}).catch(()=>{if(alive.current)setMessage(current=>current==='부분 기록을 확인하는 중'?'부분 기록을 불러오지 못했습니다.':current);});return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!snapshot)return;
  if(halted.current)return;
  const currentOperation=++operation.current;
  const captured=snapshot;
  let live=true;
  async function save(){
   if(alive.current)setMessage('부분 기록 저장 중');
   try{
    initializing.current??=store.current!.start().then(handle=>{
      const result=createLatestPartialWriter(store.current!,handle);writer.current=result;return result;
    });
    const current=await initializing.current;
    if(!live)return;
    current.offer(captured);await current.flush();await refresh();
    if(alive.current&&live)setMessage('부분 기록을 이 브라우저에 보관했습니다.');
   }catch(error){if(currentOperation!==operation.current)return;halted.current=true;initializing.current=null;writer.current=null;if(alive.current&&live){setFailed(true);setMessage(error instanceof PartialStoreError&&error.code==='capacity'
     ?'부분 기록 한도에 도달했습니다. 기존 기록은 자동으로 삭제하지 않습니다.'
     :error instanceof PartialStoreError&&error.code==='invalid'?'부분 기록에 저장할 수 없는 값이 있어 보관하지 못했습니다.'
     :error instanceof PartialStoreError&&error.code==='conflict'?'부분 기록이 다른 탭에서 변경되었거나 삭제되어 저장을 중단했습니다.'
     :'부분 기록의 저장 여부를 확인하지 못했습니다. 목록을 확인한 뒤 다시 시도할 수 있습니다.');}}
  }
  void save();return()=>{live=false;};
 },[snapshot,retry]);
 return <section className="notice" aria-label="부분 스캔 기록">
  <strong>개발용 부분 스캔 기록</strong>
  <p>개발 환경에서만 이 브라우저에 보관합니다. 각 탭은 마지막 진행 상황 한 건만 유지하며 다음 스캔이 앞선 기록을 덮습니다. 이전 목록과 이번 관측이 섞였을 수 있어 구분할 수 없고, 사진은 저장하지 않습니다. 모두 확인 전 후보이며 읽기 전용이므로 전체 구간을 다시 스캔해 주세요.</p>
  <p>새 판독 상태가 들어올 때 약 2초 간격으로 저장을 시도합니다. 새로고침 직전 상태까지 보장하지 않습니다. 같은 주소의 다른 탭에서도 이 기록이 보입니다.</p>
  {message&&<p role="status">{message}</p>}
  {stats&&(stats.pending>0||stats.deleted>0||stats.partial>=stats.limit)&&<p>보관 {stats.partial}건 · 미완료 예약 {stats.pending}건 · 삭제 표시 {stats.deleted}건 / 한도 {stats.limit}건. 예약과 삭제 표시를 자동으로 지우지 않습니다.</p>}
  <button className="text-button" onClick={()=>{void refresh().catch(()=>setMessage('부분 기록을 불러오지 못했습니다.'));}}>기록 새로고침</button>
  {failed&&snapshot&&<button className="text-button" onClick={()=>{halted.current=false;setFailed(false);setRetry(value=>value+1);}}>저장 다시 시도</button>}
  {entries.length===0?<p>보관된 부분 기록이 없습니다.</p>:<ul>{entries.map(entry=><li key={entry.id}>
   <button className="text-button" onClick={()=>setSelected(entry)}>부분 결과 {entry.snapshot.cards.length}종 보기</button>
  </li>)}</ul>}
  {selected&&<div><button className="text-button" onClick={()=>setSelected(null)}>닫기</button>
   <p>예상 {selected.snapshot.expected??'?'}종 · 경험치 {selected.snapshot.growthPoints??'미확인'}</p>
   <ul>{selected.snapshot.cards.map((card,index)=><li key={`${card.id}-${index}`}>{card.name}{card.identityUncertain?' (이름 확인 필요)':' (후보)'} · {card.awakening??'?'}각 · {card.extraCopies??'?'}장</li>)}</ul>
  </div>}
 </section>;
}
