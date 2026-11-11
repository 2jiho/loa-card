import type {RunStateTraceSnapshot} from './run-state-trace';
import {analyzeFrameNames} from '../src/features/card-scanner/recognition/frame-name-offline';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

type Cell={group:number;source:ObservationSource;fresh:boolean};
type Frame={number:number;sequence:number;cells:(Cell|null)[]};
type Name={id:string;source:ObservationSource;eventSequence:number};
const key=(s:ObservationSource)=>JSON.stringify([s.sessionId,s.observationId]);
const same=(a:ObservationSource,b:ObservationSource)=>a.sessionId===b.sessionId&&a.observationId===b.observationId&&
 a.frameId===b.frameId&&a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot;

/** Offline investigation only. No output can retire an observation, determine
 * identity, or certify latest fields. The trace envelope must be validated by
 * parseRunStateTrace before calling this function. */
export async function analyzeAssociation(trace:RunStateTraceSnapshot,first:string,second:string) {
 if(!first||!second||first===second)throw Error('Two distinct observation IDs are required');
 const validation=await analyzeFrameNames(trace);
 if(validation.inputStatus!=='complete')return {status:'unavailable' as const,reason:'input trace did not pass receipt and inventory validation',validation,associationProven:false as const};
 const frames:Frame[]=[],sources=new Map<string,{cell:Cell;frame:Frame}>();
 let cells:(Cell|null)[]=Array(40).fill(null),open=false;
 for(const event of trace.events){
  if(event.type!=='grid-command')continue;
  const cmd=event.value;
  if(cmd.method==='begin'){open=cmd.args[0];cells=Array(40).fill(null);}
  else if(cmd.method==='group'&&open){const [slot,group,,fresh,,source]=cmd.args;if(source)cells[slot]={group,source,fresh};}
  else if(cmd.method==='record'&&open){const frame={number:cmd.args[0],sequence:event.seq,cells};frames.push(frame);
   for(const cell of cells)if(cell){if(sources.has(key(cell.source)))throw Error('Duplicate observation source');sources.set(key(cell.source),{cell,frame});}
   cells=Array(40).fill(null);open=false;}
 }
 const selected=(id:string)=>{const found=[...sources.values()].filter(row=>row.cell.source.observationId===id);
  if(found.length!==1)throw Error(`Observation ${id} not unique or not retained`);return found[0];};
 const a=selected(first),b=selected(second);
 if(a.cell.source.sessionId!==b.cell.source.sessionId)throw Error('Observations belong to different sessions');
 const accepted=new Map<string,{source:ObservationSource;id:string}>(),names=new Map<string,Name>();
 const fields=new Map<string,{id:string;source:ObservationSource;eventSequence:number;awakening:number|null;extraCopies:number|null;countReliable:boolean;review:readonly string[];identitySource:string|null;nameEvidence:unknown}>();
 for(const event of trace.events){if(event.type!=='inventory-event'||event.value.source.phase!=='input')continue;
  const fact=event.value,k=key(fact.source),row=sources.get(k);
  if(!row||!row.cell.fresh||!same(row.cell.source,fact.source))continue;
  if(fact.kind==='identity-accepted'){const old=accepted.get(k);if(old&&old.id!==fact.id)throw Error('Conflicting identity acceptance');accepted.set(k,{source:fact.source,id:fact.id});}
  else if(fact.kind==='name-confirmed'){const proof=accepted.get(k);if(proof&&proof.id===fact.id&&same(proof.source,fact.source))names.set(k,{source:fact.source,id:fact.id,eventSequence:event.seq});}
  else if(fact.kind==='observation-recorded') {const proof=names.get(k),card=fact.card;
   if(proof&&proof.id===card.id&&same(proof.source,fact.source))fields.set(k,{id:card.id,source:fact.source,eventSequence:event.seq,awakening:card.awakening,
    extraCopies:card.extraCopies,countReliable:card.countReliable===true,review:[...card.review],identitySource:card.identitySource??null,nameEvidence:card.nameEvidence??null});}
 }
 const groupNames=new Map<number,Map<string,Name>>();
 for(const {cell} of sources.values()){const name=names.get(key(cell.source));if(name){const values=groupNames.get(cell.group)??new Map<string,Name>();if(!values.has(name.id))values.set(name.id,name);groupNames.set(cell.group,values);}}
 function named(frame:Frame){const mapped=new Map<string,{slot:number;group:number;direct:boolean;nameProof:Name}[]>();
  for(const [slot,cell] of frame.cells.entries()){if(!cell)continue;const own=names.get(key(cell.source)),group=groupNames.get(cell.group);
   if(!group||group.size!==1)continue;const [id,groupProof]=[...group][0];if(own&&own.id!==id)continue;
   const values=mapped.get(id)??[];values.push({slot,group:cell.group,direct:!!own,nameProof:own??groupProof});mapped.set(id,values);}
  return mapped;}
 const left=named(a.frame),right=named(b.frame),delta=b.cell.source.slot-a.cell.source.slot;
 const seqStart=Math.min(a.frame.sequence,b.frame.sequence),seqEnd=Math.max(a.frame.sequence,b.frame.sequence);
 const resets=trace.events.filter(e=>e.type==='grid-command'&&e.seq>seqStart&&e.seq<seqEnd&&
  (e.value.method==='resetPositions'||e.value.method==='reset')).length;
 const witnesses:{id:string;firstSlot:number;secondSlot:number;delta:number;sameVisualGroup:boolean;bothDirect:boolean;firstNameProof:Name;secondNameProof:Name}[]=[];
 for(const [id,values] of left){const other=right.get(id);if(values.length!==1||other?.length!==1)continue;
  if(resets)continue;
  const x=values[0],y=other[0];if(x.slot===a.cell.source.slot||y.slot===b.cell.source.slot)continue;
  witnesses.push({id,firstSlot:x.slot,secondSlot:y.slot,delta:y.slot-x.slot,sameVisualGroup:x.group===y.group,bothDirect:x.direct&&y.direct,firstNameProof:x.nameProof,secondNameProof:y.nameProof});}
 const direct=(cell:Cell)=>names.get(key(cell.source))??null;
 const field=(cell:Cell)=>fields.get(key(cell.source))??null;
 return {status:'input-scope-only' as const,validation:{inputStatus:validation.inputStatus,status:validation.status,
   recoveryCoverage:validation.recoveryCoverage,inventoryMatch:validation.inventoryMatch,matchesCapturedState:validation.matchesCapturedState},
  targets:[{processingFrame:a.frame.number,group:a.cell.group,source:a.cell.source,directName:direct(a.cell),fields:field(a.cell)},
   {processingFrame:b.frame.number,group:b.cell.group,source:b.cell.source,directName:direct(b.cell),fields:field(b.cell)}],
  chronological:b.cell.source.captureOrder>a.cell.source.captureOrder,sameColumn:a.cell.source.slot%10===b.cell.source.slot%10,
  targetSlotDelta:delta,matchingWitnesses:witnesses.filter(w=>w.delta===delta),otherWitnesses:witnesses.filter(w=>w.delta!==delta),
  gridResetCommandsBetweenFrames:resets,sortFilterEpoch:'unknown' as const,associationProven:false as const,
  scope:'Context only: direct names are recorded source-bound facts, not proof of independent pixels; reused visual-group names are scheduling groups, not identity proof. No target association or latest-field proof is inferred.'};
}
