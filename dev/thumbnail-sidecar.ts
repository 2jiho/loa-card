import type {InventorySource,PresentationObservation} from '../src/features/card-scanner/session/inventory-evidence';

/** An encoding job is bound to an exact observation, not an identity proof. */
export interface ThumbnailTicket {
 readonly cardId:string;
 readonly source:InventorySource;
 readonly observationToken:symbol;
 readonly nonce:symbol;
}
interface Entry {readonly ticket:ThumbnailTicket;image?:string;bytes:number}
interface Selection {generation:number;observation:PresentationObservation|null;conflict:boolean}
interface ThumbnailSidecarOptions {
 sessionId:string;
 maxEntries?:number;
 maxSelections?:number;
 maxBytes?:number;
 maxImageBytes?:number;
 onChange?:(cardId:string)=>void;
}
const DEFAULT_ENTRIES=1100,DEFAULT_SELECTIONS=550,DEFAULT_BYTES=16*1024*1024,DEFAULT_IMAGE_BYTES=512*1024;
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160;
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const validSource=(source:InventorySource,sessionId:string):boolean=>!!source&&source.sessionId===sessionId&&
 integer(source.frameId)&&source.frameId>0&&id(source.observationId)&&integer(source.captureOrder)&&
 typeof source.captureTime==='number'&&Number.isFinite(source.captureTime)&&source.captureTime>=0&&
 (source.phase==='input'||source.phase==='recovery')&&integer(source.slot)&&source.slot<40&&id(source.frame);
function sameSource(a:InventorySource,b:InventorySource):boolean {
 return a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&
  a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot&&a.frame===b.frame;
}
const validObservation=(value:PresentationObservation,sessionId:string):boolean=>!!value&&typeof value.token==='symbol'&&
 validSource(value.source,sessionId);
const sameObservation=(a:PresentationObservation,b:PresentationObservation):boolean=>a.token===b.token&&sameSource(a.source,b.source);
function bound(value:number|undefined,fallback:number):number {
 if(value===undefined)return fallback;
 if(!Number.isSafeInteger(value)||value<0)throw RangeError('Invalid thumbnail limit');
 return value;
}

/**
 * Presentation-only, bounded experimental cache. The reducer must issue a
 * monotonically increasing per-card presentation generation whenever its
 * actual image representative changes. Each appended observation has its own
 * token even when the normalized source is identical: source fields alone do
 * not authenticate crop geometry or make two preview jobs interchangeable.
 * Generation is NOT a capture order:
 * a later decision can legitimately select an older physical observation.
 * `register`/`settle` associate data with an exact source, while `select` and
 * `get` require the reducer's current generation and source. No method changes
 * inventory, field/identity proofs, or recording. A seed with unknown source
 * must be handled separately by the caller, never guessed into this cache.
 *
 * Selection generations are not evicted while a session is active: forgetting
 * one could permit a delayed older selection to reappear. When the bounded
 * selection table is full, new IDs are refused until dispose. Source entries
 * are FIFO evicted; their old tickets cannot be reused. Byte counts estimate
 * UTF-16 strings (length * 2), not process, decoder, canvas or GPU memory.
 * The caller owns job/raster limits and must dispose on session cancellation.
 */
