import {parseObservationFact, type ObservationSource} from '../src/features/card-scanner/session/observation-execution';

/** Prototype only. A match establishes equal pixels, never card identity.
 * Call capture only in the trusted acquisition path, with the actual padded
 * readback and its actual source. A worker, imported ID or replay event alone
 * cannot create evidence of acquisition. */
export type ExactGeometry = Readonly<{width:number;height:number;left:number;top:number;
  cardX:number;cardY:number;cardWidth:number;cardHeight:number;scale:number}>;
export type ExactReceipt = object;
type Capture = {source:ObservationSource; geometry:ExactGeometry; pixels:Uint8ClampedArray};
export type ExactPair = Readonly<{earlier:ObservationSource;later:ObservationSource}>;
const REPLAY_CROP_MAX_BYTES=8*1024*1024;

function checkedSource(source:ObservationSource):ObservationSource {
  return parseObservationFact({version:1,kind:'queued',attemptId:0,source}).source;
}
function checkedGeometry(g:ExactGeometry):ExactGeometry {
  const keys=['width','height','left','top','cardX','cardY','cardWidth','cardHeight','scale'] as const;
  if(!g||Object.keys(g).length!==keys.length||keys.some(k=>!Object.hasOwn(g,k)||!Number.isFinite(g[k]))||
    !Number.isSafeInteger(g.width)||!Number.isSafeInteger(g.height)||g.width<1||g.height<1||
    !Number.isSafeInteger(g.left)||!Number.isSafeInteger(g.top)||g.left<0||g.top<0||
    g.cardX<0||g.cardY<0||g.cardWidth<=0||g.cardHeight<=0||g.scale<=0||
    g.cardX+g.cardWidth>g.width||g.cardY+g.cardHeight>g.height||
    !Number.isSafeInteger(g.width*g.height*4)) throw new Error('invalid capture geometry');
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,g[k]])) as ExactGeometry);
}
function geometryKey(g:ExactGeometry):string {
  return JSON.stringify([g.width,g.height,g.left,g.top,g.cardX,g.cardY,g.cardWidth,g.cardHeight,g.scale]);
}
function sameBytes(a:Uint8ClampedArray,b:Uint8ClampedArray):boolean {
  if(a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
function checkedCapture(source:ObservationSource,geometry:ExactGeometry,pixels:Uint8ClampedArray,limit=Number.MAX_SAFE_INTEGER):Capture {
  const s=checkedSource(source),g=checkedGeometry(geometry);
  if(!(pixels instanceof Uint8ClampedArray)||!(pixels.buffer instanceof ArrayBuffer)||
    pixels.length!==g.width*g.height*4||pixels.byteLength>limit)
    throw new Error('invalid padded pixels');
  return {source:s,geometry:g,pixels:pixels.slice()};
}
function compare(a:Capture,b:Capture):ExactPair|null {
  if(a.source.sessionId!==b.source.sessionId||a.source.captureOrder>=b.source.captureOrder||
    a.source.observationId===b.source.observationId||geometryKey(a.geometry)!==geometryKey(b.geometry)||
    !sameBytes(a.pixels,b.pixels)) return null;
  return Object.freeze({earlier:a.source,later:b.source});
}

/** Strict byte budget; receipts are instance-local, nonserializable capabilities.
 * Eviction invalidates them; cross-instance or forged objects never match. */
export class ExactObservationProofs {
  private readonly entries=new Map<ExactReceipt,Capture>();
  // Keep a bounded lifetime tombstone set: an evicted ID cannot be recycled.
  // Saturation stops new receipts rather than forgetting old provenance.
  private readonly sources=new Set<string>();
  private bytes=0;
  private readonly maxBytes:number;
  private readonly maxEntries:number;
  constructor(maxBytes:number,maxEntries:number) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxEntries)||maxEntries<0)
      throw new Error('invalid proof budget');
    this.maxBytes=maxBytes;this.maxEntries=maxEntries;
  }
  capture(source:ObservationSource,geometry:ExactGeometry,pixels:Uint8ClampedArray):ExactReceipt|null {
    if(pixels.byteLength>this.maxBytes||this.maxEntries===0)return null;
    const value=checkedCapture(source,geometry,pixels,this.maxBytes);
    const sourceKey=JSON.stringify([value.source.sessionId,value.source.observationId]);
    // Never let an attacker reuse a live source identifier with different pixels.
    if(this.sources.has(sourceKey)||this.sources.size>=this.maxEntries*64)return null;
    while(this.entries.size>=this.maxEntries||this.bytes+value.pixels.byteLength>this.maxBytes) {
      const first=this.entries.keys().next().value as ExactReceipt|undefined;
      if(!first)break;
      this.remove(first);
    }
    const receipt=Object.freeze({});
    this.entries.set(receipt,value);this.sources.add(sourceKey);this.bytes+=value.pixels.byteLength;
    return receipt;
  }
  match(earlier:ExactReceipt,later:ExactReceipt):ExactPair|null {
    const a=this.entries.get(earlier),b=this.entries.get(later);
    return a&&b?compare(a,b):null;
  }
  remove(receipt:ExactReceipt):void {
    const value=this.entries.get(receipt);if(!value)return;
    this.entries.delete(receipt);
    this.bytes-=value.pixels.byteLength;
  }
  usage():Readonly<{bytes:number;entries:number}> {return {bytes:this.bytes,entries:this.entries.size};}
}

/** Pixel comparison only: even success says nothing about whether the given
 * source IDs really produced those pixels. Replay needs a separately verified
 * source-bound manifest and matching crop recipe; hashes do not authenticate a
 * fabricated manifest. Missing or corrupt bytes yield no comparison. */
export async function compareReplayPixelsOnly(
  earlier:{source:ObservationSource;geometry:ExactGeometry;pixels:Uint8ClampedArray;sha256:string}|null,
  later:{source:ObservationSource;geometry:ExactGeometry;pixels:Uint8ClampedArray;sha256:string}|null,
):Promise<Readonly<{kind:'pixels-equal-only';pair:ExactPair}>|null> {
  if(!earlier||!later||![earlier.sha256,later.sha256].every(x=>/^[0-9a-f]{64}$/.test(x)))return null;
  try {
    const a=checkedCapture(earlier.source,earlier.geometry,earlier.pixels,REPLAY_CROP_MAX_BYTES);
    const b=checkedCapture(later.source,later.geometry,later.pixels,REPLAY_CROP_MAX_BYTES);
    const hash=async(pixels:Uint8ClampedArray)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels.buffer as ArrayBuffer)))
      .map(n=>n.toString(16).padStart(2,'0')).join('');
    const [ha,hb]=await Promise.all([hash(a.pixels),hash(b.pixels)]);
    const pair=ha===earlier.sha256&&hb===later.sha256?compare(a,b):null;
    return pair?Object.freeze({kind:'pixels-equal-only' as const,pair}):null;
  } catch {return null;}
}
