import {pixelHash} from '../reproduction/recording-frame-integrity';

/** Experimental, capture-instance-local evidence of a restored raster only.
 * It is not evidence of a crop, OCR call, card identity or absence of occlusion. */
export interface RestoredPixelIdentity {readonly sourceFrameId:number;readonly time:number;readonly width:number;readonly height:number;readonly hash:string}
export interface RestoredPixelProofOptions {readonly maxFrames:number;readonly lifetimeMs:number;readonly maxWorkingBytes:number}
export type RestoredPixelCapability=object;

// Read internal slots rather than user-shadowable `buffer`, `byteLength` or
// `byteOffset` properties on the returned, mutable typed array.
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedBuffer=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const typedLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
const typedOffset=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!;
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!;
const bufferResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
function fixedWholeBuffer(value:unknown,prototype:object,size:number):ArrayBuffer|undefined {
  try{
    if(typeof value!=='object'||value===null||Object.getPrototypeOf(value)!==prototype)return;
    const buffer:unknown=typedBuffer.call(value);
    if(!(buffer instanceof ArrayBuffer)||bufferResizable?.call(buffer)===true||
      typedOffset.call(value)!==0||typedLength.call(value)!==size||bufferLength.call(buffer)!==size)return;
    return buffer;
  }catch{return;}
}

function snapshotIdentity(value:RestoredPixelIdentity):RestoredPixelIdentity{
  if(typeof value!=='object'||value===null||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Invalid restored pixel identity');
  const fields=['sourceFrameId','time','width','height','hash'] as const;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==fields.length||fields.some(key=>!Object.hasOwn(descriptors,key)||!Object.hasOwn(descriptors[key],'value')))
    throw Error('Invalid restored pixel identity');
  const sourceFrameId=descriptors.sourceFrameId.value,time=descriptors.time.value,width=descriptors.width.value,
    height=descriptors.height.value,hash=descriptors.hash.value;
  if(typeof sourceFrameId!=='number'||!Number.isSafeInteger(sourceFrameId)||sourceFrameId<1||typeof width!=='number'||!Number.isSafeInteger(width)||width<1||
     typeof height!=='number'||!Number.isSafeInteger(height)||height<1||typeof time!=='number'||!Number.isFinite(time)||time<0||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))
    throw Error('Invalid restored pixel identity');
  return Object.freeze({sourceFrameId,time,width,height,hash});
}