export class ThumbnailSidecar {
 private readonly sessionId:string;
 private readonly maxEntries:number;
 private readonly maxSelections:number;
 private readonly maxBytes:number;
 private readonly maxImageBytes:number;
 private readonly onChange?: (cardId:string)=>void;
 private readonly entries=new Map<symbol,Entry>();
 private readonly selections=new Map<string,Selection>();
 private bytes=0;
 private closed=false;
 constructor(options:ThumbnailSidecarOptions){
  if(!options||!id(options.sessionId))throw TypeError('Invalid thumbnail session');
  this.sessionId=options.sessionId;
  this.maxEntries=bound(options.maxEntries,DEFAULT_ENTRIES);
  this.maxSelections=bound(options.maxSelections,DEFAULT_SELECTIONS);
  this.maxBytes=bound(options.maxBytes,DEFAULT_BYTES);
  this.maxImageBytes=bound(options.maxImageBytes,DEFAULT_IMAGE_BYTES);
  this.onChange=options.onChange;
 }
 private notify(cardId:string){try{this.onChange?.(cardId);}catch{/* Presentation cannot fail scanning. */}}
 private visible(cardId:string):string|undefined {
  const selection=this.selections.get(cardId);
  if(!selection||selection.conflict||!selection.observation)return;
  const entry=this.entries.get(selection.observation.token);
  return entry&&entry.ticket.cardId===cardId&&sameSource(entry.ticket.source,selection.observation.source)?entry.image:undefined;
 }
 private remove(entryKey:symbol):void {
  const entry=this.entries.get(entryKey);if(!entry)return;
  const before=this.visible(entry.ticket.cardId);
  this.bytes-=entry.bytes;this.entries.delete(entryKey);
  if(before!==this.visible(entry.ticket.cardId))this.notify(entry.ticket.cardId);
 }
 /** Register an encoder job for the exact source. It does not select it. */
 register(cardId:string,observation:PresentationObservation):ThumbnailTicket|null {
  if(this.closed||!id(cardId)||!validObservation(observation,this.sessionId)||this.maxEntries===0)return null;
  const sourceKey=observation.token,existing=this.entries.get(sourceKey);
  if(existing)return existing.ticket.cardId===cardId&&sameSource(existing.ticket.source,observation.source)?existing.ticket:null;
  const ticket=Object.freeze({cardId,source:Object.freeze({...observation.source}),observationToken:sourceKey,nonce:Symbol('thumbnail')});
  this.entries.set(sourceKey,{ticket,bytes:0});
  while(this.entries.size>this.maxEntries)this.remove(this.entries.keys().next().value as symbol);
  return this.entries.get(sourceKey)?.ticket??null;
 }
 /** Only the reducer may select a representative. Equal-generation conflict
  * remains unknown until a strictly newer generation; stale decisions cannot
  * replace a newer one even if they arrive late. */
 select(cardId:string,generation:number,observation:PresentationObservation|null):boolean {
  if(this.closed||!id(cardId)||!integer(generation)||observation!==null&&!validObservation(observation,this.sessionId))return false;
  const previous=this.selections.get(cardId);
  if(!previous&&this.selections.size>=this.maxSelections)return false;
  if(previous&&generation<previous.generation)return false;
  if(previous&&generation===previous.generation){
   if(!previous.conflict&&((observation===null&&previous.observation===null)||
     observation!==null&&previous.observation!==null&&sameObservation(observation,previous.observation)))return true;
   const before=this.visible(cardId);previous.conflict=true;previous.observation=null;
   if(before!==this.visible(cardId))this.notify(cardId);
   return false;
  }
  const before=this.visible(cardId);
  this.selections.set(cardId,{generation,observation:observation===null?null:Object.freeze({token:observation.token,
   source:Object.freeze({...observation.source})}),conflict:false});
  if(before!==this.visible(cardId))this.notify(cardId);
  return true;
 }
 /** Settle only the original live job. A result may be cached while unselected
  * but it is never displayed unless the current reducer selection matches. */
 settle(ticket:ThumbnailTicket|null|undefined,image:unknown):boolean {
  if(this.closed||!ticket||typeof image!=='string')return false;
  const entryKey=ticket.observationToken,entry=this.entries.get(entryKey),bytes=image.length*2;
  if(!entry||entry.ticket!==ticket||entry.image||bytes>this.maxBytes||bytes>this.maxImageBytes||
    !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))return false;
  const before=this.visible(ticket.cardId);
  entry.image=image;entry.bytes=bytes;this.bytes+=bytes;
  while(this.bytes>this.maxBytes)this.remove(this.entries.keys().next().value as symbol);
  if(this.entries.get(entryKey)!==entry)return false;
  if(before!==this.visible(ticket.cardId))this.notify(ticket.cardId);
  return true;
 }
 get(cardId:string,generation:number,observation:PresentationObservation):string|undefined {
  if(this.closed||!validObservation(observation,this.sessionId))return;
  const selection=this.selections.get(cardId);
  if(!selection||selection.conflict||selection.generation!==generation||!selection.observation||
    !sameObservation(selection.observation,observation))return;
  return this.visible(cardId);
 }
 stats(){return {entries:this.entries.size,selections:this.selections.size,estimatedStringBytes:this.bytes,closed:this.closed};}
 dispose(){if(this.closed)return;this.closed=true;this.entries.clear();this.selections.clear();this.bytes=0;}
}
