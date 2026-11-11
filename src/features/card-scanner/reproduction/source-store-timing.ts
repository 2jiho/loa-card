/** Bounded, optional diagnostics only. These values never admit a source,
 * authorize pixel reuse, alter hashes, or turn a valid input into a failure. */
export interface SourceStoreTimingRecord {
  readonly id:number;readonly width:number;readonly height:number;readonly time:number;
  readonly role:'input'|'backup'|'recovery';
}
export interface SourcePreparationTiming {
  readonly copyMs:number;readonly conversionHashMs:number;readonly rasterMs:number;readonly totalMs:number;
}
export interface SourceStoreWorkerTiming {
  readonly version:1;readonly path:'native'|'rgba';
  readonly queuedMs:number;readonly prepareMs:number;readonly packMs:number;readonly compressMs:number;
  readonly appendMs:number;readonly workMs:number;readonly receiveToAckMs:number;
}
export interface SourceStorePendingTiming {
  readonly id:number;readonly ageMs:number;readonly bytes:number;readonly prepared:boolean;readonly transferred:boolean;
}
export interface SourceStoreTimingEntry extends SourceStoreTimingRecord {
  readonly bytes:number;readonly pendingBytes:number;readonly reservedAtMs:number;
  readonly preparedAtMs?:number;readonly dispatchedAtMs?:number;readonly ackAtMs?:number;
  readonly reserveToPreparedMs?:number;readonly preparedToDispatchMs?:number;readonly reserveToDispatchMs?:number;
  readonly dispatchToAckMs?:number;readonly reserveToAckMs?:number;
  readonly preparation?:SourcePreparationTiming;readonly worker?:SourceStoreWorkerTiming;
}
export interface SourceStoreTimingSnapshot {
  readonly version:1;readonly limit:8;readonly sources:readonly SourceStoreTimingEntry[];readonly truncatedSources:boolean;
  readonly failure?:{readonly reason:string;readonly atMs?:number;readonly pending:readonly SourceStorePendingTiming[];readonly truncated:boolean};
  readonly ignored:{readonly events:number;readonly clocks:number;readonly preparationTiming:number;readonly workerTiming:number};
}

export const SOURCE_STORE_TIMING_LIMIT=8;
const LIMIT=SOURCE_STORE_TIMING_LIMIT,MAX_DURATION=120_000;
const preparationKeys=['copyMs','conversionHashMs','rasterMs','totalMs'] as const;
const workerDurationKeys=['queuedMs','prepareMs','packMs','compressMs','appendMs','workMs','receiveToAckMs'] as const;
const integer=(value:unknown,minimum=0):value is number=>Number.isSafeInteger(value)&&(value as number)>=minimum;
const clock=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const duration=(value:unknown):value is number=>clock(value)&&value<=MAX_DURATION;
function object(value:unknown,keys:readonly string[]):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return;
  const own=Reflect.ownKeys(value);
  if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))return;
  return value as Record<string,unknown>;
}
function parsePreparation(value:unknown):SourcePreparationTiming|undefined {
  const input=object(value,preparationKeys);
  if(!input||preparationKeys.some(key=>!duration(input[key])))return;
  return {copyMs:input.copyMs as number,conversionHashMs:input.conversionHashMs as number,
    rasterMs:input.rasterMs as number,totalMs:input.totalMs as number};
}
function parseWorker(value:unknown):SourceStoreWorkerTiming|undefined {
  const input=object(value,['version','path',...workerDurationKeys]);
  if(!input||input.version!==1||!['native','rgba'].includes(input.path as string)||workerDurationKeys.some(key=>!duration(input[key])))return;
  return {version:1,path:input.path as 'native'|'rgba',queuedMs:input.queuedMs as number,prepareMs:input.prepareMs as number,
    packMs:input.packMs as number,compressMs:input.compressMs as number,appendMs:input.appendMs as number,
    workMs:input.workMs as number,receiveToAckMs:input.receiveToAckMs as number};
}
type Mutable<T>={-readonly[K in keyof T]:T[K]};

/** All supplied main timestamps share one monotonic clock. Worker values are
 * durations on their own clock; no worker timestamp is an origin for main time.
 * First reservations and the first failure prefix are retained, never a ring. */
export class SourceStoreTiming {
  private readonly entries=new Map<number,Mutable<SourceStoreTimingEntry>>();
  private lastMainTime=-1;
  private truncatedSources=false;
  private failure:SourceStoreTimingSnapshot['failure'];
  private readonly ignored={events:0,clocks:0,preparationTiming:0,workerTiming:0};

