import type {InventorySource} from './inventory-evidence';

/** The pixels must be the actual complete RGBA input offered to the reader.
 * This container does not decide whether acquisition or identity is valid. */
export interface UnknownCrop {
  readonly source: InventorySource;
  /** Original scheduling group, never evidence that two crops are the same card. */
  readonly group: number;
  readonly recipe: string;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourceBox: Readonly<{x:number;y:number;width:number;height:number}>;
  readonly rgba: Uint8ClampedArray;
}

export type RetainUnknownCrop = 'retained' | 'duplicate' | 'capacity' | 'conflict' | 'invalid' | 'allocation-failed' | 'closed';
type Entry=Omit<UnknownCrop,'rgba'> & {readonly rgba:Uint8ClampedArray};

const nonnegative=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const positive=(n:number)=>Number.isSafeInteger(n)&&n>0;
const id=(s:unknown)=>typeof s==='string'&&s.length>0&&s.length<=160;
function validCrop(crop:UnknownCrop):boolean {
  const s=crop?.source,b=crop?.sourceBox;
  return !!s && id(s.sessionId) && id(s.observationId) && id(s.frame) &&
    nonnegative(s.frameId) && nonnegative(s.captureOrder) && Number.isFinite(s.captureTime) && s.captureTime>=0 &&
    (s.phase==='input'||s.phase==='recovery') && nonnegative(s.slot) && s.slot<40 && nonnegative(crop.group) && id(crop.recipe) &&
    positive(crop.width) && positive(crop.height) && positive(crop.sourceWidth) && positive(crop.sourceHeight) &&
    !!b && [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.x>=0 && b.y>=0 && b.width>0 && b.height>0 &&
    b.x+b.width<=crop.sourceWidth && b.y+b.height<=crop.sourceHeight &&
    Number.isSafeInteger(crop.width*crop.height*4) && crop.rgba instanceof Uint8ClampedArray &&
    crop.rgba.buffer instanceof ArrayBuffer && crop.rgba.byteLength===crop.width*crop.height*4;
}
function sameSource(a:InventorySource,b:InventorySource):boolean {
  return a.sessionId===b.sessionId&&a.observationId===b.observationId&&a.frameId===b.frameId&&a.frame===b.frame&&
    a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot;
}
function sameMetadata(a:Entry,b:UnknownCrop):boolean {
  const x=a.sourceBox,y=b.sourceBox;
  return sameSource(a.source,b.source)&&a.group===b.group&&a.recipe===b.recipe&&a.width===b.width&&a.height===b.height&&
    a.sourceWidth===b.sourceWidth&&a.sourceHeight===b.sourceHeight&&
    x.x===y.x&&x.y===y.y&&x.width===y.width&&x.height===y.height;
}
function samePixels(a:Uint8ClampedArray,b:Uint8ClampedArray):boolean {
  if(a.byteLength!==b.byteLength)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
const key=(s:InventorySource)=>JSON.stringify([s.sessionId,s.observationId]);

/** Bounded in-memory evidence storage, not an identity or freshness policy.
 * It never evicts an unresolved source to make room for a newer one. A refused
 * item must remain unresolved in the owning scanner. Every access returns a
 * copy: retained bytes exclude the caller's canvas, input and returned copies. */
export class UnknownCropRetention {
  private entries=new Map<string,Entry>();
  private bytes=0;
  private closed=false;
  private capacityRefusals=0;
  private conflicts=0;
  private invalid=0;
  private allocationFailures=0;
  private readonly limits:Readonly<{entries:number;bytes:number}>;
  constructor(limits:Readonly<{entries:number;bytes:number}>) {
    if(!nonnegative(limits.entries)||!nonnegative(limits.bytes))throw new RangeError('Invalid crop retention limits');
    this.limits=Object.freeze({...limits});
  }
  retain(crop:UnknownCrop):RetainUnknownCrop {
    if(this.closed)return 'closed';
    if(!validCrop(crop)){this.invalid++;return 'invalid';}
    const k=key(crop.source),old=this.entries.get(k);
    if(old) {
      if(sameMetadata(old,crop)&&samePixels(old.rgba,crop.rgba))return 'duplicate';
      this.conflicts++;return 'conflict';
    }
    if(this.entries.size>=this.limits.entries||crop.rgba.byteLength>this.limits.bytes-this.bytes){
      this.capacityRefusals++;return 'capacity';
    }
    // Own both the data and metadata independently of canvases and callers.
    let rgba:Uint8ClampedArray;
    try {rgba=crop.rgba.slice();} catch {this.allocationFailures++;return 'allocation-failed';}
    const entry:Entry={source:Object.freeze({...crop.source}),group:crop.group,recipe:crop.recipe,width:crop.width,height:crop.height,
      sourceWidth:crop.sourceWidth,sourceHeight:crop.sourceHeight,sourceBox:Object.freeze({...crop.sourceBox}),rgba};
    this.entries.set(k,entry);this.bytes+=entry.rgba.byteLength;
    return 'retained';
  }
  get(source:InventorySource):UnknownCrop|undefined {
    if(this.closed||!source)return;
    const entry=this.entries.get(key(source));
    if(!entry||!sameSource(entry.source,source))return;
    return {...entry,rgba:entry.rgba.slice()};
  }
  /** Storage comparison only: matching pixels do not establish card identity. */
  matches(crop:UnknownCrop):boolean {
    if(this.closed||!validCrop(crop))return false;
    const entry=this.entries.get(key(crop.source));
    return !!entry&&sameMetadata(entry,crop)&&samePixels(entry.rgba,crop.rgba);
  }
  /** Compare a later reader input to an exact retained source. This is only
   * byte equality, not proof of an unobscured card or independent observation.
   * The successful read's own quality, identity and budget rules still apply. */
  matchesPixels(source:InventorySource,pixels:Pick<UnknownCrop,'recipe'|'width'|'height'|'rgba'>):boolean {
    if(this.closed||!source||!pixels||!(pixels.rgba instanceof Uint8ClampedArray)||
      !(pixels.rgba.buffer instanceof ArrayBuffer))return false;
    const entry=this.entries.get(key(source));
    return !!entry&&sameSource(entry.source,source)&&entry.recipe===pixels.recipe&&
      entry.width===pixels.width&&entry.height===pixels.height&&samePixels(entry.rgba,pixels.rgba);
  }
  /** Only original retained sources and their original groups are returned; a match does not resolve
   * them, validate the new input, or count as another observation. */
  matchingSources(pixels:Pick<UnknownCrop,'recipe'|'width'|'height'|'rgba'>):readonly Readonly<{source:InventorySource;group:number}>[] {
    if(this.closed||!pixels||!(pixels.rgba instanceof Uint8ClampedArray)||
      !(pixels.rgba.buffer instanceof ArrayBuffer))return [];
    const result:{source:InventorySource;group:number}[]=[];
    for(const entry of this.entries.values())if(entry.recipe===pixels.recipe&&entry.width===pixels.width&&
      entry.height===pixels.height&&samePixels(entry.rgba,pixels.rgba))result.push({source:entry.source,group:entry.group});
    return result;
  }
  /** Call only after the owner has handled this exact source independently. */
  release(source:InventorySource):boolean {
    if(this.closed||!source)return false;
    const k=key(source),entry=this.entries.get(k);
    if(!entry||!sameSource(entry.source,source))return false;
    this.entries.delete(k);this.bytes-=entry.rgba.byteLength;return true;
  }
  snapshot() {
    return {entries:this.entries.size,bytes:this.bytes,limits:this.limits,capacityRefusals:this.capacityRefusals,
      conflicts:this.conflicts,invalid:this.invalid,allocationFailures:this.allocationFailures,closed:this.closed};
  }
  dispose():void {this.entries.clear();this.bytes=0;this.closed=true;}
}
