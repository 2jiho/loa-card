import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {runScanner} from '../src/features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import type {CountDiagnostics} from '../src/features/card-scanner/recognition/recognizer';
import type {FixedGridRescueState} from '../src/features/card-scanner/acquisition/fixed-grid-rescue';
import {completionReasons} from '../src/features/card-scanner/session/positive-completion';
import {loadVideoInput} from './video-input-loader';

/** Minimal production-scanner runner for a private corpus video case. It
 * exists to verify the live scanner's evidence-only fixed-row rescue without
 * the larger dev-scanner UI. It does not archive or promote any result. */
const VIDEO7_CASE='bd8e310843e1c5957eebf66b6d861376ed013e95665872df885950e7f0a1280c';
const CASE_ID=new URLSearchParams(window.location.search).get('case')??VIDEO7_CASE;
const VIDEO=`/__corpus/cases/${CASE_ID}/input/0`;
interface ReviewCard {
  id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[];
  countReliable?:boolean;confidence:number;observations:number;captureOrder?:number;image:string;
  countDiagnostics?:CountDiagnostics;
  capturePosition?:unknown;
}
interface ReviewHistoryEntry {
  captureOrder?:number;awakening:number|null;extraCopies:number|null;countReliable?:boolean;
  review:string[];countDiagnostics?:CountDiagnostics;
  capturePosition?:{stable?:boolean;slot?:number;frame?:unknown;sort?:unknown};
}
interface Result {
  status:string|null;cards:number;read:number;names:number;unidentified:number;
  interrupted:boolean|string|null;fixedRowRescue:FixedGridRescueState|null;
  completed:boolean;
  completionReasons:string[];
  dumpCards?:{id:string;name:string;awakening:number|null;extraCopies:number|null;image:string}[];
  observationDump?:{id:string|null;group:number;slot:number;stable:boolean;borderAlignment:number;stage:string;acceptedId:string|null;status:string;reason:string|null}[];
  cardHistory?:Record<string,Record<string,unknown>[]>;
  unresolvedObservations?:number;
  duplicateUnidentifiedObservations?:number;
  resolvedUnidentifiedObservations?:number;
  discardedObservations?:number;
  discardedDetails?:{time:number;pending:boolean;reason?:string;group?:number;captureOrder?:number;image?:string;recognitionImage?:string;location?:unknown}[];
  recognitionNeeded?:{slot:number;captureTime:number;reason:string}[];
  reviews:ReviewCard[];
  reviewHistory:Record<string,ReviewHistoryEntry[]>;
  unidentifiedDetails:{time:number;pending:boolean;reason?:string;group?:number;captureOrder?:number;image?:string;recognitionImage?:string;
    nameAttempts?:{engine:string;confidence:number;reason:string;text?:string;candidates?:{id:string;name:string;score:number}[];topCandidate?:string}[]}[];
  pendingFields?:{id:string;name:string;reason:string;countReason?:string;stable?:boolean;borderAlignment?:number;captureOrder?:number}[];
  allCards:{id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[];position?:unknown}[];
  sort?:unknown;
  expected?:number|null;
  scrollGaps?:{from:number;to:number}[]|null;
  scrollCoverageUncertain?:boolean;
  recoverySkipped?:boolean;
}
// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
function RunView(){
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const [status,setStatus]=useState('영상 준비 중');
  const [result,setResult]=useState<Result|null>(null);
  useEffect(()=>{
    const abort=new AbortController();
    const video=document.createElement('video');
    video.muted=true;video.playsInline=true;video.preload='auto';video.width=480;
    video.style.maxWidth='480px';
    document.body.append(video);
    videoRef.current=video;
    const latest={value:null as ScannerState|null};
    const reviewHistory=new Map<string,ReviewHistoryEntry[]>();
    // Optional per-observation diagnostic for requested card ids. Records only
    // placement/stability and reader outcomes; never used by recognition.
    const dumpParam=new URLSearchParams(location.search).get('dump')??'';
    const dumpAll=dumpParam==='*';
    const dumpIds=new Set(dumpAll?[]:dumpParam.split(',').filter(Boolean));
    const recognitionSlots=(new URLSearchParams(location.search).get('recognitionSlots')??'').split(',').filter(Boolean)
      .map(entry=>{const [slot,time,...reason]=entry.split('@');const value=Number(slot),captureTime=Number(time);
        return Number.isInteger(value)&&value>=0&&value<40&&Number.isFinite(captureTime)&&captureTime>=0
          ?{slot:value,captureTime,reason:reason.join('@')||'툴팁 가림'}:null;})
      .filter((entry):entry is {slot:number;captureTime:number;reason:string}=>entry!==null);
    const observationDump:{id:string|null;group:number;slot:number;stable:boolean;borderAlignment:number;stage:string;
      acceptedId:string|null;status:string;reason:string|null}[]=[];
    // Per-card value history for requested ids: each time a dumped card's
    // fields, review, stability or diagnostics change, the state is appended.
    const cardHistory=new Map<string,{key:string;entry:Record<string,unknown>}[]>();
    const recognitionObserver=(dumpAll||dumpIds.size)?{
      begin(meta:{group:number;slot:number;stable:boolean;borderAlignment:number;stage:string}){
        const record={id:null as string|null,group:meta.group,slot:meta.slot,stable:meta.stable,
          borderAlignment:meta.borderAlignment,stage:meta.stage,acceptedId:null as string|null,
          status:'',reason:null as string|null};
        return {captureCard(){},captureLabel(){},
          finish(outcome:{acceptedIdentity:{id:string}|null;status:string;diagnostics:{reason:string}[]}){
          record.acceptedId=outcome.acceptedIdentity?.id??null;
          record.id=record.acceptedId;
          record.status=outcome.status;
          record.reason=outcome.diagnostics?.[0]?.reason??null;
          if(record.id&&(dumpAll||dumpIds.has(record.id)))observationDump.push(record);
        }};
      },
    }:undefined;
    void (async()=>{
      try{
        await loadVideoInput(video,VIDEO,abort.signal);
        if(abort.signal.aborted)return;
        setStatus('스캔 준비 중');
        await runScanner(video,'video',abort.signal,state=>{
          latest.value=state;
          if(dumpAll||dumpIds.size)for(const card of state.cards){
            if(!dumpAll&&!dumpIds.has(card.id))continue;
            const entry={captureOrder:card.captureOrder??null,awakening:card.awakening,extraCopies:card.extraCopies,
              countReliable:card.countReliable??null,review:[...card.review],stable:card.capturePosition?.stable??null,
              slot:card.capturePosition?.slot??null,reason:card.countDiagnostics?.reason??null,
              score:card.countDiagnostics?.pattern?.score??null,gap:card.countDiagnostics?.pattern?.gap??null};
            const key=JSON.stringify(entry);
            const list=cardHistory.get(card.id)??[];
            if(!list.some(existing=>existing.key===key)){list.push({key,entry});cardHistory.set(card.id,list.slice(-64));}
          }
          for(const card of state.cards)if(card.review.length>0){
            const entries=reviewHistory.get(card.id)??[];
            const entry:ReviewHistoryEntry={...(card.captureOrder===undefined?{}:{captureOrder:card.captureOrder}),
              awakening:card.awakening,extraCopies:card.extraCopies,...(card.countReliable===undefined?{}:{countReliable:card.countReliable}),
              review:card.review,...(card.countDiagnostics===undefined?{}:{countDiagnostics:card.countDiagnostics}),
              ...(card.capturePosition===undefined?{}:{capturePosition:{
                ...(card.capturePosition.stable===undefined?{}:{stable:card.capturePosition.stable}),
                ...(card.capturePosition.slot===undefined?{}:{slot:card.capturePosition.slot}),
                ...(card.capturePosition.frame===undefined?{}:{frame:card.capturePosition.frame}),
                ...(card.capturePosition.sort===undefined?{}:{sort:card.capturePosition.sort})}})};
            const key=JSON.stringify(entry);
            if(!entries.some(existing=>JSON.stringify(existing)===key))reviewHistory.set(card.id,[...entries,entry].slice(-16));
          }
          setStatus(`${state.status} · 카드 ${state.cards.length}종 · 미식별 ${state.unidentified.length}건`);
        },[],()=>{},'all',undefined,false,{unknownEvidenceImages:true,recognitionObserver,
          ...(recognitionSlots.length?{recognitionNeededSlots:recognitionSlots}:{})});
        if(abort.signal.aborted)return;
        const state=latest.value;
        if(!state)throw Error('스캐너 최종 상태가 없습니다.');
        const reasons=completionReasons(state),completed=reasons.length===0;
        const value:Result={status:state.status,cards:state.cards.length,
          read:state.currentRunRead??0,names:state.currentRunNames??0,
          unidentified:state.unidentified.length,interrupted:state.interrupted??null,
          fixedRowRescue:state.fixedRowRescue??null,completed,completionReasons:reasons,
          ...(state.unresolvedObservations===undefined?{}:{unresolvedObservations:state.unresolvedObservations}),
          ...(state.duplicateUnidentifiedObservations===undefined?{}:{duplicateUnidentifiedObservations:state.duplicateUnidentifiedObservations}),
          ...(state.resolvedUnidentifiedObservations===undefined?{}:{resolvedUnidentifiedObservations:state.resolvedUnidentifiedObservations}),
          discardedObservations:state.discardedObservations?.length??0,
          discardedDetails:(state.discardedObservations??[]).map(item=>({
            time:item.time,pending:item.pending,
            ...(item.reason===undefined?{}:{reason:item.reason}),
            ...(item.group===undefined?{}:{group:item.group}),
            ...(item.captureOrder===undefined?{}:{captureOrder:item.captureOrder}),
            ...(item.location===undefined?{}:{location:item.location}),
            ...(typeof item.image!=='string'||!item.image.startsWith('data:image/')?{}:{image:item.image}),
            ...(typeof item.recognitionImage!=='string'||!item.recognitionImage.startsWith('data:image/')?{}:{recognitionImage:item.recognitionImage}),
          })),
          recognitionNeeded:state.recognitionNeeded??[],
          reviews:state.cards.filter(card=>card.review.length>0).map(card=>({
            id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,
            review:card.review,countReliable:card.countReliable,confidence:card.confidence,
            observations:card.observations,...(card.captureOrder===undefined?{}:{captureOrder:card.captureOrder}),
            image:card.image,
            ...(card.countDiagnostics===undefined?{}:{countDiagnostics:card.countDiagnostics}),
            ...(card.capturePosition===undefined?{}:{capturePosition:card.capturePosition}),
          })),
          reviewHistory:Object.fromEntries(reviewHistory),
          allCards:state.cards.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,review:card.review,
            ...(card.capturePosition?.location?{position:card.capturePosition.location}:{})})),
          sort:state.sort??null,
          // Optional evidence dump: ?dump=<comma separated ids> adds the final
          // representative image for those cards only. Used to validate portrait
          // descriptors against a real capture; never used by recognition.
          ...(()=>{const dumpIds=new Set((new URLSearchParams(location.search).get('dump')??'').split(',').filter(Boolean));
            return dumpIds.size?{dumpCards:state.cards.filter(card=>dumpIds.has(card.id)&&typeof card.image==='string'&&card.image.startsWith('data:image/'))
              .map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,image:card.image}))}:{};})(),
          observationDump:observationDump.slice(),
          cardHistory:Object.fromEntries([...cardHistory].map(([id,list])=>[id,list.map(item=>item.entry)])),
          ...(state.expected===undefined?{}:{expected:state.expected}),
          ...(state.scrollGaps===undefined?{}:{scrollGaps:state.scrollGaps}),
          ...(state.scrollCoverageUncertain===undefined?{}:{scrollCoverageUncertain:state.scrollCoverageUncertain}),
          ...(state.recoverySkipped===undefined?{}:{recoverySkipped:state.recoverySkipped}),
          unidentifiedDetails:state.unidentified.map(item=>({
            time:item.time,pending:item.pending,
            ...(item.reason===undefined?{}:{reason:item.reason}),
            ...(item.group===undefined?{}:{group:item.group}),
            ...(item.captureOrder===undefined?{}:{captureOrder:item.captureOrder}),
            ...(typeof item.image!=='string'||!item.image.startsWith('data:image/')?{}:{image:item.image}),
            ...(typeof item.recognitionImage!=='string'||!item.recognitionImage.startsWith('data:image/')?{}:{recognitionImage:item.recognitionImage}),
            ...(item.nameAttempts===undefined?{}:{nameAttempts:item.nameAttempts.slice(0,3).map(attempt=>({
              engine:attempt.engine,confidence:attempt.confidence,reason:attempt.reason,
              text:attempt.text,
              ...(attempt.candidates===undefined?{}:{candidates:attempt.candidates.slice(0,3).map(c=>({id:c.id,name:c.name,score:c.score}))}),
              ...(attempt.candidates?.[0]===undefined?{}:{topCandidate:attempt.candidates[0].name}),
            }))}),
          })),
          ...(state.pendingFields===undefined?{}:{pendingFields:state.pendingFields.map(field=>({
            id:field.id,name:field.name,reason:field.reason,
            ...(field.countReason===undefined?{}:{countReason:field.countReason}),
            ...(field.stable===undefined?{}:{stable:field.stable}),
            ...(field.borderAlignment===undefined?{}:{borderAlignment:field.borderAlignment}),
            ...(field.captureOrder===undefined?{}:{captureOrder:field.captureOrder}),
          }))})};
        (window as unknown as {__video7RescueRun?:Result}).__video7RescueRun=value;
        setResult(value);setStatus(completed?'완료':`입력 처리 종료 · 미완료 · ${reasons.join(' · ')}`);
      }catch(error){
        if(!abort.signal.aborted)setStatus(`실패 · ${String(error)}`);
      }
    })();
    return()=>{abort.abort();video.remove();videoRef.current=null;};
  },[]);
  return <main style={{maxWidth:1100,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
    <h1>Video-7 scanner rescue run</h1>
    <p>production <code>runScanner</code>를 직접 호출해 video-7 전체 프레임을 처리합니다. 결과는 <strong>증거 확인용</strong>이며 저장·확정하지 않습니다.</p>
    <p role="status">{status}</p>
    {result&&<>
      <h2>결과</h2>
      <pre style={{fontSize:12}}>{JSON.stringify(result,null,1)}</pre>
    </>}
  </main>;
}
// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
createRoot(document.getElementById('root')!).render(<RunView/>);
