import {createBoundedBlobInput,type BoundedBlobInputStats,type BoundedInputMode} from './bounded-blob-input';

/** Bounded payload input with source identity checks and explicit buffer ownership. */
export interface ReadSourceSnapshot {readonly byteLength:number;readonly revision:string}
/** read transfers exclusive use of the returned backing to this decoder until
 * the next read. Providers must not retain/mutate it or hide extra allocations.
 * snapshot must reflect underlying mutations. Pixel SHA verification remains a
 * caller requirement: metadata cannot detect an unreported in-place mutation. */
export interface BoundedReadSource {
  snapshot():ReadSourceSnapshot;
  read(offset:number,length:number):Uint8Array<ArrayBuffer>|Promise<Uint8Array<ArrayBuffer>>;
}
export type GenericInputSpec={readonly kind:'range';readonly source:BoundedReadSource;readonly start:number;readonly length:number}|
  {readonly kind:'blob';readonly blob:Blob;readonly inputMode?:BoundedInputMode};
export interface GenericInputOptions {readonly chunkBytes?:number;readonly signal?:AbortSignal}
export interface GenericInputStats {
  readonly kind:'range'|'blob';readonly size:number;readonly bytes:number;readonly reads:number;
  readonly peakBackingBytes:number;readonly readAwaitMs:number;readonly eof:boolean;readonly disposed:boolean;
  readonly readPending:boolean;readonly sourceChanged:boolean;readonly blob?:BoundedBlobInputStats;
}
export interface GenericBoundedInput {
  readonly size:number;
  next():Promise<Uint8Array<ArrayBuffer>|undefined>;
  assertUnchanged():void;
  dispose():Promise<void>;
  readonly stats:GenericInputStats;
}
const CAP=32768;
function fail(message:string):never {throw new TypeError(`Invalid generic bounded input: ${message}`);}
const natural=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
function abortReason(signal:AbortSignal):unknown {return signal.reason??new DOMException('Aborted','AbortError');}
/** Late native completion is observed only to release pending state; it never
 * invokes a decoder continuation after abort has won this race. */
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return promise;
  return new Promise<T>((resolve,reject)=>{
    let done=false;
    const clean=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{if(done)return;done=true;clean();reject(abortReason(signal));};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{if(done)return;done=true;clean();resolve(value);},error=>{if(done)return;done=true;clean();reject(error);});
    if(signal.aborted)abort();
  });
}
function record(value:unknown,label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(label);
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(typeof key!=='string'||!('value'in descriptor))fail(`${label} accessor/symbol`);
  }
  return value as Record<string,unknown>;
}
function own(value:object,key:string):unknown {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!('value'in descriptor))fail(`own data ${key}`);
  return descriptor.value;
}
function snapshot(value:unknown):ReadSourceSnapshot {
  const object=record(value,'snapshot');
  if(Reflect.ownKeys(object).length!==2||!natural(own(object,'byteLength'))||typeof own(object,'revision')!=='string'||
    !(object.revision as string).length||(object.revision as string).length>256)fail('source snapshot');
  return Object.freeze({byteLength:object.byteLength as number,revision:object.revision as string});
}
function checkedBacking(value:unknown,requestBytes:number,chunkBytes:number):Uint8Array<ArrayBuffer> {
  if(!(value instanceof Uint8Array)||!(value.buffer instanceof ArrayBuffer)||(value.buffer as ArrayBuffer&{resizable?:boolean}).resizable||
    value.byteOffset!==0||!value.byteLength||value.byteLength>requestBytes||value.buffer.byteLength>chunkBytes||
    value.byteLength>value.buffer.byteLength)fail('read result length/backing');
  return value as Uint8Array<ArrayBuffer>;
}

