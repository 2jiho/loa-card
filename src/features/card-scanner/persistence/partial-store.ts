/** A deliberately separate local database for incomplete scan snapshots.
 * Saved cards have no image, OCR, raw frame, or diagnostic payload. A stored
 * snapshot is never evidence that collection or recognition completed. */
export interface PartialCard {id:string;name:string;identityUncertain:boolean;awakening:number|null;extraCopies:number|null}
export interface PartialSnapshot {cards:PartialCard[];expected:number|null;growthPoints:number|null}
export interface PartialHandle {id:string;epoch:string;revision:number}
export type PartialEntry = {id:string;epoch:string;revision:number;status:'partial';updatedAt:number;snapshot:PartialSnapshot} |
 {id:string;epoch:string;revision:number;status:'pending';updatedAt:number} |
 {id:string;epoch:string;revision:number;status:'deleted';updatedAt:number};
export class PartialStoreError extends Error {
 readonly code:'invalid'|'conflict'|'capacity'|'unknown';
 constructor(code:'invalid'|'conflict'|'capacity'|'unknown',message:string){super(message);this.code=code;this.name='PartialStoreError';}
}
const DB='loacard-dev-partial-snapshots-v1',STORE='snapshots',MAX_ENTRIES=128,MAX_CARDS=600;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid=()=>new PartialStoreError('invalid','부분 기록 형식이 올바르지 않습니다.');
const conflict=()=>new PartialStoreError('conflict','부분 기록이 변경되었거나 삭제되었습니다.');
const uncertain=()=>new PartialStoreError('unknown','저장 완료 여부를 확인할 수 없습니다. 다시 읽어 확인해 주세요.');
function numberOrNull(x:unknown,max:number):x is number|null {return x===null||typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=max;}
function handleValid(h:PartialHandle){return !!h&&uuid.test(h.id)&&uuid.test(h.epoch)&&Number.isSafeInteger(h.revision)&&h.revision>=0;}
function parseEntry(value:unknown):PartialEntry {
 if(!value||typeof value!=='object')throw invalid();const row=value as PartialEntry;
 if(!handleValid(row)||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<0)throw invalid();
 if(row.status==='deleted'||row.status==='pending')return {id:row.id,epoch:row.epoch,revision:row.revision,status:row.status,updatedAt:row.updatedAt};
 if(row.status!=='partial')throw invalid();
 return {id:row.id,epoch:row.epoch,revision:row.revision,status:'partial',updatedAt:row.updatedAt,snapshot:sanitizePartialSnapshot(row.snapshot)};
}
export function sanitizePartialSnapshot(input:PartialSnapshot):PartialSnapshot {
 if(!input||!Array.isArray(input.cards)||input.cards.length>MAX_CARDS||!numberOrNull(input.expected,600)||!numberOrNull(input.growthPoints,999_999_999))throw invalid();
 const ids=new Set<string>();
 const cards=input.cards.map(card=>{
  if(!card||typeof card.id!=='string'||!card.id.trim()||card.id.length>128||ids.has(card.id)||typeof card.name!=='string'||!card.name.trim()||card.name.length>128||typeof card.identityUncertain!=='boolean'||
    !numberOrNull(card.awakening,5)||!numberOrNull(card.extraCopies,15)||card.awakening!==null&&card.extraCopies!==null&&card.extraCopies>15-card.awakening*(card.awakening+1)/2)throw invalid();
  ids.add(card.id);return {id:card.id,name:card.name,identityUncertain:card.identityUncertain,awakening:card.awakening,extraCopies:card.extraCopies};
 });
 return {cards,expected:input.expected,growthPoints:input.growthPoints};
}
export function createPartialStore(options:{dbName?:string;timeoutMs?:number}={}) {
 const name=options.dbName??DB,timeout=options.timeoutMs??5000;
 if(!name.startsWith('loacard-dev-partial-')||name.length>128||!Number.isFinite(timeout)||timeout<1||timeout>60000)throw invalid();
 function open(){return new Promise<IDBDatabase>((resolve,reject)=>{
  let done=false;const timer=setTimeout(()=>{done=true;reject(uncertain());},timeout);let req:IDBOpenDBRequest;
  try{req=indexedDB.open(name,1);}catch{clearTimeout(timer);done=true;reject(uncertain());return;}
  req.onupgradeneeded=()=>{if(done){try{req.transaction?.abort();}catch{}return;}req.result.createObjectStore(STORE,{keyPath:'id'});};
  req.onerror=req.onblocked=()=>{if(!done){done=true;clearTimeout(timer);reject(uncertain());}};
  req.onsuccess=()=>{if(done){req.result.close();return;}done=true;clearTimeout(timer);req.result.onversionchange=()=>req.result.close();resolve(req.result);};
 });}
 async function transaction<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore,set:(value:T)=>void,fail:(e:PartialStoreError)=>void)=>void):Promise<T>{
  const db=await open();
  return new Promise<T>((resolve,reject)=>{
   let done=false,result:T,error:PartialStoreError|undefined,tx:IDBTransaction|undefined;
   const finish=(err?:PartialStoreError)=>{if(done)return;done=true;clearTimeout(timer);db.close();if(err)reject(err);else resolve(result!);};
   const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(uncertain());},timeout);
   try{
    tx=db.transaction(STORE,mode);tx.oncomplete=()=>finish(error);tx.onerror=tx.onabort=()=>finish(error??uncertain());
    operation(tx.objectStore(STORE),value=>{result=value;},e=>{error=e;try{tx!.abort();}catch{finish(uncertain());}});
   }catch{try{tx?.abort();}catch{}finish(uncertain());}
  });
 }
 return {
  async start():Promise<PartialHandle>{
   const handle={id:crypto.randomUUID(),epoch:crypto.randomUUID(),revision:0};
   return transaction('readwrite',(store,set,fail)=>{const count=store.count();count.onsuccess=()=>{
    if(count.result>=MAX_ENTRIES){fail(new PartialStoreError('capacity','부분 기록 보관 한도에 도달했습니다.'));return;}
    const row:PartialEntry={...handle,status:'pending',updatedAt:Date.now()};
    store.add(row);set(handle);
   };});
  },
  async save(handle:PartialHandle,input:PartialSnapshot):Promise<PartialHandle>{
   if(!handleValid(handle))throw invalid();const snapshot=sanitizePartialSnapshot(input);
   return transaction('readwrite',(store,set,fail)=>{const read=store.get(handle.id);read.onsuccess=()=>{
    const row=read.result as PartialEntry|undefined;
    if(!row||!['pending','partial'].includes(row.status)||row.epoch!==handle.epoch||row.revision!==handle.revision){fail(conflict());return;}
    if(row.revision>=Number.MAX_SAFE_INTEGER){fail(new PartialStoreError('capacity','기록 버전 한도에 도달했습니다.'));return;}
    const next={...handle,revision:handle.revision+1};store.put({...next,status:'partial',updatedAt:Date.now(),snapshot} satisfies PartialEntry);set(next);
   };});
  },
  async remove(handle:PartialHandle):Promise<void>{
   if(!handleValid(handle))throw invalid();
   return transaction('readwrite',(store,set,fail)=>{const read=store.get(handle.id);read.onsuccess=()=>{
    const row=read.result as PartialEntry|undefined;
    if(!row||row.epoch!==handle.epoch){fail(conflict());return;}
    if(row.status==='deleted'){set(undefined);return;}
    store.put({id:row.id,epoch:row.epoch,revision:row.revision,status:'deleted',updatedAt:Date.now()} satisfies PartialEntry);set(undefined);
   };});
  },
  async read(id:string):Promise<PartialEntry|undefined>{if(!uuid.test(id))throw invalid();return transaction('readonly',(store,set,fail)=>{const req=store.get(id);req.onsuccess=()=>{try{set(req.result===undefined?undefined:parseEntry(req.result));}catch{fail(invalid());}};});},
  async list():Promise<PartialEntry[]>{return transaction('readonly',(store,set,fail)=>{const req=store.getAll();req.onsuccess=()=>{try{set((req.result as unknown[]).map(parseEntry).filter(row=>row.status==='partial'));}catch{fail(invalid());}};});},
  async stats():Promise<{partial:number;pending:number;deleted:number;limit:number}>{return transaction('readonly',(store,set,fail)=>{const req=store.getAll();req.onsuccess=()=>{try{const counts={partial:0,pending:0,deleted:0,limit:MAX_ENTRIES};for(const item of req.result as unknown[])counts[parseEntry(item).status]++;set(counts);}catch{fail(invalid());}};});},
 };
}
export type PartialStore=ReturnType<typeof createPartialStore>;
export type PartialWriterStatus={state:'saving'|'saved'|'error'|'removed';code?:PartialStoreError['code']};
/** At most one in-flight write and one replaceable, sanitized pending snapshot.
 * An ambiguous result fences all further writes until a caller re-reads. */
export function createLatestPartialWriter(store:PartialStore,initial:PartialHandle,onStatus?:(s:PartialWriterStatus)=>void){
 let handle=initial,latest:PartialSnapshot|undefined,work:Promise<void>|undefined,stopped=false,error:unknown;
 const notify=(state:PartialWriterStatus)=>{try{onStatus?.(state);}catch{}};
 function pump(){if(work||!latest||stopped||error)return;const value=latest;latest=undefined;notify({state:'saving'});
  work=(async()=>{try{const next=await store.save(handle,value);handle=next;if(!stopped)notify({state:'saved'});}catch(e){error=e;latest=undefined;if(!stopped)notify({state:'error',code:e instanceof PartialStoreError?e.code:'unknown'});}})().finally(()=>{work=undefined;pump();});
 }
 return {
  offer(value:PartialSnapshot){if(stopped||error)throw error??conflict();latest=sanitizePartialSnapshot(value);pump();},
  async flush(){while(work)await work;if(error)throw error;},
  async remove(){stopped=true;latest=undefined;await store.remove(handle);notify({state:'removed'});},
 };
}
