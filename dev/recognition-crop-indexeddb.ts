import {cropJournalHash,type CropBatchItem,type CropCheckpoint,type CropEvent,type CropJournalSeed,type CropJournalSink} from './recognition-crop-journal';

/** These are logical payload limits, not a measurement of browser disk overhead. */
const DB='loacard-dev-recognition-crops-v1',MAX_BYTES=256*1024*1024,MAX_METADATA_BYTES=16*1024*1024,RESERVE=16*1024;
const encoder=new TextEncoder();
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{
 value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);
});
const jsonBytes=(value:unknown)=>encoder.encode(JSON.stringify(value)).byteLength;
const runCost=(row:{checkpoint:unknown})=>jsonBytes(row)+(row.checkpoint===null?RESERVE:0);
const pixelCost=(row:{runId:string;key:string;pixels:Uint8Array})=>encoder.encode(row.runId).length+encoder.encode(row.key).length+row.pixels.byteLength;
type Run={id:string;seed:CropJournalSeed;checkpoint:CropCheckpoint|null;eventBytes:number;nextSeq:number;createdAt?:number};

/** Upgrade keeps v1 data and rebuilds accounting from stored payloads. It
 * never evicts old runs, even if they already exceed the new budget. */
function open():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const r=indexedDB.open(DB,2);
 r.onupgradeneeded=event=>{
  const db=r.result,tx=r.transaction!;
  if(!db.objectStoreNames.contains('runs'))db.createObjectStore('runs',{keyPath:'id'});
  if(!db.objectStoreNames.contains('events'))db.createObjectStore('events',{keyPath:['runId','seq']});
  if(!db.objectStoreNames.contains('pixels'))db.createObjectStore('pixels',{keyPath:['runId','key']});
  if(!db.objectStoreNames.contains('usage'))db.createObjectStore('usage',{keyPath:'id'});
  const usage=tx.objectStore('usage');
  if((event as IDBVersionChangeEvent).oldVersion===0){usage.put({id:'total',bytes:0});return;}
  let remaining=3,total=0;const runs=new Map<string,Run>(),events=new Map<string,{bytes:number;next:number}>();
  const done=()=>{if(--remaining)return;
   for(const [id,row] of runs){const fact=events.get(id);const next={...row,eventBytes:fact?.bytes??0,nextSeq:fact?.next??1};
    tx.objectStore('runs').put(next);total+=runCost(next);}
   usage.put({id:'total',bytes:total});
  };
  for(const name of ['runs','events','pixels'] as const){
   const cursor=tx.objectStore(name).openCursor();
   cursor.onsuccess=()=>{const current=cursor.result;if(!current){done();return;}
    const row=current.value;
    try{
     if(name==='runs')runs.set(row.id,row);
     else if(name==='events'){const bytes=jsonBytes(row),old=events.get(row.runId)??{bytes:0,next:1};
      old.bytes+=bytes;old.next=Math.max(old.next,row.seq+1);events.set(row.runId,old);total+=bytes;}
     else {if(!(row.pixels instanceof Uint8Array))throw Error('Invalid prior crop pixels');total+=pixelCost(row);}
     if(!Number.isSafeInteger(total))throw Error('Crop usage overflow');current.continue();
    }catch{tx.abort();}
   };
  }
 };
 r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Crop database blocked'));
});}
async function transaction<T>(db:IDBDatabase,stores:string[],mode:IDBTransactionMode,work:(tx:IDBTransaction)=>Promise<T>):Promise<T>{
 const tx=db.transaction(stores,mode);let value:T,failed:unknown;
 const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failed??tx.error??Error('Crop transaction failed'));});
 try{value=await work(tx);}catch(error){failed=error;try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
 await done;return value;
}
async function charge(tx:IDBTransaction,delta:number,budget=MAX_BYTES){
 const store=tx.objectStore('usage'),usage=await request(store.get('total'));
 if(!usage||!Number.isSafeInteger(usage.bytes)||usage.bytes<0||!Number.isSafeInteger(delta))throw Error('Invalid crop usage');
 const bytes=usage.bytes+delta;if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('Invalid crop usage');
 if(delta>0&&bytes>budget)throw Error('Crop database storage budget exceeded');
 await request(store.put({id:'total',bytes}));
}
const runIdValid=(id:string)=>/^[a-zA-Z0-9-]{1,160}$/.test(id);
async function active(tx:IDBTransaction,id:string):Promise<Run>{
 const row=await request<Run|undefined>(tx.objectStore('runs').get(id));
 if(!row||row.checkpoint!==null)throw Error('Crop run is unavailable or sealed');return row;
}

