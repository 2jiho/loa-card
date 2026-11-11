import type {Layout} from '../src/features/card-scanner/acquisition/detector';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import {parsePreparedCropProof} from '../src/features/card-scanner/acquisition/prepared-crop-proof-client';
import type {PixelRaster} from '../src/features/card-scanner/acquisition/pixel-raster';

// This page generates every byte locally. It does not read a video, screen,
// archive, card fixture or user-supplied file. Results test only this synthetic
// manual layout and actual browser Worker/transfer boundaries.
const run=document.querySelector<HTMLButtonElement>('#run')!;
const status=document.querySelector<HTMLElement>('#status')!;
const output=document.querySelector<HTMLPreElement>('#output')!;
const width=152,height=222;
const box={x:6,y:6,width:140,height:210};
const empty={x:0,y:0,width:1,height:1};
const layout:Layout={cells:[box],area:{x:0,y:0,width,height},scale:1,header:empty,growthPoints:empty,
  sort:empty,scrollbar:empty,growthScore:0,score:0};
type WireCell={slot:number;content:typeof box;complete:boolean;pixels?:PixelRaster;bitmap?:ImageBitmap;previewBitmap?:ImageBitmap};
type Reply={id:number;error?:string;cells?:WireCell[];layout?:Layout;rasterReceipt?:unknown;experimentalCropProof?:unknown;
  timing?:{workerMs?:number;cropMs?:number;rasterHashMs?:number}};
function assert(value:unknown,reason:string):asserts value {if(!value)throw Error(reason);}
function raster(alpha:number):Uint8Array<ArrayBuffer>{
  const data=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    data[i]=(x*11+y*7)%256;data[i+1]=(x*3+y*13)%256;data[i+2]=(x*5+y*17)%256;data[i+3]=alpha;
  }
  return data;
}
function close(value:Reply){for(const cell of value.cells??[]){cell.bitmap?.close();cell.previewBitmap?.close();}}
async function request(worker:Worker,id:number,alpha:number){
  const pixels=raster(alpha),before=pixels.slice(),inputHash=await pixelHash(before),start=performance.now();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const response=new Promise<Reply>((resolve,reject)=>{
    const cleanup=()=>{worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);if(timer!==undefined)clearTimeout(timer);};
    const onMessage=(event:MessageEvent<Reply>)=>{if(event.data?.id!==id)return;cleanup();resolve(event.data);};
    const onError=(event:ErrorEvent)=>{cleanup();reject(Error(event.message||'worker error'));};
    worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);
    timer=setTimeout(()=>{cleanup();reject(Error('worker response timeout'));},15_000);
    try{worker.postMessage({kind:'prepared',id,prepared:{width,height,pixels,binding:{sourceFrameId:100+id,captureTime:id}},
      layout,pixelTransport:true,experimentalCropProof:true},[pixels.buffer]);}
    catch(error){cleanup();reject(error);}
  });
  const detached=pixels.byteLength===0;
  const reply=await response;
  try{
    assert(!reply.error,reply.error??'worker error');assert(detached,'prepared input was not transferred');
    assert(Array.isArray(reply.cells)&&reply.cells.length===1,'expected exactly one output cell');
    const cell=reply.cells[0];assert(cell.slot===0&&cell.pixels,'pixel transport missing');
    const canvas=document.createElement('canvas');canvas.width=cell.pixels.width;canvas.height=cell.pixels.height;
    const measured=reply.rasterReceipt as {version:1;kind:'measured';sourceFrameId:number;captureTime:number;acquisitionFrameId:number;width:number;height:number;hash:string};
    assert(measured?.version===1&&measured.kind==='measured'&&measured.sourceFrameId===100+id&&measured.captureTime===id&&measured.acquisitionFrameId===id,'frame receipt mismatch');
    const claim=parsePreparedCropProof(reply.experimentalCropProof,measured,[{...cell,image:canvas}]);
    if(alpha===255){
      assert(measured.hash===inputHash,'opaque detector readback differs from sent pixels');
      assert(claim.frameCheck==='match'&&claim.checked===1&&!claim.timedOut&&!claim.hashBusy,'opaque crop was not verified');
      const crop=claim.crops[0];assert(crop.slot===0&&await pixelHash(new Uint8Array(cell.pixels.data))===crop.sha256,'transported crop hash mismatch');
      const {x,y,width:w,height:h}=crop.content;assert(w===cell.pixels.width&&h===cell.pixels.height,'crop geometry mismatch');
      for(let row=0;row<h;row++)for(let col=0;col<w*4;col++)
        assert(cell.pixels.data[row*w*4+col]===before[((y+row)*width+x)*4+col],'transported crop does not match source ROI');
    }else{
      assert(claim.checked===0&&claim.unsupported===1,'transparent crop must remain unsupported');
    }
    return {case:alpha===255?'opaque-exact':'transparent-unsupported',inputDetached:detached,
      sourceHash:inputHash,detectorHash:measured.hash,frameCheck:claim.frameCheck,checked:claim.checked,unsupported:claim.unsupported,
      mismatch:claim.mismatch,overBudget:claim.overBudget,hashFailed:claim.hashFailed,timedOut:claim.timedOut,
      crop:claim.crops[0]??null,workerMs:reply.timing?.workerMs??null,elapsedMs:performance.now()-start};
  }finally{close(reply);}
}
run.addEventListener('click',()=>{void (async()=>{
  run.disabled=true;status.dataset.state='running';status.textContent='검사 중';output.textContent='';
  let worker:Worker|undefined;
  try{
    if(typeof OffscreenCanvas==='undefined'||typeof Worker==='undefined'||!crypto.subtle)throw Error('브라우저 Worker 또는 Canvas 기능을 사용할 수 없습니다.');
    worker=new Worker(new URL('../src/features/card-scanner/acquisition/acquisition-worker.ts',import.meta.url),{type:'module'});
    const cases=[await request(worker,1,255),await request(worker,2,128)];
    output.textContent=JSON.stringify({version:1,scope:'synthetic-browser-worker-manual-layout-only',cases,
      limitations:['실제 검출기 위치·화면 공유·OCR·카드 정답 미검증','측정 시간은 이 합성 사례의 브라우저 Worker 왕복 시간']},null,2);
    status.dataset.state='pass';status.textContent='합성 Worker 검사 통과';
  }catch(error){status.dataset.state='fail';status.textContent='검사 실패';output.textContent=String(error);}
  finally{worker?.terminate();run.disabled=false;}
})()});
