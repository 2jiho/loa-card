import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';
import {reconstructGridArtwork} from '../src/features/card-scanner/session/grid-artwork-reconstruction';
import {createGridReconstructionManifest} from '../src/features/card-scanner/session/grid-reconstruction-manifest';
import type {GridCardSlot,GridCardIdentity} from '../src/features/card-scanner/session/grid-artwork-reconstruction';
import type {GridReconstructionManifest} from '../src/features/card-scanner/session/grid-reconstruction-manifest';
import type {Reference} from '../src/features/card-scanner/recognition/recognizer';

/** Dev-only full-video reconstruction proof: fixed 10x4 grid boxes, card-art
 * identity only, reproducible frame/crop hashes and a dev-server manifest. */
const CASE_ID='bd8e310843e1c5957eebf66b6d861376ed013e95665872df885950e7f0a1280c';
const VIDEO=`/__corpus/cases/${CASE_ID}/input/0`;
const KNOWN_SHA='205578c981b5ce6601e43338e1db5320f9edbe6d8e1dfb2cdc1744018e844796';
const KNOWN_BYTES=27_543_837;
const EXPECTED=397;
const XS=[138,295,453,610,767,924,1081,1239,1396,1553] as const;
const CARD_W=140,CARD_H=210,PITCH_Y=243,STEP_SECONDS=0.05;
/** Scanner crop-journal calibration (7bda02f4): the game viewport rows do not
 * move with the scroll; the cards move inside the fixed 140x210 boxes. */
