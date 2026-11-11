import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';

type Frame={file:string;bytes:number;pngSha256:string};
type Source={label:string;frames:Frame[]};
const run=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector<HTMLElement>('#status')!,
 result=document.querySelector<HTMLElement>('#result')!;
const fail=(message:string):never=>{throw Error(message);};
async function json(url:string){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();}
function canonical(value:unknown):unknown {
 if(ArrayBuffer.isView(value))return Array.from(value as unknown as ArrayLike<number>);
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
function metadata(value:object){
 // Tokens contain a per-client random namespace. Their equality/reuse
 // relationships are checked separately as a bijection across all frames.
 const {image:_image,previewImage:_preview,cropState:_state,originalWidth:_width,originalHeight:_height,pixelKey:_pixel,fieldRevision:_revision,...rest}=value as Record<string,unknown>;
 return JSON.stringify(canonical(rest));
}
async function rasterHash(canvas:HTMLCanvasElement){
 const data=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;
 return pixelHash(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
}
run.onclick=()=>void (async()=>{
 run.disabled=true;status.textContent='준비 중';result.textContent='';
 const controller=new AbortController();
 const base=createAcquisitionClient(controller.signal),reduced=createAcquisitionClient(controller.signal,{experimentalRejectedTransport:true});
 const rows:{source:string;frame:number;inputSha256:string;cells:number;omitted:number;retained:number;metadataEqual:boolean;retainedPixelsEqual:boolean;layoutEqual:boolean;
  tokenMismatches:number;order:'normal-first'|'reduced-first';normalTiming:unknown;reducedTiming:unknown}[]=[];
 const pixelForward=new Map<string,string>(),pixelReverse=new Map<string,string>(),fieldForward=new Map<string,string>(),fieldReverse=new Map<string,string>();
 const sameToken=(first:unknown,second:unknown,forward:Map<string,string>,reverse:Map<string,string>)=>{
  if(first===undefined||second===undefined)return first===second;
  if(typeof first!=='string'||typeof second!=='string')return false;
  if(forward.has(first)||reverse.has(second))return forward.get(first)===second&&reverse.get(second)===first;
  forward.set(first,second);reverse.set(second,first);return true;
 };
 try {
  if(!reduced.detectAndAcquireReduced)fail('Worker experimental transport unavailable');
  const root='/work/detector-bench-frames-v1/',manifest=await json(`${root}manifest.json`) as {version:number;sources:Source[]};
  if(manifest.version!==1||!Array.isArray(manifest.sources)||manifest.sources.length<1||manifest.sources.length>16)fail('Invalid local frame manifest');
  const sourceStart=await json('/__corpus/environment');
  await Promise.all([base.ready(),reduced.ready()]);
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true})!;
  for(const source of manifest.sources){
   if(!/^[a-zA-Z0-9_-]{1,40}$/.test(source.label)||!Array.isArray(source.frames)||source.frames.length<1||source.frames.length>1000)fail('Invalid frame source');
   for(const [index,frame] of source.frames.entries()){
    if(frame.file!==`${source.label}/${String(index).padStart(3,'0')}.png`)fail('Invalid frame path');
    status.textContent=`프레임 ${rows.length+1} 검사 중`;
    const response=await fetch(`${root}${frame.file}`,{cache:'no-store'});if(!response.ok)fail('Missing frame');
    const data=await response.arrayBuffer();
    if(data.byteLength!==frame.bytes||await pixelHash(new Uint8Array(data))!==frame.pngSha256)fail('PNG hash mismatch');
    const bitmap=await createImageBitmap(new Blob([data],{type:'image/png'}));
    try{canvas.width=bitmap.width;canvas.height=bitmap.height;context.globalCompositeOperation='copy';context.drawImage(bitmap,0,0);}finally{bitmap.close();}
    const inputSha256=await rasterHash(canvas);
    // Alternate order while both independent clients see all frames in the
    // same source order. These timings remain diagnostic, not causal proof.
    const normalFirst=rows.length%2===0;
    let normal:Awaited<ReturnType<typeof base.detectAndAcquire>>;
    let candidate:Awaited<ReturnType<NonNullable<typeof reduced.detectAndAcquireReduced>>>;
    if(normalFirst){normal=await base.detectAndAcquire(canvas,index);candidate=await reduced.detectAndAcquireReduced!(canvas,index);}
    else{candidate=await reduced.detectAndAcquireReduced!(canvas,index);normal=await base.detectAndAcquire(canvas,index);}
    try{
     const layoutEqual=JSON.stringify(canonical(normal.layout))===JSON.stringify(canonical(candidate.layout));
     if(normal.cells.length!==candidate.cells.length)fail('Cell count mismatch');
     let metadataEqual=true,retainedPixelsEqual=true,omitted=0,retained=0,tokenMismatches=0;const seen=new Set<string>();
     for(let i=0;i<normal.cells.length;i++){
      const first=normal.cells[i],next=candidate.cells[i];
      metadataEqual&&=metadata(first)===metadata(next);
      if(!sameToken(first.pixelKey,next.pixelKey,pixelForward,pixelReverse))tokenMismatches++;
      if(!sameToken(first.fieldRevision,next.fieldRevision,fieldForward,fieldReverse))tokenMismatches++;
      if(next.cropState==='omitted-rejected'){
       if(next.quality.usable||!seen.has(next.quality.reason)||next.image!==null||next.originalWidth!==first.image.width||next.originalHeight!==first.image.height)
        fail('Invalid omitted crop');
       omitted++;
      }else{
       retained++;
       if(!next.image||first.image.width!==next.image.width||first.image.height!==next.image.height||await rasterHash(first.image)!==await rasterHash(next.image))retainedPixelsEqual=false;
      }
      if(!next.quality.usable)seen.add(next.quality.reason);
     }
     if(await rasterHash(canvas)!==inputSha256)fail('Input canvas changed between acquisitions');
     rows.push({source:source.label,frame:index,inputSha256,cells:normal.cells.length,omitted,retained,metadataEqual,retainedPixelsEqual,layoutEqual,tokenMismatches,
      order:normalFirst?'normal-first':'reduced-first',normalTiming:normal.timing??null,reducedTiming:candidate.timing??null});
    }finally{
     for(const cell of normal.cells){cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;}
     for(const cell of candidate.cells){if(cell.image)cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;}
    }
   }
  }
  const sourceEnd=await json('/__corpus/environment');
  if(!/^[a-f0-9]{64}$/.test(sourceStart.sourceDigest??'')||!/^[a-f0-9]{64}$/.test(sourceEnd.sourceDigest??''))fail('Source digest unavailable');
  const sourceChanged=sourceStart.sourceDigest!==sourceEnd.sourceDigest;
  const summary={frames:rows.length,cells:rows.reduce((n,row)=>n+row.cells,0),omitted:rows.reduce((n,row)=>n+row.omitted,0),
   metadataMismatches:rows.filter(row=>!row.metadataEqual).length,pixelMismatches:rows.filter(row=>!row.retainedPixelsEqual).length,
   layoutMismatches:rows.filter(row=>!row.layoutEqual).length,tokenMismatches:rows.reduce((n,row)=>n+row.tokenMismatches,0),sourceChanged};
  result.textContent=JSON.stringify({summary,sourceStart,sourceEnd,rows,
   boundary:'Same immutable page canvas to separate Workers; worker input pixels not independently attested. Retained crop pixels and metadata only; omitted crops, OCR, end-to-end scanner and real-time speed are not verified. Sequential alternating timings include measurement overhead and are not causal speed proof.'},null,2);
  status.textContent=sourceChanged||summary.metadataMismatches||summary.pixelMismatches||summary.layoutMismatches||summary.tokenMismatches?'차이 또는 소스 변경 확인 필요':'저장 프레임 비교 완료';
 }catch(error){status.textContent=String(error);}
 finally{controller.abort();base.dispose();reduced.dispose();run.disabled=false;}
})();
