const output=document.querySelector<HTMLPreElement>('#result')!;
const worker=new Worker(new URL('./visual-raster-compare-worker.ts',import.meta.url),{type:'module'});
worker.onmessage=event=>{output.textContent=JSON.stringify(event.data,null,2);worker.terminate();};
worker.onerror=event=>{output.textContent=JSON.stringify({status:'failed',error:event.message});worker.terminate();};
worker.postMessage({run:true});