  private ignore(kind:keyof SourceStoreTimingSnapshot['ignored']) {
    this.ignored[kind]=Math.min(Number.MAX_SAFE_INTEGER,this.ignored[kind]+1);
  }
  private mainTime(now:unknown):now is number {
    if(!clock(now)||now<this.lastMainTime){this.ignore('clocks');return false;}
    this.lastMainTime=now;return true;
  }
  reserve(record:SourceStoreTimingRecord,bytes:number,pendingBytes:number,now:number):void {
    try {
      if(!record||!integer(record.id,1)||!integer(record.width,1)||!integer(record.height,1)||!clock(record.time)||
        !['input','backup','recovery'].includes(record.role)||!integer(bytes)||!integer(pendingBytes)||pendingBytes<bytes||this.entries.has(record.id)){
        this.ignore('events');return;
      }
      if(!this.mainTime(now))return;
      if(this.entries.size===LIMIT){this.truncatedSources=true;return;}
      this.entries.set(record.id,{id:record.id,width:record.width,height:record.height,time:record.time,role:record.role,
        bytes,pendingBytes,reservedAtMs:now});
    }catch{this.ignore('events');}
  }
  prepared(id:number,now:number):void {
    try {
      const entry=this.entries.get(id);if(!entry)return;
      if(entry.preparedAtMs!==undefined||entry.dispatchedAtMs!==undefined){this.ignore('events');return;}
      if(!this.mainTime(now))return;
      entry.preparedAtMs=now;entry.reserveToPreparedMs=now-entry.reservedAtMs;
    }catch{this.ignore('events');}
  }
  preparation(id:number,timing:unknown):void {
    const entry=this.entries.get(id);if(!entry)return;
    try {
      const parsed=parsePreparation(timing);
      if(!parsed){this.ignore('preparationTiming');return;}
      if(entry.preparation){this.ignore('events');return;}
      entry.preparation=parsed;
    }catch{this.ignore('preparationTiming');}
  }
  dispatch(id:number,now:number):void {
    try {
      const entry=this.entries.get(id);if(!entry)return;
      if(entry.dispatchedAtMs!==undefined){this.ignore('events');return;}
      if(!this.mainTime(now))return;
      entry.dispatchedAtMs=now;entry.reserveToDispatchMs=now-entry.reservedAtMs;
      if(entry.preparedAtMs!==undefined)entry.preparedToDispatchMs=now-entry.preparedAtMs;
    }catch{this.ignore('events');}
  }
  ack(id:number,now:number,workerTiming?:unknown):void {
    try {
      const entry=this.entries.get(id);if(!entry)return;
      if(entry.dispatchedAtMs===undefined||entry.ackAtMs!==undefined){this.ignore('events');return;}
      if(!this.mainTime(now))return;
      entry.ackAtMs=now;entry.dispatchToAckMs=now-entry.dispatchedAtMs;entry.reserveToAckMs=now-entry.reservedAtMs;
      if(workerTiming!==undefined){
        try{const parsed=parseWorker(workerTiming);if(parsed)entry.worker=parsed;else this.ignore('workerTiming');}
        catch{this.ignore('workerTiming');}
      }
    }catch{this.ignore('events');}
  }
  fail(reason:string,now:number,pending:Iterable<SourceStorePendingTiming>):void {
    if(this.failure)return;
    const prefix:SourceStorePendingTiming[]=[];
    let truncated=false,atMs:number|undefined;
    try{if(this.mainTime(now))atMs=now;}catch{this.ignore('clocks');}
    // Capture before the caller clears its queue. Read at most nine descriptors,
    // even when a buggy caller supplies an unbounded iterable.
    try {
      let read=0;
      for(const value of pending){
        if(read++===LIMIT){truncated=true;break;}
        try {
          if(!value||!integer(value.id,1)||!clock(value.ageMs)||!integer(value.bytes)||typeof value.prepared!=='boolean'||typeof value.transferred!=='boolean'){
            this.ignore('events');continue;
          }
          prefix.push({id:value.id,ageMs:value.ageMs,bytes:value.bytes,prepared:value.prepared,transferred:value.transferred});
        }catch{this.ignore('events');}
      }
    }catch{this.ignore('events');}
    this.failure={reason:typeof reason==='string'?reason.slice(0,512):'Invalid diagnostic failure reason',
      ...(atMs===undefined?{}:{atMs}),pending:prefix,truncated};
  }
  snapshot():SourceStoreTimingSnapshot {
    return {version:1,limit:LIMIT,sources:[...this.entries.values()].map(value=>({...value,
      ...(value.preparation?{preparation:{...value.preparation}}:{}),...(value.worker?{worker:{...value.worker}}:{})})),
      truncatedSources:this.truncatedSources,...(this.failure?{failure:{...this.failure,pending:this.failure.pending.map(value=>({...value}))}}:{}),
      ignored:{...this.ignored}};
  }
}
