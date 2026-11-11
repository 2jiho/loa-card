import {createDetector} from '../src/features/card-scanner/acquisition/detector';
import {createCardAcquirer} from '../src/features/card-scanner/acquisition/card-acquisition';
import {frameObstructionCandidates} from '../src/features/card-scanner/acquisition/frame-obstruction-candidate';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';

const input=document.querySelector<HTMLInputElement>('#manifest')!,run=document.querySelector<HTMLButtonElement>('#run')!,stop=document.querySelector<HTMLButtonElement>('#stop')!;
const status=document.querySelector<HTMLElement>('#status')!,output=document.querySelector<HTMLElement>('#result')!;
const page=new AbortController();let active:AbortController|undefined;
type Detector=Awaited<ReturnType<typeof createDetector>>;
type Ref={name:string;sha256:string;bytes:number};
type Sample={frameOrdinal:number;framePtsSeconds:number;slot:number;box:{x:number;y:number;width:number;height:number};fullFrame:Ref;visualReview:{label:string;humanConfirmed:boolean;authority:string}};
async function fetchBounded(path:string,max:number,signal:AbortSignal){
 const response=await fetch(path,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),redirect:'error'});
 if(!response.ok||!response.body)throw Error(`입력 응답 오류 ${response.status}`);
 if(Number(response.headers.get('content-length'))>max)throw Error('입력 크기 한도 초과');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
 try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>max)throw Error('입력 크기 한도 초과');parts.push(item.value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function snapshot(signal:AbortSignal){const bytes=await fetchBounded('/__corpus/environment',256*1024,signal),data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!/^[a-f0-9]{64}$/.test(data?.sourceDigest))throw Error('소스 해시가 없습니다.');return data;}