export async function createCropIndexedDbSink(runId:string,options:{logicalBudget?:number}={}):Promise<CropJournalSink&{close():void}> {
 if(!runIdValid(runId))throw Error('Invalid crop run ID');
 const budget=options.logicalBudget??MAX_BYTES;
 if(!Number.isSafeInteger(budget)||budget<1||budget>MAX_BYTES)throw Error('Invalid crop database budget');
 const db=await open();let started=false,closed=false;
 const check=()=>{if(closed)throw Error('Crop database closed');};
 return {
  async begin(seed){check();if(started)throw Error('Crop run already begun');
   await transaction(db,['runs','usage'],'readwrite',async tx=>{const row:Run={id:runId,seed,checkpoint:null,eventBytes:0,nextSeq:1,createdAt:Date.now()};
    await charge(tx,runCost(row),budget);await request(tx.objectStore('runs').add(row));});started=true;},
  async get(key){check();const row=await transaction(db,['pixels'],'readonly',tx=>request(tx.objectStore('pixels').get([runId,key])));
   if(!row)return;if(!(row.pixels instanceof Uint8Array))throw Error('Invalid stored crop bytes');return row.pixels;},
  async put(key,pixels){check();if(!started||!(pixels instanceof Uint8Array))throw Error('Invalid crop pixels');
   await transaction(db,['runs','pixels','usage'],'readwrite',async tx=>{await active(tx,runId);const row={runId,key,pixels};
    await charge(tx,pixelCost(row),budget);await request(tx.objectStore('pixels').add(row));});},
  async append(event){check();if(!started)throw Error('Crop run not begun');
   await transaction(db,['runs','events','usage'],'readwrite',async tx=>{const run=await active(tx,runId);
    if(event.seq!==run.nextSeq)throw Error('Crop event sequence gap');
    const row={runId,seq:event.seq,event},eventBytes=jsonBytes(row);
    if(eventBytes>64*1024||run.eventBytes+eventBytes>MAX_METADATA_BYTES)throw Error('Crop event metadata budget exceeded');
    const next={...run,eventBytes:run.eventBytes+eventBytes,nextSeq:run.nextSeq+1};
    await charge(tx,eventBytes+runCost(next)-runCost(run),budget);await request(tx.objectStore('events').add(row));await request(tx.objectStore('runs').put(next));});},
  async appendBatch(input:readonly CropBatchItem[]){check();if(!started||!input.length||input.length>32)throw Error('Invalid crop batch');
   // Restoration owns the input bytes before any asynchronous hash operation.
   // Ordinary capture batches keep their existing fast path.
   const items:CropBatchItem[]=[];let restoreBytes=0;
   for(const item of input){
    if(item.kind!=='pixels'||item.originalEvent===undefined){items.push(item);continue;}
    const original=item.originalEvent;
    if(!original||typeof original!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(original)))throw Error('Invalid original crop event');
    const names=Reflect.ownKeys(original),expected=['seq','kind','readId','width','height','sha256','shared'];
    if(names.length!==expected.length||names.some(key=>typeof key!=='string'||!expected.includes(key)))throw Error('Invalid original crop event');
    const restored:Record<string,unknown>=Object.create(null);
    for(const key of names){const property=Object.getOwnPropertyDescriptor(original,key)!;
      if(!property||!property.enumerable||!('value' in property))throw Error('Invalid original crop event');restored[key as string]=property.value;}
    if(restored.kind!=='crop'||restored.seq!==item.seq||restored.readId!==item.readId||restored.width!==item.width||
       restored.height!==item.height||restored.sha256!==item.sha256||typeof restored.shared!=='boolean')throw Error('Original crop event mismatch');
    if(!(item.pixels instanceof Uint8Array)||!Number.isSafeInteger(item.width)||!Number.isSafeInteger(item.height)||
       item.width<1||item.height<1||item.width*item.height*4!==item.pixels.byteLength||item.pixels.byteLength>4*1024*1024||
       !/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid crop batch pixels');
    restoreBytes+=item.pixels.byteLength;if(restoreBytes>4*1024*1024)throw Error('Crop batch byte limit');
    items.push({...item,pixels:Uint8Array.from(item.pixels),originalEvent:restored as unknown as Extract<CropEvent,{kind:'crop'}>});
   }
   for(const item of items)if(item.kind==='pixels'&&item.originalEvent&&await cropJournalHash(item.pixels)!==item.sha256)
     throw Error('Original crop pixel digest mismatch');
   check();
   return transaction(db,['runs','events','pixels','usage'],'readwrite',async tx=>{
    const pixelsStore=tx.objectStore('pixels'),eventsStore=tx.objectStore('events'),usageStore=tx.objectStore('usage');
    const [run,usage]=await Promise.all([active(tx,runId),request(usageStore.get('total'))]);
    if(!usage||!Number.isSafeInteger(usage.bytes)||usage.bytes<0)throw Error('Invalid crop usage');
    let nextSeq=run.nextSeq,eventBytes=0,pixelBytes=0,rawBytes=0;const events:CropEvent[]=[];
    const distinct=new Map<string,Uint8Array>();
    for(const item of items){
     const seq=item.kind==='event'?item.event.seq:item.seq;
     if(seq!==nextSeq++)throw Error('Crop batch sequence gap');
     if(item.kind==='pixels'){
      if(!(item.pixels instanceof Uint8Array)||!Number.isSafeInteger(item.width)||!Number.isSafeInteger(item.height)||
        item.width<1||item.height<1||item.width*item.height*4!==item.pixels.byteLength||item.pixels.byteLength>4*1024*1024||
        !/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid crop batch pixels');
      rawBytes+=item.pixels.byteLength;if(rawBytes>4*1024*1024)throw Error('Crop batch byte limit');
      const key=`${item.width}x${item.height}:${item.sha256}`,prior=distinct.get(key);
      if(prior&&(prior.length!==item.pixels.length||prior.some((value,index)=>value!==item.pixels[index])))
       throw Error('digest collision or stored pixel corruption');
      if(!prior)distinct.set(key,item.pixels);
     }
    }
    // Issue independent lookups together: awaiting each IDB request serially
    // costs a browser task per image even inside one transaction.
    const keys=[...distinct.keys()],existing=await Promise.all(keys.map(key=>request(pixelsStore.get([runId,key]))));
    const known=new Map<string,Uint8Array>();
    for(let i=0;i<keys.length;i++){
     const key=keys[i],prior=existing[i],pixels=distinct.get(key)!;
     if(prior){if(!(prior.pixels instanceof Uint8Array)||prior.pixels.length!==pixels.length||
       prior.pixels.some((value:number,index:number)=>value!==pixels[index]))throw Error('digest collision or stored pixel corruption');
      known.set(key,prior.pixels);}
    }
    const pixelRows:{runId:string;key:string;pixels:Uint8Array}[]=[],eventRows:{runId:string;seq:number;event:CropEvent}[]=[];
    for(const item of items){
     let event:CropEvent;
     if(item.kind==='event')event=item.event;
     else{
      const key=`${item.width}x${item.height}:${item.sha256}`,shared=known.has(key);
      if(!shared){const row={runId,key,pixels:item.pixels};pixelBytes+=pixelCost(row);pixelRows.push(row);known.set(key,item.pixels);}
      if(item.originalEvent&&item.originalEvent.shared!==shared)throw Error('Original crop sharing mismatch');
      event=item.originalEvent??{seq:item.seq,kind:'crop',readId:item.readId,width:item.width,height:item.height,sha256:item.sha256,shared};
     }
     const row={runId,seq:event.seq,event},size=jsonBytes(row);
     if(size>64*1024||run.eventBytes+eventBytes+size>MAX_METADATA_BYTES)throw Error('Crop event metadata budget exceeded');
     eventBytes+=size;eventRows.push(row);events.push(event);
    }
    const next={...run,eventBytes:run.eventBytes+eventBytes,nextSeq};
    const bytes=usage.bytes+pixelBytes+eventBytes+runCost(next)-runCost(run);
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>budget)throw Error('Crop database storage budget exceeded');
    const writes:Promise<unknown>[]=[...pixelRows.map(row=>request(pixelsStore.add(row))),...eventRows.map(row=>request(eventsStore.add(row))),
      request(usageStore.put({id:'total',bytes})),request(tx.objectStore('runs').put(next))];
    await Promise.all(writes);return events;
   });
  },
  async seal(checkpoint){check();await transaction(db,['runs','usage'],'readwrite',async tx=>{
   const run=await active(tx,runId);if(checkpoint.events!==run.nextSeq-1)throw Error('Crop checkpoint event count mismatch');
   const next={...run,checkpoint};await charge(tx,runCost(next)-runCost(run),budget);await request(tx.objectStore('runs').put(next));});},
  close(){closed=true;db.close();},
 };
}

