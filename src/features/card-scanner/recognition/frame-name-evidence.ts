import {parseInventoryEvent, type InventoryEvent} from '../session/inventory-evidence';
import {parseObservationFact, type ObservationSource} from '../session/observation-execution';

/** Diagnostic-only source association. This is not a card equivalence or a
 * completion proof. Sort/filter epochs are not yet captured: always unknown. */
export interface FrameNameCell {readonly group:number;readonly source:ObservationSource}
export interface FrameNameFact {readonly version:1;readonly kind:'frame';readonly sessionId:string;
  readonly processingFrame:number;readonly frameId:number;readonly cells:readonly (FrameNameCell|null)[]}
type Entry={readonly group:number;readonly source:ObservationSource;name:string|null;conflict:boolean};
type Frame={readonly processingFrame:number;readonly frameId:number;readonly cells:readonly (Entry|null)[]};
const MAX_FRAMES=128, MAX_PENDING=4096;
function fail(reason:string):never {throw Error(`Invalid frame-name evidence: ${reason}`);}
function integer(value:unknown):value is number {return Number.isSafeInteger(value)&&(value as number)>=0;}
function string(value:unknown):value is string {return typeof value==='string'&&value.length>0&&value.length<=160&&!value.includes('\0');}
function same(a:ObservationSource,b:ObservationSource) {
  return a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&
    a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot;
}
function parseSource(value:unknown):ObservationSource {
  return parseObservationFact({version:1,kind:'queued',attemptId:0,source:value}).source;
}
function sourceOnly(source:InventoryEvent['source']):ObservationSource {
  const {sessionId,frameId,observationId,captureOrder,captureTime,phase,slot}=source;
  return {sessionId,frameId,observationId,captureOrder,captureTime,phase,slot};
}
/** A frame joins only exact observation IDs and the full matching source.
 * Accepted names may arrive before or after acquisition. No ID is propagated
 * to another group, frame or slot. Pixels and OCR data are not retained. */
export class FrameNameEvidence {
  private readonly frames=new Map<number,Frame>();
  private readonly index=new Map<string,Entry>();
  private readonly pending=new Map<string,{source:ObservationSource;id:string;conflict:boolean}>();
  private facts=0;private complete=true;
  readonly sessionId:string;
  readonly limits:{frames:number;pending:number};
  constructor(sessionId:string,limits={frames:MAX_FRAMES,pending:MAX_PENDING}) {
    if(!string(sessionId)||!integer(limits.frames)||limits.frames<1||limits.frames>MAX_FRAMES||
      !integer(limits.pending)||limits.pending<1||limits.pending>MAX_PENDING)fail('seed');
    this.sessionId=sessionId;this.limits={...limits};
  }
  capture(input:FrameNameFact):void {
    if(!input||input.version!==1||input.kind!=='frame'||input.sessionId!==this.sessionId||!integer(input.frameId)||
      !integer(input.processingFrame)||!Array.isArray(input.cells)||input.cells.length!==40||this.frames.has(input.processingFrame))fail('frame');
    const cells:(Entry|null)[]=[],ids=new Set<string>();
    for(let i=0;i<40;i++) {
      if(!Object.hasOwn(input.cells,i))fail('sparse cells');
      const value=input.cells[i];if(value===null){cells.push(null);continue;}
      if(!value||!integer(value.group))fail('group');
      const source=parseSource(value.source);
      if(source.sessionId!==this.sessionId||source.frameId!==input.frameId||source.slot!==i||source.phase!=='input'||
        ids.has(source.observationId)||this.index.has(source.observationId))fail('source');
      const prior=this.pending.get(source.observationId);
      if(prior&&!same(prior.source,source))fail('source mismatch');
      ids.add(source.observationId);cells.push({group:value.group,source,name:prior&&!prior.conflict?prior.id:null,conflict:prior?.conflict??false});
    }
    this.facts++;
    for(const item of cells)if(item){this.index.set(item.source.observationId,item);this.pending.delete(item.source.observationId);}
    this.frames.set(input.processingFrame,{processingFrame:input.processingFrame,frameId:input.frameId,cells});
    while(this.frames.size>this.limits.frames){const first=this.frames.keys().next().value!,old=this.frames.get(first)!;
      for(const item of old.cells)if(item)this.index.delete(item.source.observationId);
      this.frames.delete(first);this.complete=false;}
  }
  /** Receives the same validated event as InventoryEvidence, not a caller's
   * arbitrary confirmed flag. Its source must match the recorded frame. */
  inventory(input:unknown):void {
    const event=parseInventoryEvent(input);if(event.kind!=='name-confirmed')return;
    const source=parseSource(sourceOnly(event.source));if(source.sessionId!==this.sessionId||source.phase!=='input')fail('name session');
    const current=this.index.get(source.observationId),old=this.pending.get(source.observationId);
    if(current&&!same(current.source,source)||old&&!same(old.source,source))fail('name source mismatch');
    this.facts++;
    if(current){if(current.name&&current.name!==event.id){current.name=null;current.conflict=true;}
      else if(!current.conflict)current.name=event.id;return;}
    if(old){if(old.id!==event.id)old.conflict=true;return;}
    this.pending.set(source.observationId,{source,id:event.id,conflict:false});
    while(this.pending.size>this.limits.pending){this.pending.delete(this.pending.keys().next().value!);this.complete=false;}
  }
  snapshot() {
    return {version:1 as const,scope:'frame-name-evidence' as const,sessionId:this.sessionId,sortFilterEpoch:'unknown' as const,
      complete:this.complete,facts:this.facts,
      frames:[...this.frames.values()].map(f=>({processingFrame:f.processingFrame,frameId:f.frameId,cells:f.cells.map(c=>c?{group:c.group,source:{...c.source},
        name:c.conflict?null:c.name,conflict:c.conflict}:null)})),
      pending:[...this.pending.values()].map(p=>({source:{...p.source},id:p.conflict?null:p.id,conflict:p.conflict}))};
  }
}
export function replayFrameNameEvidence(sessionId:string,events:readonly ({kind:'frame';value:FrameNameFact}|{kind:'inventory';value:unknown})[]) {
  const evidence=new FrameNameEvidence(sessionId);
  for(const event of events) {
    if(event.kind==='frame')evidence.capture(event.value);else evidence.inventory(event.value);
  }
  return evidence.snapshot();
}
/** This checksum describes only the bounded diagnostic projection. The caller
 * must separately attest event recording, input completeness and reducer
 * provenance; this digest alone is not a complete recording checkpoint. */
export async function hashFrameNameEvidence(snapshot:ReturnType<FrameNameEvidence['snapshot']>):Promise<string|null> {
  if(!snapshot.complete)return null;
  const bytes=new TextEncoder().encode(JSON.stringify(snapshot));
  if(bytes.byteLength>16*1024*1024)fail('snapshot size');
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
