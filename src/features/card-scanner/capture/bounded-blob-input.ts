/** Bounded sequential Blob input with BYOB ownership and explicit slice fallback. */
export type BoundedInputMode='auto'|'byob'|'slice';
export interface BoundedBlobInputOptions {
  readonly mode?:BoundedInputMode;readonly chunkBytes?:number;readonly signal?:AbortSignal;
}
export interface BoundedBlobInputStats {
  readonly requested:BoundedInputMode;readonly actual:'byob'|'slice';readonly byobAvailable:boolean|null;
  readonly fallbackReason:'byob-unavailable'|null;readonly reads:number;readonly bytes:number;
  readonly peakBackingBytes:number;readonly readAwaitMs:number;readonly eof:boolean;
  readonly disposed:boolean;readonly readPending:boolean;readonly cancelRequested:boolean;
  readonly cancelSettled:boolean;readonly cancelRejected:boolean;readonly cleanupTimedOut:boolean;
  readonly lockReleased:boolean;
}

const MAX_CHUNK_BYTES=32768,CLEANUP_MS=1000;
function fail(detail:string):never {throw Error(`Invalid bounded Blob input: ${detail}`);}
const isArrayBuffer=(value:unknown):value is ArrayBuffer=>value instanceof ArrayBuffer;

function abortReason(signal:AbortSignal):unknown {
  return signal.reason??new DOMException('Aborted','AbortError');
}
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return promise;
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const clean=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{if(settled)return;settled=true;clean();reject(abortReason(signal));};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{if(settled)return;settled=true;clean();resolve(value);},
      error=>{if(settled)return;settled=true;clean();reject(error);});
    if(signal.aborted)abort();
  });
}

/** Returned views consume one fixed backing. A BYOB read transfers its loan,
 * detaching prior views before the next returned backing is retained. A slice
 * fallback never reads more than the same bound. Neither path stores chunks. */
class BoundedBlobInput {
  private readonly blob:Blob;
  private readonly chunkBytes:number;
  private readonly signal?:AbortSignal;
  private readonly requested:BoundedInputMode;
  private readonly actual:'byob'|'slice';
  private readonly byobAvailable:boolean|null;
  private readonly fallbackReason:'byob-unavailable'|null;
  private reader?:ReadableStreamBYOBReader;
  private backing?:ArrayBuffer;
  private offset=0;
  private reads=0;
  private peakBacking=0;
  private readMs=0;
  private eof=false;
  private disposed=false;
  private active=false;
  private pending=false;
  private cancelRequested=false;
  private cancelSettled=false;
  private cancelRejected=false;
  private cleanupTimedOut=false;
  private lockReleased=false;
  private cancellation?:Promise<void>;
  private disposal?:Promise<void>;
  private readonly abort=()=>{this.cancelReader();};

  constructor(blob:Blob,options:BoundedBlobInputOptions,reader:ReadableStreamBYOBReader|undefined,byobAvailable:boolean|null){
    this.blob=blob;this.chunkBytes=options.chunkBytes??MAX_CHUNK_BYTES;this.signal=options.signal;
    this.requested=options.mode??'auto';this.actual=reader?'byob':'slice';this.byobAvailable=byobAvailable;
    this.fallbackReason=!reader&&this.requested==='auto'?'byob-unavailable':null;
    this.reader=reader;
    if(reader){
      this.backing=new ArrayBuffer(this.chunkBytes);this.peakBacking=this.chunkBytes;
      void reader.closed.catch(()=>undefined);
      this.signal?.addEventListener('abort',this.abort,{once:true});
      if(this.signal?.aborted)this.abort();
    }
  }

  private cancelReader():void {
    if(!this.reader||this.cancelRequested||this.eof)return;
    this.cancelRequested=true;
    try{
      this.cancellation=Promise.resolve(this.reader.cancel(this.signal?.reason)).then(
        ()=>{this.cancelSettled=true;},()=>{this.cancelSettled=true;this.cancelRejected=true;});
    }catch{this.cancelSettled=true;this.cancelRejected=true;this.cancellation=Promise.resolve();}
  }