async function cursorRows<T>(store:IDBObjectStore,range:IDBKeyRange,visit:(row:T,cursor:IDBCursorWithValue)=>void):Promise<void>{
 await new Promise<void>((resolve,reject)=>{const r=store.openCursor(range);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const cursor=r.result;if(!cursor){resolve();return;}
  try{visit(cursor.value,cursor);cursor.continue();}catch(error){reject(error);}
 };});
}
/** Small bounded run index only; it does not load image bytes or OCR results. */
export async function listCropIndexedDbRuns():Promise<{runs:{id:string;status:'open'|'complete'|'partial';createdAt:number|null;events:number;reason:string|null}[];truncated:boolean}>{
 const db=await open();try{return await transaction(db,['runs'],'readonly',async tx=>{
  const runs:{id:string;status:'open'|'complete'|'partial';createdAt:number|null;events:number;reason:string|null}[]=[];
  let truncated=false;
  await new Promise<void>((resolve,reject)=>{const r=tx.objectStore('runs').openCursor();r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const cursor=r.result;if(!cursor){resolve();return;}if(runs.length>=1000){truncated=true;resolve();return;}
   const row=cursor.value as Run;
   if(!runIdValid(row.id)||!Number.isSafeInteger(row.nextSeq)||row.nextSeq<1||
     !(row.checkpoint===null||row.checkpoint&&typeof row.checkpoint.complete==='boolean')){reject(Error('Invalid crop run index'));return;}
   runs.push({id:row.id,status:row.checkpoint===null?'open':row.checkpoint.complete?'complete':'partial',
    createdAt:Number.isFinite(row.createdAt)?row.createdAt!:null,events:row.nextSeq-1,
    reason:typeof row.checkpoint?.reason==='string'?row.checkpoint.reason.slice(0,1000):null});cursor.continue();
  };});
  runs.sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));return {runs,truncated};
 });}finally{db.close();}
}
/** Loads bounded metadata using a cursor; RGBA buffers are fetched one at a time. */
export async function loadCropIndexedDbRun(runId:string):Promise<{seed:CropJournalSeed;checkpoint:CropCheckpoint|null;events:CropEvent[];read:(key:string)=>Promise<Uint8Array|undefined>;close:()=>void}> {
 if(!runIdValid(runId))throw Error('Invalid crop run ID');const db=await open();
 try{
  const {row,events}=await transaction(db,['runs','events'],'readonly',async tx=>{
   const row=await request<Run|undefined>(tx.objectStore('runs').get(runId));if(!row)throw Error('Crop run missing');
   const events:CropEvent[]=[];let bytes=0;
   await cursorRows<{runId:string;seq:number;event:CropEvent}>(tx.objectStore('events'),IDBKeyRange.bound([runId,0],[runId,Number.MAX_SAFE_INTEGER]),value=>{
    const size=jsonBytes(value);bytes+=size;if(size>64*1024||events.length>=50_000||bytes>MAX_METADATA_BYTES||value.runId!==runId||value.seq!==events.length+1||value.event?.seq!==value.seq)
     throw Error('Crop event metadata limit or sequence error');events.push(value.event);
   });
   if(bytes!==row.eventBytes||events.length!==row.nextSeq-1)throw Error('Crop event index mismatch');
   return {row,events};
  });
  return {seed:row.seed,checkpoint:row.checkpoint,events,read:async key=>{
   const value=await transaction(db,['pixels'],'readonly',tx=>request(tx.objectStore('pixels').get([runId,key])));
   if(!value)return;if(!(value.pixels instanceof Uint8Array))throw Error('Invalid stored crop bytes');return value.pixels;
  },close:()=>db.close()};
 }catch(error){db.close();throw error;}
}

/** Explicit user action only: delete one sealed run, never other stores/runs. */
export async function deleteCropIndexedDbRun(runId:string):Promise<boolean>{
 if(!runIdValid(runId))throw Error('Invalid crop run ID');const db=await open();
 try{return await transaction(db,['runs','events','pixels','usage'],'readwrite',async tx=>{
  const runs=tx.objectStore('runs'),row=await request<Run|undefined>(runs.get(runId));if(!row)return false;
  if(row.checkpoint===null)throw Error('Cannot delete an active crop run');let removed=runCost(row);
  for(const kind of ['events','pixels'] as const){const store=tx.objectStore(kind);
   const upper=kind==='events'?[runId,Number.MAX_SAFE_INTEGER]:[runId,[]];
   await cursorRows<any>(store,IDBKeyRange.bound([runId,kind==='events'?0:''],upper), (value,cursor)=>{
    if(value.runId!==runId)throw Error('Crop deletion scope mismatch');removed+=kind==='events'?jsonBytes(value):pixelCost(value);cursor.delete();
   });
  }
  await charge(tx,-removed);await request(runs.delete(runId));return true;
 });}finally{db.close();}
}
