import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';
import {BoundedFrameRing} from '../src/features/card-scanner/capture/bounded-frame-ring';
import {appendFixedGridRescue,rescueFixedRowSlot} from '../src/features/card-scanner/acquisition/fixed-grid-rescue';
import type {FixedGridRescueEvidence,FixedGridRescueRecord,FixedGridRescueState} from '../src/features/card-scanner/acquisition/fixed-grid-rescue';
import type {Reference} from '../src/features/card-scanner/recognition/recognizer';

/** Dev-only proof of the scanner's evidence-only rescue path. It uses the real
 * video-7 frames and the real portrait matcher, but no OpenCV detector and no
 * inventory: the only output is a FixedGridRescueState. */
const CASE_ID='bd8e310843e1c5957eebf66b6d861376ed013e95665872df885950e7f0a1280c';
const VIDEO=`/__corpus/cases/${CASE_ID}/input/0`;
const KNOWN_SHA='205578c981b5ce6601e43338e1db5320f9edbe6d8e1dfb2cdc1744018e844796';
const KNOWN_BYTES=27_543_837;
const XS=[138,295,453,610,767,924,1081,1239,1396,1553] as const;
const ROWS=[392,635,878,1121] as const;
const CARD_W=140,CARD_H=210,SLOT=6,CAPTURE_TIME=2.4,RING_LIMIT=2;
const SAMPLE_TIMES=[2.3,2.35,2.4] as const;
const EXPECTED={id:'3201013',name:'라제니스를 이끄는 니나브'};
interface Cell {x:number;y:number;width:number;height:number}
interface Atlas {[id:string]:string}
interface Payload {cards:Reference[]}
interface CaseDetail {inputs?:{sha256?:string;bytes?:number}[]}
interface Environment {sourceDigest?:string;files?:number;git?:{head?:string}}
interface Stored {file:string;sha256:string;bytes:number}
interface Proof {
  version:1;kind:'fixed-row-rescue-proof';
  input:{caseId:string;sha256:string;bytes:number;duration:number;width:number;height:number};
  environment:{sourceDigest:string|null;files:number|null;build:string|null};
  settings:{slot:number;captureTime:number;sampleTimes:readonly number[];ringLimit:number;
    xs:readonly number[];rows:readonly number[];cardWidth:number;cardHeight:number;
    timeWindowSeconds:number;matcher:string};
  frames:{frameId:number;time:number;retained:boolean}[];
  retained:{frameCount:number;unavailable:boolean;evidence:readonly FixedGridRescueEvidence[]};
  feature:{available:boolean;frameId:number|null;evidence:readonly FixedGridRescueEvidence[]};
  state:FixedGridRescueState;
  comparison:{expectedId:string;expectedName:string;matchedExpected:boolean;evidenceIds:readonly string[]};
}
async function getJson<T>(url:string):Promise<T>{
  const response=await fetch(url);
  if(!response.ok)throw Error(`${url} ${response.status}`);
  return response.json() as Promise<T>;
}
function seek(video:HTMLVideoElement,time:number){
  return new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('시크 시간 초과'));},15000);
    const done=()=>{cleanup();resolve();};
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);};
    video.addEventListener('seeked',done,{once:true});
    video.currentTime=time;
  });
}
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function ProofView(){
  const [status,setStatus]=useState('자산과 영상을 불러오는 중');
  const [proof,setProof]=useState<Proof|null>(null);
  const [stored,setStored]=useState<Stored|null>(null);
  useEffect(()=>{
    const abort=new AbortController();
    void (async()=>{
      try{
        const [catalog,atlas,screen,competitors,caseInfo,environment]=await Promise.all([
          getJson<Payload>('/scanner/cards.json'),
          getJson<Atlas>('/scanner/artwork-details.json'),
          getJson<{cards:Atlas}>('/scanner/screen-artwork-details.json'),
          getJson<{cards:Atlas}>('/scanner/portrait-competitors.json'),
          getJson<CaseDetail>(`/__corpus/cases/${CASE_ID}`).catch(()=>null),
          getJson<Environment>('/__corpus/environment').catch(()=>null),
        ]);
        if(abort.signal.aborted)return;
        const matcher=createPortraitMatcher(catalog.cards,atlas,screen.cards,{competitors:competitors.cards});
        const tile=document.createElement('canvas');
        const tileContext=tile.getContext('2d',{willReadFrequently:true})!;
        const cells:Cell[]=ROWS.flatMap(row=>XS.map(x=>({x,y:row,width:CARD_W,height:CARD_H})));
        const grayFor=(frame:HTMLCanvasElement,cell:Cell|undefined)=>{
          if(!cell)return null;
          const w=Math.round(cell.width),h=Math.round(cell.height);
          if(w<24||h<32||cell.x<0||cell.y<0||cell.x+w>frame.width||cell.y+h>frame.height)return null;
          if(tile.width!==w)tile.width=w;
          if(tile.height!==h)tile.height=h;
          tileContext.clearRect(0,0,w,h);
          tileContext.drawImage(frame,cell.x,cell.y,w,h,0,0,w,h);
          return areaGray(tileContext.getImageData(0,0,w,h).data,w,h);
        };
        const match=(gray:ArrayLike<number>)=>{
          const result=matcher(gray);
          return result?{id:result.card.id,name:result.card.name,
            correlation:result.portrait.correlation,margin:result.portrait.margin}:null;
        };
        setStatus('영상 프레임을 불러오는 중');
        const blob=await fetch(VIDEO,{cache:'no-store'}).then(response=>{
          if(!response.ok)throw Error(`영상 ${response.status}`);
          return response.blob();
        });
        if(abort.signal.aborted)return;
        const video=document.createElement('video');
        video.muted=true;video.preload='auto';video.src=URL.createObjectURL(blob);
        await new Promise<void>((resolve,reject)=>{
          video.onloadeddata=()=>resolve();
          video.onerror=()=>reject(Error('영상 로드 실패'));
        });
        const width=video.videoWidth,height=video.videoHeight,duration=video.duration;
        const ring=new BoundedFrameRing<HTMLCanvasElement,{captureTime:number;cells:readonly Cell[]}>(
          RING_LIMIT,
          ()=>document.createElement('canvas'),
          (canvas,w,h)=>{if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;});
        const frames:Proof['frames']=[];
        for(const time of SAMPLE_TIMES){
          if(abort.signal.aborted)return;
          await seek(video,time);
          const frame=ring.next(width,height);
          frame.getContext('2d',{willReadFrequently:true})!.drawImage(video,0,0,width,height);
          const frameId=frames.length+1;
          ring.bind(frame,frameId,{captureTime:time,cells});
          frames.push({frameId,time,retained:false});
          setStatus(`프레임 ${frames.length}/${SAMPLE_TIMES.length} · ${time.toFixed(2)}s`);
        }
        URL.revokeObjectURL(video.src);
        const retainedEntries=ring.entries();
        const retainedIds=new Set(retainedEntries.map(entry=>entry.frameId));
        for(const frame of frames)frame.retained=retainedIds.has(frame.frameId);
        const source=frames.find(frame=>Math.abs(frame.time-CAPTURE_TIME)<1e-9);
        const sourceEntry=source?ring.find(source.frameId):undefined;
        const fixedRowGray=sourceEntry?grayFor(sourceEntry.frame,sourceEntry.meta.cells[SLOT]):null;
        const retained=rescueFixedRowSlot({slot:SLOT,captureTime:CAPTURE_TIME,source:'retained-frame',
          frames:retainedEntries.map(entry=>({frameId:entry.frameId,captureTime:entry.meta.captureTime,
            grayFor:slot=>grayFor(entry.frame,entry.meta.cells[slot])})),match});
        const feature=fixedRowGray?rescueFixedRowSlot({slot:SLOT,captureTime:CAPTURE_TIME,source:'observation-feature',
          frames:[{frameId:source!.frameId,captureTime:CAPTURE_TIME,grayFor:()=>fixedRowGray}],match}):undefined;
        const evidence=[...retained.evidence,...(feature?.evidence??[])]
          .sort((a,b)=>b.correlation-a.correlation||a.frameId-b.frameId);
        const record:FixedGridRescueRecord={version:1,group:0,order:87,slot:SLOT,captureTime:CAPTURE_TIME,
          pending:false,frameCount:retained.frameCount+(feature?.frameCount??0),
          unavailable:retained.unavailable&&!feature,evidence};
        const state=appendFixedGridRescue(undefined,record);
        const inputInfo=caseInfo?.inputs?.[0];
        const value:Proof={
          version:1,kind:'fixed-row-rescue-proof',
          input:{caseId:CASE_ID,sha256:inputInfo?.sha256??KNOWN_SHA,bytes:inputInfo?.bytes??KNOWN_BYTES,
            duration,width,height},
          environment:{sourceDigest:environment?.sourceDigest??null,files:environment?.files??null,
            build:environment?.git?.head??null},
          settings:{slot:SLOT,captureTime:CAPTURE_TIME,sampleTimes:[...SAMPLE_TIMES],ringLimit:RING_LIMIT,
            xs:[...XS],rows:[...ROWS],cardWidth:CARD_W,cardHeight:CARD_H,timeWindowSeconds:.5,
            matcher:'portrait-atlas+screen-supplement+competitors; gates 0.91/0.94/0.20; fixed rows 392/635/878/1121'},
          frames,retained:{frameCount:retained.frameCount,unavailable:retained.unavailable,evidence:retained.evidence},
          feature:{available:!!fixedRowGray,frameId:source?.frameId??null,evidence:feature?.evidence??[]},
          state,
          comparison:{expectedId:EXPECTED.id,expectedName:EXPECTED.name,
            matchedExpected:evidence.some(item=>item.id===EXPECTED.id),
            evidenceIds:Object.freeze([...new Set(evidence.map(item=>item.id))])},
        };
        (window as unknown as {__fixedRowRescueProof?:Proof}).__fixedRowRescueProof=value;
        let saved:Stored|null=null;
        try{
          const response=await fetch('/__corpus/fixed-row-rescue-proof',{method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
          if(response.ok)saved=await response.json() as Stored;
        }catch{/* The client JSON remains available when the dev endpoint is absent. */}
        if(abort.signal.aborted)return;
        setProof(value);setStored(saved);
        setStatus(`완료 · ${value.comparison.matchedExpected?'누락 카드 원화 증거 일치':'원화 증거 미일치'} · `+
          `증거 ${evidence.length}건 · ${saved?'서버 저장':'다운로드 가능'}`);
      }catch(error){
        if(!abort.signal.aborted)setStatus(`실패 · ${String(error).slice(0,300)}`);
      }
    })();
    return()=>abort.abort();
  },[]);
  const download=()=>{
    if(!proof)return;
    const blob=new Blob([JSON.stringify(proof)],{type:'application/json'});
    const url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download='fixed-row-rescue-proof.json';anchor.click();URL.revokeObjectURL(url);
  };
  return <main style={{maxWidth:1100,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
    <h1>Video-7 구조 복원 증명</h1>
    <p>OpenCV 검출기 없이 실제 video-7 프레임과 기존 원화 매처만 사용합니다. 최근 2프레임 링에서 관측 시각 <strong>{CAPTURE_TIME}s</strong>, 슬롯 <strong>{SLOT}</strong>을 고정 행(392/635/878/1121)으로 다시 잘라 증거를 생성합니다. 이 결과는 <strong>카드 확정·재고·완료가 아닌 진단 증거</strong>입니다.</p>
    <p role="status">{status}</p>
    {proof&&<>
      <p><strong>{proof.comparison.matchedExpected?'일치':'미일치'}</strong> · 기대 카드 <code>{proof.comparison.expectedId} {proof.comparison.expectedName}</code> · 증거 ID {proof.comparison.evidenceIds.join(', ')||'없음'}</p>
      <p>{stored?`저장: ${stored.file} · sha256 ${stored.sha256}`:'서버 저장 없음'}</p>
      <button onClick={download}>증명 JSON 다운로드</button>
      <h2>프레임 링</h2>
      <pre style={{fontSize:12}}>{proof.frames.map(frame=>`${frame.frameId}\t${frame.time.toFixed(2)}s\t${frame.retained?'보존':'제거'}`).join('\n')}</pre>
      <h2>보존 프레임 증거</h2>
      <pre style={{fontSize:12}}>{formatEvidence(proof.retained.evidence)}</pre>
      <h2>관측별 고정 행 gray 증거</h2>
      <pre style={{fontSize:12}}>{proof.feature.available?formatEvidence(proof.feature.evidence):'사용할 수 없음'}</pre>
      <h2>fixedRowRescue 상태</h2>
      <pre style={{fontSize:12}}>{JSON.stringify(proof.state,null,1)}</pre>
      <h2>입력·설정</h2>
      <pre style={{fontSize:12}}>{JSON.stringify({input:proof.input,environment:proof.environment,settings:proof.settings},null,1)}</pre>
    </>}
  </main>;
}
function formatEvidence(evidence:readonly FixedGridRescueEvidence[]){
  return evidence.length?evidence.map(item=>
    `${item.source}\t${item.frameId}\t${item.captureTime.toFixed(2)}s\t${item.slot}\t${item.id}\t${item.name}\t${item.correlation.toFixed(3)}\t${item.margin.toFixed(3)}`).join('\n'):
    '일치 증거 없음';
}
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
createRoot(document.getElementById('root')!).render(<ProofView/>);