function wait<T>(promise:Promise<T>,signal:AbortSignal,onLate?:(value:T)=>void){return new Promise<T>((resolve,reject)=>{
 let ended=false;const cleanup=()=>signal.removeEventListener('abort',abort),abort=()=>{if(ended)return;ended=true;cleanup();reject(signal.reason);};
 promise.then(value=>{if(ended){onLate?.(value);return;}ended=true;cleanup();resolve(value);},error=>{if(ended)return;ended=true;cleanup();reject(error);});
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
run.addEventListener('click',async()=>{
 if(active)return;const name=input.value.trim();if(!/^[a-f0-9]{64}\.json$/.test(name)){status.textContent='내용 해시로 된 manifest 파일명을 입력하세요.';return;}
 const controller=new AbortController();active=controller;const signal=AbortSignal.any([page.signal,controller.signal,AbortSignal.timeout(240000)]);
 run.disabled=input.disabled=true;stop.disabled=false;output.textContent='';let detector:Detector|undefined,startSource:Awaited<ReturnType<typeof snapshot>>|null=null,endSource:Awaited<ReturnType<typeof snapshot>>|null=null;
 const rows:Record<string,unknown>[]=[],started=performance.now();let selectedCount:number|null=null,error:string|null=null,inputSource:unknown=null;
 try{
  status.textContent='프레임 목록과 코드 해시를 확인하고 있습니다.';startSource=await snapshot(signal);
  const bytes=await fetchBounded(`/work/obstruction-samples/${name}`,1024*1024,signal);if(await pixelHash(bytes)!==name.slice(0,64))throw Error('manifest 해시 불일치');
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(manifest?.kind!=='private-obstruction-samples'||manifest.version!==1||manifest.source?.caseId!=='93496e841f6b4f03d9c09ec45e7854eb59478285118223f0daa4b9fccfc6fce8'||
   !/^[a-f0-9]{64}$/.test(manifest.source?.sha256)||!Array.isArray(manifest.samples)||manifest.samples.length<1||manifest.samples.length>100)throw Error('유효하지 않은 manifest');
  inputSource={...manifest.source,integrity:'manifest declaration; original video not read by this browser tool'};
  const frames=new Map<number,{ordinal:number;pts:number;image:Ref;reviews:{slot:number;box:Sample['box'];visualReview:Sample['visualReview']}[]}>();
  for(const item of manifest.samples as Sample[]){
   if(!Number.isSafeInteger(item.frameOrdinal)||item.frameOrdinal<0||!Number.isFinite(item.framePtsSeconds)||!item.fullFrame||
    !/^[a-f0-9]{64}\.png$/.test(item.fullFrame.name)||item.fullFrame.sha256!==item.fullFrame.name.slice(0,64)||!Number.isSafeInteger(item.fullFrame.bytes)||item.fullFrame.bytes<1||item.fullFrame.bytes>32*1024*1024||
    !Number.isSafeInteger(item.slot)||item.slot<0||item.slot>=40||!item.box||![item.box.x,item.box.y,item.box.width,item.box.height].every(Number.isSafeInteger)||
    item.visualReview?.humanConfirmed!==false||item.visualReview.authority!=='assistant-visual-review')throw Error('유효하지 않은 프레임 참조 또는 레이블');
   const existing=frames.get(item.frameOrdinal);if(existing&&(existing.pts!==item.framePtsSeconds||existing.image.name!==item.fullFrame.name))throw Error('한 프레임의 참조가 다릅니다.');
   const review={slot:item.slot,box:item.box,visualReview:item.visualReview};
   if(existing)existing.reviews.push(review);else frames.set(item.frameOrdinal,{ordinal:item.frameOrdinal,pts:item.framePtsSeconds,image:item.fullFrame,reviews:[review]});
  }
  selectedCount=frames.size;status.textContent='프레임 검출기를 준비하고 있습니다.';
  detector=await wait(createDetector(),signal,late=>late.dispose());const acquire=createCardAcquirer((width,height)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;});
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('캔버스 없음');
  for(const entry of frames.values()){
   signal.throwIfAborted();status.textContent=`선택 프레임 ${rows.length+1} / ${frames.size} 검사 중`;
   const png=await fetchBounded(`/work/obstruction-samples/${entry.image.name}`,32*1024*1024,signal);
   if(png.length!==entry.image.bytes||await pixelHash(png)!==entry.image.sha256)throw Error('원본 프레임 PNG 해시 불일치');
   const bitmap=await wait(createImageBitmap(new Blob([Uint8Array.from(png)],{type:'image/png'})),signal,late=>late.close());
   try{if(bitmap.width!==2560||bitmap.height!==1440)throw Error('프레임 크기 불일치');canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);}finally{bitmap.close();}
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,rasterSha256=await pixelHash(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
   // A fresh detector makes this a global detection per frame, not past live tracking.
   detector.detect({width:0,height:0} as HTMLCanvasElement);
   let at=performance.now();const layout=detector.detect(canvas),detectionMs=performance.now()-at;
   if(!layout){rows.push({frameOrdinal:entry.ordinal,framePtsSeconds:entry.pts,framePngSha256:entry.image.sha256,rasterSha256,reviews:entry.reviews,
    detection:{status:'not-located',elapsedMs:detectionMs},acquisition:null,candidate:null});continue;}
   at=performance.now();const cells=acquire(canvas,layout),acquisitionMs=performance.now()-at;
   try{
    at=performance.now();const found=frameObstructionCandidates(pixels,canvas.width,canvas.height,layout.cells.map((box,i)=>({...box,intact:cells[i].intact})));
    const candidateMs=performance.now()-at;
    rows.push({frameOrdinal:entry.ordinal,framePtsSeconds:entry.pts,framePngSha256:entry.image.sha256,rasterSha256,reviews:entry.reviews,
     detection:{status:'located',elapsedMs:detectionMs,layout},acquisition:{elapsedMs:acquisitionMs,cells:cells.map(c=>({slot:c.slot,content:c.content,
      complete:c.complete,intact:c.intact,borderSides:c.borderSides,alignment:c.alignment,labelVisible:c.labelVisible,quality:c.quality,preBorder:c.preBorder??null}))},
     candidate:{elapsedMs:candidateMs,result:found,status:found===null?'invalid-or-unsupported':found.truncated?'truncated':found.supported?'searched':'unsupported'}});
   }finally{for(const cell of cells){cell.image.width=0;cell.image.height=0;}}
  }
  canvas.width=canvas.height=0;
 }catch(failure){error=String(failure).slice(0,2000);}
 finally{
  detector?.dispose();try{endSource=await snapshot(page.signal);}catch{/* Unknown source is never stable. */}
  const sourceChanged=startSource&&endSource?startSource.sourceDigest!==endSource.sourceDigest:null;
  const complete=error===null&&!signal.aborted&&sourceChanged===false&&selectedCount!==null&&rows.length===selectedCount;
  output.textContent=JSON.stringify({version:1,kind:'offline-full-frame-obstruction-proof',complete,error,manifest:name,sourceStart:startSource,sourceEnd:endSource,sourceChanged,
   inputSource,selectedCount,processed:rows.length,unprocessed:selectedCount===null?null:selectedCount-rows.length,elapsedMs:performance.now()-started,rows,
   scope:'Selected ffmpeg-derived frames rerun through current global detector and acquirer. Not original live frame delivery, full input coverage, human truth, model recognition, automatic stop, or live speed.'},null,2);
  status.textContent=complete?`선택 프레임 ${rows.length}개 검사 완료 · 각 후보의 미지원·잘림 여부 확인`:`부분 검사 · ${error??'소스·입력·취소 상태 미확인'}`;
  if(active===controller)active=undefined;run.disabled=input.disabled=false;stop.disabled=true;
 }
});
stop.addEventListener('click',()=>active?.abort());window.addEventListener('pagehide',()=>{page.abort();active?.abort();});
if(import.meta.hot){const invalidate=()=>active?.abort();import.meta.hot.on('vite:beforeUpdate',invalidate);import.meta.hot.dispose(()=>{invalidate();page.abort();import.meta.hot?.off('vite:beforeUpdate',invalidate);});}