class RangeInput implements GenericBoundedInput {
  readonly size:number;
  private readonly source:BoundedReadSource;
  private readonly readFunction:BoundedReadSource['read'];
  private readonly snapshotFunction:BoundedReadSource['snapshot'];
  private readonly identity:ReadSourceSnapshot;
  private readonly start:number;
  private readonly chunkBytes:number;
  private readonly signal?:AbortSignal;
  private bytes=0;private reads=0;private peak=0;private readMs=0;
  private eof=false;private disposed=false;private active=false;private pending=false;private sourceChanged=false;
  constructor(spec:Extract<GenericInputSpec,{kind:'range'}>,options:GenericInputOptions){
    this.source=record(spec.source,'source') as unknown as BoundedReadSource;
    this.readFunction=own(this.source,'read') as BoundedReadSource['read'];
    this.snapshotFunction=own(this.source,'snapshot') as BoundedReadSource['snapshot'];
    if(typeof this.readFunction!=='function'||typeof this.snapshotFunction!=='function')fail('source functions');
    this.identity=snapshot(this.snapshotFunction.call(this.source));
    this.start=spec.start;this.size=spec.length;this.chunkBytes=options.chunkBytes??CAP;this.signal=options.signal;
    if(!natural(this.start)||!natural(this.size)||!Number.isSafeInteger(this.start+this.size)||this.start+this.size>this.identity.byteLength)
      fail('source range');
    this.assertUnchanged();
  }
  assertUnchanged():void {
    this.signal?.throwIfAborted();
    try{
      record(this.source,'source');
      if(own(this.source,'read')!==this.readFunction||own(this.source,'snapshot')!==this.snapshotFunction)fail('source function changed');
      const current=snapshot(this.snapshotFunction.call(this.source));
      if(current.byteLength!==this.identity.byteLength||current.revision!==this.identity.revision)fail('source snapshot changed');
    }catch(error){this.sourceChanged=true;throw error;}
  }
  async next():Promise<Uint8Array<ArrayBuffer>|undefined> {
    this.assertUnchanged();
    if(this.disposed)fail('source disposed');
    if(this.active||this.pending)fail('concurrent range read');
    if(this.eof)return undefined;
    if(this.bytes===this.size){this.eof=true;return undefined;}
    this.active=true;this.pending=true;this.reads++;
    const requestBytes=Math.min(this.chunkBytes,this.size-this.bytes),at=this.start+this.bytes,started=performance.now();
    try{
      const reading=Promise.resolve().then(()=>{
        this.assertUnchanged();if(this.disposed)fail('disposed before native read');
        return this.readFunction.call(this.source,at,requestBytes);
      }).then(value=>{this.pending=false;return value;},error=>{this.pending=false;throw error;});
      const value=await abortable(reading,this.signal);
      this.signal?.throwIfAborted();this.assertUnchanged();
      if(this.disposed)fail('late completion after disposal');
      const chunk=checkedBacking(value,requestBytes,this.chunkBytes);
      this.peak=Math.max(this.peak,chunk.buffer.byteLength);this.bytes+=chunk.byteLength;
      return chunk;
    }finally{this.readMs+=performance.now()-started;this.active=false;}
  }
  async dispose():Promise<void> {this.disposed=true;}
  get stats():GenericInputStats {
    return Object.freeze({kind:'range',size:this.size,bytes:this.bytes,reads:this.reads,peakBackingBytes:this.peak,
      readAwaitMs:this.readMs,eof:this.eof,disposed:this.disposed,readPending:this.pending,sourceChanged:this.sourceChanged});
  }
}
class BlobInput implements GenericBoundedInput {
  readonly size:number;
  private readonly blob:Blob;
  private readonly input:Awaited<ReturnType<typeof createBoundedBlobInput>>;
  private readonly signal?:AbortSignal;
  private disposed=false;private changed=false;
  constructor(blob:Blob,input:Awaited<ReturnType<typeof createBoundedBlobInput>>,signal?:AbortSignal){
    this.blob=blob;this.size=blob.size;this.input=input;this.signal=signal;
  }
  assertUnchanged():void {
    this.signal?.throwIfAborted();
    if(this.blob.size!==this.size){this.changed=true;fail('Blob size changed');}
  }
  async next():Promise<Uint8Array<ArrayBuffer>|undefined> {
    this.assertUnchanged();if(this.disposed)fail('source disposed');
    const value=await this.input.next();this.assertUnchanged();
    if(this.disposed)fail('late Blob completion after disposal');
    return value;
  }
  async dispose():Promise<void> {this.disposed=true;await this.input.dispose();}
  get stats():GenericInputStats {
    const info=this.input.stats;
    return Object.freeze({kind:'blob',size:this.size,bytes:info.bytes,reads:info.reads,peakBackingBytes:info.peakBackingBytes,
      readAwaitMs:info.readAwaitMs,eof:info.eof,disposed:this.disposed,readPending:info.readPending,
      sourceChanged:this.changed,blob:info});
  }
}
export async function createGenericBoundedInput(value:GenericInputSpec,options:GenericInputOptions={}):Promise<GenericBoundedInput> {
  options.signal?.throwIfAborted();
  const spec=record(value,'input spec'),chunkBytes=options.chunkBytes??CAP;
  if(!natural(chunkBytes,1)||chunkBytes>CAP)fail('chunk bytes');
  if(spec.kind==='range'){
    if(Reflect.ownKeys(spec).length!==4||!['kind','source','start','length'].every(key=>Object.hasOwn(spec,key)))fail('range fields');
    return new RangeInput(value as Extract<GenericInputSpec,{kind:'range'}>,{...options,chunkBytes});
  }
  if(spec.kind==='blob'){
    if(!['kind','blob'].every(key=>Object.hasOwn(spec,key))||
      Reflect.ownKeys(spec).some(key=>!['kind','blob','inputMode'].includes(key as string))||!(spec.blob instanceof Blob))fail('Blob fields');
    const blob=spec.blob,bytes=blob.size;
    const input=await createBoundedBlobInput(blob,{signal:options.signal,chunkBytes,mode:spec.inputMode as BoundedInputMode|undefined});
    try{
      options.signal?.throwIfAborted();
      if(blob.size!==bytes)fail('Blob changed during setup');
      return new BlobInput(blob,input,options.signal);
    }catch(error){await input.dispose();throw error;}
  }
  return fail('input kind');
}
