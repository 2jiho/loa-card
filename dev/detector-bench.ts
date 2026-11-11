import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
type Frame={ordinal:number;presentationTimeSeconds:number;file:string;bytes:number;pngSha256:string};
type Source={label:string;sourceSha256:string;sourceBytes:number;frames:Frame[]};
type Result={id:number;error?:string;ready?:boolean;disposed?:boolean;width?:number;height?:number;rasterSha256?:string;
 global?:{layout:unknown;elapsedMs:number;stages:unknown[]}[];tracked?:{layout:unknown;elapsedMs:number;stages:unknown[]}[]};
const status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!;
const start=document.querySelector<HTMLButtonElement>('#run')!,save=document.querySelector<HTMLButtonElement>('#save')!;
let report='';
async function hash(data:ArrayBuffer){return pixelHash(new Uint8Array(data));}
async function json(url:string){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();}
start.onclick=()=>void (async()=>{
 start.disabled=true;save.disabled=true;report='';const worker=new Worker(new URL('./detector-bench-worker.ts',import.meta.url),{type:'module'});
 let id=0,success=false;const pending=new Map<number,{resolve:(value:Result)=>void;reject:(reason:unknown)=>void}>();
 worker.onmessage=(event:MessageEvent<Result>)=>{const value=event.data,entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);
  if(value.error)entry.reject(Error(value.error));else entry.resolve(value);};
 worker.onerror=event=>{for(const entry of pending.values())entry.reject(Error(event.message));pending.clear();};
 const send=(kind:'setup'|'frame'|'dispose',bitmap?:ImageBitmap)=>new Promise<Result>((resolve,reject)=>{
  const request=++id;pending.set(request,{resolve,reject});worker.postMessage({kind,id:request,bitmap},bitmap?[bitmap]:[]);});
 try {
  const dataset=new URLSearchParams(location.search).get('dataset')??'detector-bench-frames-v1';
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(dataset))throw Error('Invalid local dataset name');
  const ROOT=`/work/${dataset}/`;
  const manifest=await json(`${ROOT}manifest.json`) as {version:number;sources:Source[]};
  const sourceStart=await json('/__corpus/environment');await send('setup');
  const rows:{source:string;frame:Frame;pageRasterSha256:string;worker:Result;equal:boolean}[]=[];
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true})!;
  if(manifest.version!==1||!Array.isArray(manifest.sources)||manifest.sources.length<1||manifest.sources.length>16)throw Error('Invalid local frame manifest');
  const labels=new Set<string>();
  for(const source of manifest.sources){
   if(!/^[a-zA-Z0-9_-]{1,40}$/.test(source.label)||labels.has(source.label)||!Array.isArray(source.frames)||source.frames.length<1||source.frames.length>1000)throw Error('Invalid local frame source');
   labels.add(source.label);
   for(const [index,frame] of source.frames.entries()){
   if(frame.file!==`${source.label}/${String(index).padStart(3,'0')}.png`)throw Error('Invalid local frame path');
   status.textContent=`프레임 검증 ${rows.length+1} / ${manifest.sources.reduce((n,s)=>n+s.frames.length,0)}`;
   const response=await fetch(`${ROOT}${frame.file}`,{cache:'no-store'});if(!response.ok)throw Error('Missing frame');
   const bytes=await response.arrayBuffer();if(bytes.byteLength!==frame.bytes||await hash(bytes)!==frame.pngSha256)throw Error('PNG hash mismatch');
   const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
   canvas.width=bitmap.width;canvas.height=bitmap.height;context.globalCompositeOperation='copy';context.drawImage(bitmap,0,0);bitmap.close();
   const rgba=context.getImageData(0,0,canvas.width,canvas.height).data,pageRasterSha256=await pixelHash(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength));
   const measured=await send('frame',await createImageBitmap(canvas));
   if(measured.rasterSha256!==pageRasterSha256)throw Error('Worker canvas pixels differ from source canvas');
   const global=measured.global!,tracked=measured.tracked!;
   const equal=JSON.stringify(global[0].layout)===JSON.stringify(global[1].layout)&&
     JSON.stringify(global[0].layout)===JSON.stringify(global[2].layout)&&
     JSON.stringify(global[0].layout)===JSON.stringify(global[3].layout)&&
     JSON.stringify(tracked[0].layout)===JSON.stringify(tracked[1].layout);
   rows.push({source:source.label,frame,pageRasterSha256,worker:measured,equal});
   }
  }
  await send('dispose');const sourceEnd=await json('/__corpus/environment');
  const counts={frames:rows.length,equal:rows.filter(row=>row.equal).length,globalLocated:rows.filter(row=>row.worker.global![0].layout!==null).length,
   globalNotLocated:rows.filter(row=>row.worker.global![0].layout===null).length};
  const reportObject={version:1,kind:'same-worker-raster-detector-benchmark',complete:true,manifest,sourceStart,sourceEnd,
   sourceChanged:sourceStart.sourceDigest!==sourceEnd.sourceDigest,counts,rows,
   boundary:'ffmpeg decoded PNG and exact browser worker canvas pixels, not a past captureStream frame; detector only, no OCR, capture or main UI. Sequential paired timings are not a causal speed measurement.'};
  report=JSON.stringify(reportObject,null,2);result.textContent=JSON.stringify({counts,sourceChanged:reportObject.sourceChanged},null,2);
  status.textContent=counts.equal===counts.frames?'완료: 모든 페어 결과 동일':'완료: 결과 차이 확인 필요';save.disabled=false;success=true;
 }catch(error){status.textContent=String(error);}
 finally {worker.terminate();for(const entry of pending.values())entry.reject(Error('Worker terminated'));start.disabled=false;if(!success)save.disabled=true;}
})();
save.onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([report],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`loacard-detector-bench-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