const ROW_ORIGIN_Y=392;
const ROWS=[392,635,878,1121] as const;
interface UnionCard {id:string;name:string;firstTime:number;corr:number;margin:number;slot:number;cropSha256:string|null}
interface FrameLog {time:number;top:number|null;frameSha256:string;probeAccepted:number;accepted:number}
interface Stored {file:string;sha256:string;bytes:number}
interface Proof {frames:FrameLog[];union:UnionCard[];missing:number;expected:number;duration:number;manifest:GridReconstructionManifest;stored:Stored|null}
interface Payload {cards:Reference[]}
interface Atlas {[id:string]:string}
interface Supplement {cards:Atlas}
interface Competitors {cards:Atlas}
interface CaseDetail {inputs?:{sha256?:string;bytes?:number}[]}
interface Environment {sourceDigest?:string;files?:number;git?:{head?:string}}
async function getJson<T>(url:string):Promise<T>{const response=await fetch(url);if(!response.ok)throw Error(`${url} ${response.status}`);return response.json() as Promise<T>;}
async function sha256Hex(bytes:ArrayBufferView):Promise<string>{
 const copy=new Uint8Array(bytes.byteLength);
 copy.set(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength));
 const digest=await crypto.subtle.digest('SHA-256',copy);
 return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function slotsForRows():GridCardSlot[] {
 const slots:GridCardSlot[]=[];
 for(let row=0;row<4;row++)for(let column=0;column<10;column++)
  slots.push({slot:row*10+column,x:XS[column],y:ROWS[row],width:CARD_W,height:CARD_H});
 return slots;
}
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function ProofView(){
 const [status,setStatus]=useState('자산과 영상을 불러오는 중'),[proof,setProof]=useState<Proof|null>(null);
 useEffect(()=>{
  const abort=new AbortController();
  void (async()=>{
   try{
    const [catalog,atlas,screen,competitors,caseInfo,environment]=await Promise.all([
     getJson<Payload>('/scanner/cards.json'),getJson<Atlas>('/scanner/artwork-details.json'),
     getJson<Supplement>('/scanner/screen-artwork-details.json'),getJson<Competitors>('/scanner/portrait-competitors.json'),
     getJson<CaseDetail>(`/__corpus/cases/${CASE_ID}`).catch(()=>null),getJson<Environment>('/__corpus/environment').catch(()=>null)]);
    if(abort.signal.aborted)return;
    const inputInfo=caseInfo?.inputs?.[0];
    const matcher=createPortraitMatcher(catalog.cards,atlas,screen.cards,{competitors:competitors.cards});
    const videoBlob=await fetch(VIDEO,{cache:'no-store'}).then(response=>{if(!response.ok)throw Error(`영상 ${response.status}`);return response.blob();});
    if(abort.signal.aborted)return;
    const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=URL.createObjectURL(videoBlob);
    await new Promise<void>((resolve,reject)=>{video.onloadeddata=()=>resolve();video.onerror=()=>reject(Error('영상 로드 실패'));});
    const width=video.videoWidth,height=video.videoHeight,duration=video.duration;
    const frame=document.createElement('canvas');frame.width=width;frame.height=height;
    const frameContext=frame.getContext('2d',{willReadFrequently:true})!;
    const tile=document.createElement('canvas');tile.width=CARD_W;tile.height=CARD_H;
    const tileContext=tile.getContext('2d',{willReadFrequently:true})!;
    const hashCanvas=document.createElement('canvas');hashCanvas.width=320;hashCanvas.height=180;
    const hashContext=hashCanvas.getContext('2d',{willReadFrequently:true})!;
    let recording=false,lastTile:Uint8ClampedArray|null=null;
    const cropHashes=new Map<string,Promise<string>>();
    const greyFor=(slot:GridCardSlot)=>{
     if(slot.x<0||slot.y<0||slot.x+CARD_W>width||slot.y+CARD_H>height)return null;
     tileContext.clearRect(0,0,CARD_W,CARD_H);
     tileContext.drawImage(frame,slot.x,slot.y,CARD_W,CARD_H,0,0,CARD_W,CARD_H);
     lastTile=tileContext.getImageData(0,0,CARD_W,CARD_H).data;
     return areaGray(lastTile,CARD_W,CARD_H);
    };
    const match=(gray:ArrayLike<number>):GridCardIdentity|null=>{
     const result=matcher(gray);
     if(!result)return null;
     if(recording&&lastTile&&!cropHashes.has(result.card.id))cropHashes.set(result.card.id,sha256Hex(lastTile));
     return {id:result.card.id,name:result.card.name,correlation:result.portrait.correlation,margin:result.portrait.margin};
    };
    const union=new Map<string,UnionCard>(),frames:FrameLog[]=[];
    for(let time=0.2;time<duration;time+=STEP_SECONDS){
     if(abort.signal.aborted)return;
     await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(Error('시크 시간 초과'));},15000);
      const done=()=>{cleanup();resolve();};
      const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);};
      video.addEventListener('seeked',done,{once:true});video.currentTime=time;
     });
     frameContext.drawImage(video,0,0,width,height);
     hashContext.clearRect(0,0,320,180);hashContext.drawImage(frame,0,0,320,180);
     const frameSha256=await sha256Hex(hashContext.getImageData(0,0,320,180).data);
     const slots=slotsForRows();
     const probe=[0,9,20,30].filter(slot=>{const gray=greyFor(slots[slot]);return !!gray&&!!match(gray);}).length;
     if(probe<2){frames.push({time,top:null,frameSha256,accepted:0,probeAccepted:probe});setStatus(`처리 중 ${time.toFixed(1)}s / ${duration.toFixed(1)}s · 고정 그리드 화면 아님`);continue;}
     recording=true;
     const reconstructed=reconstructGridArtwork({slots,grayFor:greyFor,match});
     recording=false;
     let accepted=0;
     for(const {slot,identity} of reconstructed){
      if(!identity)continue;accepted++;
      const previous=union.get(identity.id);
      if(!previous||identity.correlation>previous.corr)
       union.set(identity.id,{id:identity.id,name:identity.name,firstTime:previous?.firstTime??time,corr:identity.correlation,margin:identity.margin,slot:slot.slot,cropSha256:null});
     }
     frames.push({time,top:ROW_ORIGIN_Y,frameSha256,accepted,probeAccepted:probe});
     setStatus(`처리 중 ${time.toFixed(1)}s / ${duration.toFixed(1)}s · 합집합 ${union.size}/${EXPECTED} · 매니페스트 해시 계산`);
    }
    URL.revokeObjectURL(video.src);
    const cropSha256=new Map<string,string>();
    for(const [id,promise] of cropHashes)cropSha256.set(id,await promise);
    const unionList=[...union.values()].map(card=>({...card,cropSha256:cropSha256.get(card.id)??null}))
     .sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    const manifest=createGridReconstructionManifest({
     createdAt:new Date().toISOString(),
     input:{caseId:CASE_ID,sha256:inputInfo?.sha256??KNOWN_SHA,bytes:inputInfo?.bytes??KNOWN_BYTES,duration,width,height},
     settings:{stepSeconds:STEP_SECONDS,xs:[...XS],rowOriginY:ROW_ORIGIN_Y,pitchY:PITCH_Y,cardWidth:CARD_W,cardHeight:CARD_H,
      matcher:'fixed-scanner-rows 392/635/878/1121; portrait-atlas+screen-supplement+competitors; gates 0.91/0.94/0.20'},
     environment:{sourceDigest:environment?.sourceDigest??null,files:environment?.files??null,build:environment?.git?.head??null},
     frames,union:unionList,expected:EXPECTED,
    });
    let stored:Stored|null=null;
    try{
     const response=await fetch('/__corpus/grid-reconstruction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(manifest)});
     if(response.ok)stored=await response.json() as Stored;
    }catch{/* Dev server is optional; the client download remains. */}
    (window as unknown as {__gridVideoManifest?:GridReconstructionManifest}).__gridVideoManifest=manifest;
    (window as unknown as {__gridVideoStored?:Stored|null}).__gridVideoStored=stored;
    const result:Proof={frames,union:unionList,missing:Math.max(0,EXPECTED-unionList.length),expected:EXPECTED,duration,manifest,stored};
    if(!abort.signal.aborted){setProof(result);setStatus(`완료 · ${unionList.length}/${EXPECTED}종 · 프레임 ${frames.length}개 · 매니페스트 ${stored?'서버 저장':'다운로드 가능'}`);}
   }catch(error){if(!abort.signal.aborted)setStatus(`실패 · ${String(error).slice(0,300)}`);}
  })();
  return()=>abort.abort();
 },[]);
 const download=()=>{
  if(!proof)return;
  const blob=new Blob([JSON.stringify(proof.manifest,null,1)],{type:'application/json'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download='grid-reconstruction-manifest.json';anchor.click();URL.revokeObjectURL(url);
 };
 return <main style={{maxWidth:1100,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
  <h1>Video-7 고정 그리드 전체 재구성</h1>
  <p>비공개 video-7의 프레임을 0.05초 간격으로 읽어 고정 10×4 그리드(140×210)의 카드 원화 특징만으로 40칸을 식별하고 합집합을 만듭니다. 행 392/635/878/1121은 크롭 저널 <code>7bda02f4</code>의 스캐너 <code>sourceBox</code> 보정값이며, 카드는 스크롤에 따라 이 고정 박스 안에서 바뀝니다. 프레임·크롭 해시와 설정을 매니페스트로 기록하고, 개발 서버가 있으면 <code>/__corpus/grid-reconstruction</code>에 저장합니다. 헤더 수량 397은 기존 오프라인 실행(run-1d9142f7)의 기록값입니다.</p>
  <p role="status">{status}</p>
  {proof&&<>
   <p><strong>합집합 {proof.union.length}/{proof.expected}종</strong> · 누락 {proof.missing} · 프레임 {proof.frames.length}개(그리드 미검출 {proof.frames.filter(frame=>frame.top===null).length})</p>
   <p>{proof.stored?`매니페스트 저장: ${proof.stored.file} · sha256 ${proof.stored.sha256}`:'매니페스트 서버 저장 없음 · JSON 다운로드 사용'}</p>
   <button onClick={download}>매니페스트 JSON 다운로드</button>
   <details><summary>프레임별 수락 수와 프레임 해시</summary><pre style={{fontSize:11,maxHeight:220,overflow:'auto'}}>{proof.frames.map(frame=>`${frame.time.toFixed(2)}s top=${frame.top??'-'} accepted=${frame.accepted} probe=${frame.probeAccepted} sha=${frame.frameSha256.slice(0,12)}`).join('\n')}</pre></details>
   <details open><summary>합집합 카드 목록</summary><pre style={{fontSize:11,maxHeight:520,overflow:'auto'}}>{proof.union.map(card=>`${card.id}\t${card.name}\t${card.firstTime.toFixed(2)}s\t${card.corr.toFixed(3)}\t${card.margin.toFixed(3)}\t${card.cropSha256?.slice(0,12)??'—'}`).join('\n')}</pre></details>
  </>}
 </main>;
}
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
createRoot(document.getElementById('root')!).render(<ProofView/>);