  async next():Promise<Uint8Array<ArrayBuffer>|undefined> {
    this.signal?.throwIfAborted();
    if(this.disposed)fail('source disposed');
    if(this.active||this.pending)fail('concurrent read');
    if(this.eof)return undefined;
    this.active=true;
    const started=performance.now();let readWasPosted=false;
    try{
      if(this.reader){
        const backing=this.backing;
        if(!isArrayBuffer(backing)||backing.byteLength!==this.chunkBytes)fail('BYOB backing missing');
        const loan=new Uint8Array(backing);
        this.backing=undefined;this.pending=true;this.reads++;readWasPosted=true;
        let reading:Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>;
        try{reading=Promise.resolve(this.reader.read(loan) as Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>).then(
          value=>{this.pending=false;return value;},error=>{this.pending=false;throw error;});}
        catch(error){this.pending=false;throw error;}
        // Standards-compliant BYOB transfers the supplied backing immediately.
        // A provider retaining it while returning a second buffer violates the
        // one-owner contract, even if the returned view is only32KiB long.
        if(backing.byteLength!==0){void reading.catch(()=>undefined);fail('BYOB loan not transferred');}
        const result=await abortable(reading,this.signal);
        this.signal?.throwIfAborted();
        if(typeof result?.done!=='boolean')fail('BYOB read result');
        const value=result.value;
        if(value!==undefined){
          if(!(value instanceof Uint8Array)||!isArrayBuffer(value.buffer)||value.byteOffset!==0||
            value.buffer.byteLength!==this.chunkBytes||value.byteLength>this.chunkBytes)fail('BYOB returned backing');
          this.backing=value.buffer;
        }else if(!result.done)fail('BYOB missing view');
        const length=value?.byteLength??0;
        if(!length&&!result.done)fail('BYOB no progress');
        if(this.offset+length>this.blob.size)fail('BYOB extra input');
        this.offset+=length;
        if(result.done){this.eof=true;if(this.offset!==this.blob.size)fail('BYOB truncated input');}
        return length?value:undefined;
      }
      if(this.offset===this.blob.size){this.eof=true;return undefined;}
      const length=Math.min(this.chunkBytes,this.blob.size-this.offset);
      this.pending=true;this.reads++;readWasPosted=true;
      const reading=Promise.resolve().then(()=>{this.signal?.throwIfAborted();return this.blob.slice(this.offset,this.offset+length).arrayBuffer();}).then(
        value=>{this.pending=false;return value;},error=>{this.pending=false;throw error;});
      const buffer=await abortable(reading,this.signal);
      this.signal?.throwIfAborted();
      if(!isArrayBuffer(buffer)||buffer.byteLength!==length)fail('slice backing/length');
      this.peakBacking=Math.max(this.peakBacking,buffer.byteLength);this.offset+=length;
      return new Uint8Array(buffer);
    }finally{if(readWasPosted)this.readMs+=performance.now()-started;this.active=false;}
  }

  async dispose():Promise<void> {
    if(this.disposal)return this.disposal;
    this.disposed=true;this.signal?.removeEventListener('abort',this.abort);
    this.disposal=(async()=>{
      this.cancelReader();
      if(this.cancellation){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const settled=await Promise.race([this.cancellation.then(()=>true),
            new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),CLEANUP_MS);})]);
          if(!settled)this.cleanupTimedOut=true;
        }finally{if(timer!==undefined)clearTimeout(timer);}
      }
      if(this.reader){
        try{this.reader.releaseLock();this.lockReleased=true;}catch{/* Pending/non-standard provider remains explicit. */}
      }
      this.reader=undefined;this.backing=undefined;
    })();
    return this.disposal;
  }

  get stats():BoundedBlobInputStats {
    return Object.freeze({requested:this.requested,actual:this.actual,byobAvailable:this.byobAvailable,fallbackReason:this.fallbackReason,
      reads:this.reads,bytes:this.offset,peakBackingBytes:this.peakBacking,readAwaitMs:this.readMs,eof:this.eof,
      disposed:this.disposed,readPending:this.pending,cancelRequested:this.cancelRequested,cancelSettled:this.cancelSettled,
      cancelRejected:this.cancelRejected,cleanupTimedOut:this.cleanupTimedOut,lockReleased:this.lockReleased});
  }
}

export async function createBoundedBlobInput(blob:Blob,options:BoundedBlobInputOptions={}):Promise<BoundedBlobInput> {
  options.signal?.throwIfAborted();
  const mode=options.mode??'auto',chunkBytes=options.chunkBytes??MAX_CHUNK_BYTES;
  if(!(blob instanceof Blob)||!['auto','byob','slice'].includes(mode)||!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>MAX_CHUNK_BYTES)
    fail('options');
  if(mode==='slice')return new BoundedBlobInput(blob,{...options,mode,chunkBytes},undefined,null);
  let stream:ReadableStream<Uint8Array<ArrayBuffer>>|undefined,reader:ReadableStreamBYOBReader|undefined;
  try{stream=blob.stream();reader=stream.getReader({mode:'byob'});}
  catch{
    // No bytes have been consumed and no target has been touched. Negotiation
    // failure can safely choose the existing slice path. Read errors cannot.
    try{void stream?.cancel().catch(()=>undefined);}catch{/* No owned reader. */}
    if(mode==='byob')fail('BYOB unavailable');
    return new BoundedBlobInput(blob,{...options,mode,chunkBytes},undefined,false);
  }
  return new BoundedBlobInput(blob,{...options,mode,chunkBytes},reader,true);
}
