import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';
import {parseScannerNameConfiguration,NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/session/scanner-name-configuration';
import {cropDigest,readPairedCropArchive} from './paired-crop-replay-core';

const file=document.querySelector<HTMLInputElement>('#file')!,run=document.querySelector<HTMLButtonElement>('#run')!;
const status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!;
const localReport=new URLSearchParams(location.search).get('report');
if(localReport&&/^[a-z0-9-]+-[a-f0-9]{64}\.json$/.test(localReport)){
 run.disabled=false;status.textContent='로컬 검증 보고서가 선택되었습니다.';
}
file.addEventListener('change',()=>{run.disabled=!file.files?.length;result.textContent='';});
run.addEventListener('click',async()=>{
 const selected=file.files?.[0];if(!selected&&!localReport)return;run.disabled=true;file.disabled=true;
 const rows:unknown[]=[];let error:string|null=null,omitted=0,configurationRecorded=false,producerComplete=false,identified=0,readErrors=0;
 try {
  let bytes:Uint8Array;
  if(selected){if(selected.size>16*1024*1024)throw Error('결과 파일 크기 한도 초과');bytes=new Uint8Array(await selected.arrayBuffer());}
  else{
   if(!localReport||!/^[a-z0-9-]+-[a-f0-9]{64}\.json$/.test(localReport))throw Error('잘못된 로컬 보고서 이름');
   const response=await fetch(`/work/${localReport}`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('로컬 보고서를 찾을 수 없습니다');
   const blob=await response.blob();if(blob.size>16*1024*1024)throw Error('결과 파일 크기 한도 초과');
   bytes=new Uint8Array(await blob.arrayBuffer());
   if(await cropDigest(bytes)!==localReport.slice(-69,-5))throw Error('로컬 보고서 SHA-256 불일치');
  }
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),archive=await readPairedCropArchive(raw);
  omitted=archive.omitted;producerComplete=archive.producerComplete;
  const candidate=raw?.runtimeConfiguration?.nameConfiguration;
  const configuration=candidate===undefined?NORMAL_SCANNER_NAME_CONFIGURATION:parseScannerNameConfiguration(candidate);
  configurationRecorded=candidate!==undefined;
  for(const crop of archive.crops){
   status.textContent=`선택 판독 ${rows.length+1} / ${archive.crops.length} · 입력 해시 확인`;
   const bitmap=await createImageBitmap(new Blob([Uint8Array.from(crop.png)],{type:'image/png'}));
   const canvas=document.createElement('canvas');let reader:Awaited<ReturnType<typeof createRecognizer>>|undefined;
   try{
    if(bitmap.width!==crop.width||bitmap.height!==crop.height)throw Error('PNG 크기 불일치');
    canvas.width=crop.width;canvas.height=crop.height;const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw Error('캔버스를 사용할 수 없습니다');
    context.drawImage(bitmap,0,0);bitmap.close();
    const raster=context.getImageData(0,0,crop.width,crop.height).data;
    if(await cropDigest(raster)!==crop.rgbaSha256)throw Error('복호화 RGBA 해시 불일치');
    status.textContent=`선택 판독 ${rows.length+1} / ${archive.crops.length} · 판독 중`;
    const abort=new AbortController();reader=await createRecognizer(()=>{},abort.signal,configuration);
    const budget=new CardReadBudget(3000);
    let identity:Awaited<ReturnType<typeof reader.identify>>=null,fields:Awaited<ReturnType<typeof reader.read>>|null=null,readError:string|null=null;
    try{await budget.wait(async()=>{
      identity=crop.stage==='visual'?await reader!.identifyVisual(canvas):await reader!.identify(canvas,crop.stage==='full',crop.stable,crop.borderAlignment>=.8,budget);
      if(identity)fields=await reader!.read(canvas,identity.id,false,true,budget);
    },()=>abort.abort(new CardReadTimeout()));}catch(e){readError=String(e);}finally{abort.abort();}
    if(identity)identified++;if(readError)readErrors++;
    rows.push({readId:crop.readId,processingFrame:crop.processingFrame,slot:crop.slot,source:{sessionId:crop.sessionId,
      frameId:crop.sourceFrame,observationId:crop.observationId,captureTime:crop.captureTime,captureOrder:crop.captureOrder,phase:crop.phase},
      shared:crop.shared,pngSha256:crop.pngSha256,rgbaSha256:crop.rgbaSha256,identity,fields,error:readError});
   }finally{bitmap.close();canvas.width=canvas.height=0;await reader?.dispose();}
  }
 }catch(e){error=String(e);}
 result.textContent=JSON.stringify({version:1,kind:'selected-crop-reread',completed:error===null&&rows.length>0&&readErrors===0&&omitted===0&&producerComplete,
  identified,unidentified:rows.length-identified,readErrors,producerReportedComplete:producerComplete,omitted,configurationRecorded,error,rows,
  scope:'Selected crops only; image hashes checked. No acquisition, source-frame reconstruction, capture timing, cache/worker schedule, full scan or ground truth is proven. Shared crop references are not independent observations.'},null,2);
 status.textContent=error?'검사 중단':rows.length?`선택 크롭 판독 종료 · 이름 식별 ${identified} / ${rows.length}`:'판독 가능한 크롭 없음';run.disabled=false;file.disabled=false;
});