export function createRestoredPixelCapabilities(options:RestoredPixelProofOptions){
  if(!Number.isSafeInteger(options.maxFrames)||options.maxFrames<1||options.maxFrames>1024||
     !Number.isSafeInteger(options.lifetimeMs)||options.lifetimeMs<1||options.lifetimeMs>300_000||
     !Number.isSafeInteger(options.maxWorkingBytes)||options.maxWorkingBytes<1||options.maxWorkingBytes>256*1024*1024)
    throw Error('Invalid restored pixel proof limits');
  const {maxFrames,lifetimeMs,maxWorkingBytes}=options;
  // Weak keys and weak raster references mean neither the capability nor this
  // owner keeps the large raster alive. The count is an issuance budget, so GC
  // timing cannot increase capacity nondeterministically.
  const tokens=new WeakMap<object,{pixels:WeakRef<Uint8Array<ArrayBuffer>>;identity:RestoredPixelIdentity;expires:number}>();
  let issued=0,working=0,closed=false;
  const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(closed)throw Error('Restored pixel proof session closed');};
  const reserve=(size:number)=>{if(!Number.isSafeInteger(size)||size<1||working+size*2>maxWorkingBytes)throw Error('Restored pixel proof budget exceeded');working+=size*2;};
  const sameIdentity=(a:RestoredPixelIdentity,b:RestoredPixelIdentity)=>a.sourceFrameId===b.sourceFrameId&&a.time===b.time&&
    a.width===b.width&&a.height===b.height&&a.hash===b.hash;
  const whole=(pixels:Uint8Array<ArrayBuffer>,size:number)=>fixedWholeBuffer(pixels,Uint8Array.prototype,size);
  return {
    async issue(source:Uint8ClampedArray<ArrayBuffer>,identity:RestoredPixelIdentity,signal:AbortSignal,current:()=>boolean){
      check(signal);if(issued>=maxFrames)throw Error('Restored pixel proof issuance limit');
      const fixed=snapshotIdentity(identity),size=fixed.width*fixed.height*4;
      if(!fixedWholeBuffer(source,Uint8ClampedArray.prototype,size)||!current())
        throw Error('Invalid restored pixel identity');
      reserve(size);
      // Reserve the issuance slot before awaiting to prevent concurrent callers
      // from exceeding the count, including on failed attempts.
      issued++;
      try{
        const pixels=new Uint8Array(source);const actual=await pixelHash(pixels);check(signal);
        if(!current()||actual!==fixed.hash)throw Error('Restored pixel SHA mismatch');
        const token=Object.freeze(Object.create(null)) as RestoredPixelCapability;
        tokens.set(token,{pixels:new WeakRef(pixels),identity:fixed,expires:performance.now()+lifetimeMs});
        return {pixels,token};
      }finally{working-=size*2;}
    },
    /** Signals cancel only the current operation. Session invalidation is
     * explicit via close() (or the owning capture's cancel/discard). Rechecks
     * current bytes at this instant; mutable bytes cannot authorize later OCR. */
    async verify(token:unknown,expected:RestoredPixelIdentity,signal:AbortSignal):Promise<boolean>{
      check(signal);if(typeof token!=='object'||token===null)return false;
      const entry=tokens.get(token);if(!entry||performance.now()>entry.expires)return false;
      let fixed:RestoredPixelIdentity;try{fixed=snapshotIdentity(expected);}catch{return false;}
      const id=entry.identity;if(!sameIdentity(id,fixed))return false;
      const pixels=entry.pixels.deref(),size=id.width*id.height*4;
      if(!pixels||!whole(pixels,size))return false;
      reserve(size);
      try{
        const snapshot=new Uint8Array(pixels);const digest=await pixelHash(snapshot);check(signal);
        if(tokens.get(token)!==entry||performance.now()>entry.expires||digest!==id.hash||!whole(pixels,size))return false;
        // Detect changes while hashing too. Callers must still treat this as a
        // point-in-time observation, not ownership of future mutable bytes.
        for(let i=0;i<size;i++)if(snapshot[i]!==pixels[i])return false;
        return true;
      }finally{working-=size*2;}
    },
    /** Experimental one-use handoff of these exact restored bytes. The owner
     * consumes the token before any asynchronous work, even when validation,
     * budget, cancellation or transfer subsequently fails. Verification and
     * detachment occur in the same synchronous turn after hashing. This is
     * not proof that a later worker used the returned bytes for any crop/OCR. */
    async consume(token:unknown,expected:RestoredPixelIdentity,signal:AbortSignal):Promise<{pixels:Uint8Array<ArrayBuffer>;identity:RestoredPixelIdentity}|undefined>{
      const entry=typeof token==='object'&&token!==null?tokens.get(token):undefined;
      if(entry)tokens.delete(token as object);
      check(signal);if(!entry||performance.now()>entry.expires)return;
      let fixed:RestoredPixelIdentity;try{fixed=snapshotIdentity(expected);}catch{return;}
      const id=entry.identity;if(!sameIdentity(id,fixed))return;
      const pixels=entry.pixels.deref(),size=id.width*id.height*4;
      if(!pixels||!whole(pixels,size))return;
      reserve(size);
      try{
        const snapshot=new Uint8Array(pixels),digest=await pixelHash(snapshot);check(signal);
        if(performance.now()>entry.expires||digest!==id.hash)return;
        const buffer=whole(pixels,size);if(!buffer)return;
        for(let i=0;i<size;i++)if(snapshot[i]!==pixels[i])return;
        // No await, callback, or user-supplied data access between the last
        // comparison and moving the backing buffer out of the old owner.
        const moved=structuredClone(pixels,{transfer:[buffer]});
        if(!whole(moved,size))throw Error('Invalid restored pixel transfer');
        return {pixels:moved,identity:id};
      }finally{working-=size*2;}
    },
    close(){closed=true;},
  };
}
