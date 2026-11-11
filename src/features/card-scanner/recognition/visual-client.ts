import type { inspectVisual, portraitIdentity, readVisual } from './visual-fields';
export type VisualResult={identity:ReturnType<typeof portraitIdentity>|null;fields:ReturnType<typeof inspectVisual>;values:ReturnType<typeof readVisual>|null};
/** Dedicated single-consumer reader keeps portrait, jewel and count math off the capture thread. */
export function createVisualClient(signal:AbortSignal) {
 if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined')return undefined;
 const worker=new Worker(new URL('./visual-worker.ts',import.meta.url),{type:'module'});
 let closed=false,id=0,freezing=false;
 let pending:{id:number;resolve:(value:VisualResult|null)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 function dispose(){if(closed)return;closed=true;worker.terminate();signal.removeEventListener('abort',dispose);if(pending){clearTimeout(pending.timer);pending.reject(new DOMException('Stopped','AbortError'));pending=undefined;}}
 signal.addEventListener('abort',dispose,{once:true});if(signal.aborted)dispose();
 worker.onmessage=event=>{if(!pending||pending.id!==event.data.id)return;const job=pending;pending=undefined;clearTimeout(job.timer);if(event.data.error)job.reject(new Error(event.data.error));else job.resolve(event.data.result);};
 worker.onerror=event=>{if(pending){const job=pending;pending=undefined;clearTimeout(job.timer);job.reject(new Error(event.message||'시각 판독 Worker 오류'));}dispose();};
 async function request(image?:HTMLCanvasElement){
  signal.throwIfAborted();if(closed)throw new Error('시각 판독 종료');if(pending||freezing)throw new Error('동시 시각 판독 요청');
  freezing=true;let bitmap:ImageBitmap|undefined;
  try{if(image)bitmap=await createImageBitmap(image);}finally{freezing=false;}
  if(closed||signal.aborted){bitmap?.close();signal.throwIfAborted();throw new Error('시각 판독 종료');}
  const current=++id;
  return new Promise<VisualResult|null>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending=undefined;reject(new Error('시각 판독 시간 초과'));dispose();},30000);
   pending={id:current,resolve,reject,timer};
   try{worker.postMessage({id:current,bitmap},bitmap?[bitmap]:[]);}catch(error){clearTimeout(timer);pending=undefined;bitmap?.close();reject(error);}
  });
 }
 return {ready:()=>request(),read:async(image:HTMLCanvasElement)=>(await request(image))!,dispose};
}
