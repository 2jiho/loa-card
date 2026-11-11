import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {runScanner} from '../src/features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import type {CountDiagnostics} from '../src/features/card-scanner/recognition/recognizer';
import {completionReasons} from '../src/features/card-scanner/session/positive-completion';

/** Production scanner over one private image corpus case. Evidence only. */
const DEFAULT_CASE='d49e0e318e1163b1723108936fb3d8251b90a5078248471dcb534d91499b9d21';
interface CaseInput {index:number;name:string;url:string;bytes:number}
interface ReviewCard {
  id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[];
  countReliable?:boolean;observations:number;captureOrder?:number;
  countDiagnostics?:CountDiagnostics;
}
interface Result {
  status:string|null;cards:number;read:number;names:number;unidentified:number;
  unresolvedObservations?:number;duplicateUnidentifiedObservations?:number;
  reviews:ReviewCard[];
  completed:boolean;completionReasons:string[];
  crops:{id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[];image:string}[];
  allCards:{id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[]}[];
  expected?:number|null;
}
// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
function RunView(){
  const caseId=new URLSearchParams(location.search).get('case')??DEFAULT_CASE;
  const [status,setStatus]=useState('사례 준비 중');
  const [result,setResult]=useState<Result|null>(null);
  useEffect(()=>{
    const abort=new AbortController();
    void (async()=>{
      try{
        const response=await fetch(`/__corpus/cases/${caseId}`,{signal:abort.signal});
        if(!response.ok)throw Error('사례를 읽지 못했습니다.');
        const detail=await response.json() as {inputs:CaseInput[]};
        const urls=detail.inputs.slice(0,32).map(input=>input.url);
        if(!urls.length)throw Error('이미지 입력이 없습니다.');
        setStatus(`이미지 ${urls.length}장 준비 완료`);
        const latest={value:null as ScannerState|null};
        await runScanner(document.createElement('video'),'video',abort.signal,state=>{
          latest.value=state;
          setStatus(`${state.status} · 카드 ${state.cards.length}종 · 미식별 ${state.unidentified.length}건`);
        },[],()=>{},'all',urls,false,{});
        if(abort.signal.aborted)return;
        const state=latest.value;
        if(!state)throw Error('스캐너 최종 상태가 없습니다.');
        const reasons=completionReasons(state);
        const value:Result={status:state.status,cards:state.cards.length,names:state.currentRunNames??0,
          read:state.currentRunRead??0,unidentified:state.unidentified.length,
          ...(state.unresolvedObservations===undefined?{}:{unresolvedObservations:state.unresolvedObservations}),
          ...(state.duplicateUnidentifiedObservations===undefined?{}:{duplicateUnidentifiedObservations:state.duplicateUnidentifiedObservations}),
          reviews:state.cards.filter(card=>card.review.length>0).map(card=>({id:card.id,name:card.name,
            awakening:card.awakening,extraCopies:card.extraCopies,review:card.review,
            ...(card.countReliable===undefined?{}:{countReliable:card.countReliable}),
            observations:card.observations,
            ...(card.captureOrder===undefined?{}:{captureOrder:card.captureOrder}),
            ...(card.countDiagnostics===undefined?{}:{countDiagnostics:card.countDiagnostics})})),
          completed:reasons.length===0,completionReasons:reasons,
          allCards:state.cards.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,review:card.review})),
          ...(state.expected===undefined?{}:{expected:state.expected}),
          crops:(()=>{const withImage=state.cards.filter(card=>card.image.startsWith('data:image/'));
            const picked=new Map(withImage.filter(card=>card.review.length>0).map(card=>[card.id,card]));
            for(const card of withImage){
              if(picked.size>=40)break;
              const key=`${card.awakening}:${card.extraCopies===null?'null':card.extraCopies>0?'pos':'zero'}`;
              if(![...picked.values()].some(existing=>`${existing.awakening}:${existing.extraCopies===null?'null':existing.extraCopies>0?'pos':'zero'}`===key))picked.set(card.id,card);
            }
            for(const card of withImage){if(picked.size>=40)break;if(!picked.has(card.id))picked.set(card.id,card);}
            return [...picked.values()].map(card=>({id:card.id,name:card.name,awakening:card.awakening,
              extraCopies:card.extraCopies,review:card.review,image:card.image}));
          })()};
        (window as unknown as {__imageCaseRun?:Result}).__imageCaseRun=value;
        setResult(value);setStatus('입력 처리 종료');
      }catch(error){
        if(!abort.signal.aborted)setStatus(`실패 · ${String(error)}`);
      }
    })();
    return()=>abort.abort();
  }, [caseId]);
  return <main style={{maxWidth:1100,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
    <h1>Image corpus scanner run</h1>
    <p>production <code>runScanner</code>에 사진 입력을 순서대로 전달합니다. 결과는 증거 확인용이며 저장·확정하지 않습니다.</p>
    <p>case <code>{caseId}</code></p>
    <p role="status">{status}</p>
    {result&&<><h2>{result.cards===result.read&&result.reviews.length===0?'인식 완료 후보':'확인 필요'}</h2><pre style={{fontSize:12}}>{JSON.stringify(result,null,1)}</pre></>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<RunView/>);
