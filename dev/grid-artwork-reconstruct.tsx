import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';
import {reconstructGridArtwork} from '../src/features/card-scanner/session/grid-artwork-reconstruction';
import type {GridCardSlot} from '../src/features/card-scanner/session/grid-artwork-reconstruction';
import type {Reference} from '../src/features/card-scanner/recognition/recognizer';

/** Dev-only reconstruction proof. Fixed 140x210 grid boxes come from the
 * screenshot's recorded reader calibration; identity uses card-art features
 * only (no OCR name text). This is not scanner.ts completion evidence. */
const SCREENSHOT='/__corpus/cases/c02978b2bc5eb1fffdbb02106893bfbba0dccac89e57a5569c1c9c916cf48948/input/0';
const BOXES:readonly [slot:number,x:number,y:number][]=[
 [0,138,392],[1,295,392],[2,453,392],[3,610,392],[4,767,392],[5,924,392],[6,1082,392],[7,1239,392],[8,1396,392],[9,1554,392],
 [10,138,635],[11,295,635],[12,453,635],[13,610,635],[14,767,635],[15,924,635],[16,1081,635],[17,1239,635],[18,1396,635],[19,1553,635],
 [20,138,878],[21,295,878],[22,453,878],[23,609,878],[24,767,878],[25,924,878],[26,1081,878],[27,1239,878],[28,1396,878],[29,1553,878],
 [30,138,1121],[31,295,1121],[32,453,1121],[33,609,1121],[34,767,1121],[35,924,1121],[36,1081,1121],[37,1239,1121],[38,1396,1121],[39,1553,1121],
];
interface Row {slot:number;x:number;y:number;id:string|null;name:string|null;topId:string|null;topName:string|null;
 top2Name:string|null;upper:number|null;lower:number|null;correlation:number|null;margin:number|null;reason:string|null;accepted:boolean}
interface Payload {cards:Reference[]}
interface Atlas {[id:string]:string}
interface Supplement {cards:Atlas}
interface Competitors {cards:Atlas}
async function getJson<T>(url:string):Promise<T>{const response=await fetch(url);if(!response.ok)throw Error(`${url} ${response.status}`);return response.json() as Promise<T>;}

// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function Proof(){
 const [rows,setRows]=useState<Row[]>([]),[status,setStatus]=useState('에셋과 스크린샷을 불러오는 중');
 useEffect(()=>{
  const abort=new AbortController();
  void (async()=>{
   try{
    const [catalog,atlas,screen,competitors]=await Promise.all([
     getJson<Payload>('/scanner/cards.json'),getJson<Atlas>('/scanner/artwork-details.json'),
     getJson<Supplement>('/scanner/screen-artwork-details.json'),getJson<Competitors>('/scanner/portrait-competitors.json')]);
    if(abort.signal.aborted)return;
    const names=new Map(catalog.cards.map(card=>[card.id,card.name]));
    const matcher=createPortraitMatcher(catalog.cards,atlas,screen.cards,{competitors:competitors.cards});
    const imageResponse=await fetch(SCREENSHOT,{cache:'no-store'});
    if(!imageResponse.ok)throw Error(`스크린샷 ${imageResponse.status}`);
    const screenshotUrl=URL.createObjectURL(await imageResponse.blob());
    const image=new Image();image.src=screenshotUrl;await image.decode();
    if(abort.signal.aborted)return;
    const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
    const context=canvas.getContext('2d',{willReadFrequently:true})!;
    const slots:GridCardSlot[]=BOXES.map(([slot,x,y])=>({slot,x,y,width:140,height:210}));
    type Diagnostic={topId:string|null;top2Id:string|null;upper:number|null;lower:number|null;
     correlation:number|null;margin:number|null;reason:string|null};
    const diagnostics=new Map<number,Diagnostic>();
    const reconstructed=reconstructGridArtwork({slots,
     grayFor:slot=>{
      context.clearRect(0,0,140,210);
      context.drawImage(image,slot.x,slot.y,slot.width,slot.height,0,0,140,210);
      return areaGray(context.getImageData(0,0,140,210).data,140,210);
     },
     match:(gray,slot)=>{
      const result=matcher(gray,undefined,diagnostic=>{
       const stage=diagnostic.stages[0],first=stage?.candidates[0],second=stage?.candidates[1];
       diagnostics.set(slot.slot,{topId:first?.id??null,top2Id:second?.id??null,upper:first?.upper??null,
        lower:first?.lower??null,correlation:first?.correlation??null,margin:first?.margin??null,reason:diagnostic.reason});
      });
      return result?{id:result.card.id,name:result.card.name,
       correlation:result.portrait.correlation,margin:result.portrait.margin}:null;
     }});
    URL.revokeObjectURL(screenshotUrl);
    const next:Row[]=reconstructed.map(({slot,identity})=>{
     const diagnostic=diagnostics.get(slot.slot),topId=diagnostic?.topId??null,top2Id=diagnostic?.top2Id??null;
     return {slot:slot.slot,x:slot.x,y:slot.y,id:identity?.id??null,name:identity?.name??null,topId,
      topName:topId?names.get(topId)??topId:null,top2Name:top2Id?names.get(top2Id)??top2Id:null,
      upper:diagnostic?.upper??null,lower:diagnostic?.lower??null,
      correlation:diagnostic?.correlation??identity?.correlation??null,
      margin:diagnostic?.margin??identity?.margin??null,reason:diagnostic?.reason??null,accepted:!!identity};
    });
    if(!abort.signal.aborted){setRows(next);setStatus(`완료 · 원화만으로 ${next.filter(row=>row.accepted).length}/40칸 식별`);}
   }catch(error){if(!abort.signal.aborted)setStatus(`실패 · ${String(error).slice(0,300)}`);}
  })();
  return()=>abort.abort();
 },[]);
 const accepted=rows.filter(row=>row.accepted);
 const fmt=(value:number|null,digits=3)=>value===null?'—':value.toFixed(digits);
 return <main style={{maxWidth:1100,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
  <h1>고정 그리드 원화 재구성 검사</h1>
  <p>게임 화면의 고정 40칸(140×210)을 잘라 <strong>카드 원화 특징만으로</strong> 카드 ID를 식별합니다. OCR 이름 텍스트는 사용하지 않습니다. 합성·개발 검증용이며 실제 스캐너 완료 판정 증거가 아닙니다.</p>
  <p role="status">{status}</p>
  {rows.length>0&&<>
   <p>수락 {accepted.length}/40</p>
   <div style={{overflowX:'auto'}}>
    <table style={{borderCollapse:'collapse',fontSize:12,minWidth:900}}>
     <thead><tr>{['칸','위치','식별','상위 후보','2위','upper','lower','corr','margin','사유'].map(h=><th key={h} style={{borderBottom:'1px solid #555',padding:'4px 8px',textAlign:'left'}}>{h}</th>)}</tr></thead>
     <tbody>{rows.map(row=><tr key={row.slot} style={{background:row.accepted?'transparent':'rgba(200,60,60,.12)'}}>
      <td style={{padding:'3px 8px'}}>{row.slot}</td>
      <td style={{padding:'3px 8px'}}>{row.x},{row.y}</td>
      <td style={{padding:'3px 8px'}}>{row.accepted?`${row.name} (${row.id})`:'—'}</td>
      <td style={{padding:'3px 8px'}}>{row.topName??'—'}</td>
      <td style={{padding:'3px 8px'}}>{row.top2Name??'—'}</td>
      <td style={{padding:'3px 8px'}}>{fmt(row.upper)}</td>
      <td style={{padding:'3px 8px'}}>{fmt(row.lower)}</td>
      <td style={{padding:'3px 8px'}}>{fmt(row.correlation)}</td>
      <td style={{padding:'3px 8px'}}>{fmt(row.margin)}</td>
      <td style={{padding:'3px 8px'}}>{row.reason??'—'}</td>
     </tr>)}</tbody>
    </table>
   </div>
  </>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Proof/>);
