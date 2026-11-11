import {FrameNameEvidence,hashFrameNameEvidence,type FrameNameCell} from './frame-name-evidence';
import {parseAcquisitionCapture,type AcquisitionCapture} from '../capture/capture-provenance';
import {parseInventoryEvent} from '../session/inventory-evidence';
import {parseScanGridCommand} from '../session/scan-grid-command';
import {InventoryEvidenceReplay} from '../reproduction/inventory-evidence-replay';

// The inventory reducer tracks the latest accepted order per card, but does
// not claim that every name-confirmed event has the same source as a preceding
// identity acceptance. This separate analysis must prove that association.
const SOURCE_LIMIT=20_000;
const sourceKey=(source:{sessionId:string;observationId:string})=>JSON.stringify([source.sessionId,source.observationId]);
const sameSource=(a:{sessionId:string;frameId:number;observationId:string;captureOrder:number;captureTime:number;phase:string;slot:number},
  b:{sessionId:string;frameId:number;observationId:string;captureOrder:number;captureTime:number;phase:string;slot:number})=>
  a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&a.captureOrder===b.captureOrder&&
  a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot;

/** Offline only. Joins existing acquisition receipts, recorded grid commands and
 * inventory events; it never alters a scanner or certifies a card match. */
export async function analyzeFrameNames(trace:{version:1|2;complete:boolean;dropped:number;events:readonly {seq:number;type:string;value:unknown}[]}) {
  if(!trace||typeof trace.complete!=='boolean'||!Number.isSafeInteger(trace.dropped)||trace.dropped<0||!Array.isArray(trace.events))
    throw Error('Invalid frame diagnostic trace');
  // Only version 2 carries independent last-sequence and event totals. The
  // caller must first validate the compressed envelope with the trace reader.
  let reducer:FrameNameEvidence|undefined,lastSeq=0,open=false,hasReceipts=false,partial=trace.version!==2||!trace.complete||trace.dropped>0;
  const inventory=new InventoryEvidenceReplay(new AbortController().signal);
  let frames=0,unjoined=0,unrecordedNames=0,recoveryReceipts=0,recoveryEvents=0,groupConflicts=0;
  const admissions=new Map<string,{source:import('../session/observation-execution').ObservationSource;fresh:boolean}>();
  const identities=new Map<string,{source:import('../session/inventory-evidence').InventorySource;id:string;conflict:boolean}>();
  const groupColumns=new Map<number,number>();
  const retain=<K,T>(map:Map<K,T>,key:K,value:T)=>{
    map.set(key,value);
    if(map.size>SOURCE_LIMIT){map.delete(map.keys().next().value!);partial=true;}
  };
  let receipts=new Map<number,AcquisitionCapture>(),cells:(FrameNameCell|null)[]=Array(40).fill(null),groups=new Set<number>(),frameGroups=new Set<number>();
  for(const event of trace.events) {
    if(!event||!Number.isSafeInteger(event.seq)||event.seq<=lastSeq)throw Error('Frame diagnostic event order');
    if(event.seq!==lastSeq+1)partial=true;
    lastSeq=event.seq;
    if(event.type==='capture-recording-error'){partial=true;continue;}
    if(event.type==='acquisition-capture'){
      const r=parseAcquisitionCapture(event.value);
      // The grid commands below only record live input. Recovery receipts do
      // not have this association, and ignoring them cannot mean complete.
      if(r.phase==='recovery'){recoveryReceipts++;continue;}
      hasReceipts=true;
      if(!open){partial=true;continue;}
      if(receipts.has(r.slot))throw Error('Duplicate acquisition slot');
      if(!reducer)reducer=new FrameNameEvidence(r.sessionId);
      if(r.sessionId!==reducer.sessionId)throw Error('Acquisition session mismatch');
      receipts.set(r.slot,r);continue;
    }
    if(event.type==='inventory-seed'){inventory.seed(event.value);continue;}
    if(event.type==='inventory-preview-confirmation'){inventory.previewConfirmation(event.value);continue;}
    if(event.type==='inventory-checkpoint'){inventory.checkpoint(event.value);continue;}
    if(event.type==='inventory-event'){
      const fact=parseInventoryEvent(event.value);inventory.accept(fact);
      if(fact.source.phase==='recovery'){recoveryEvents++;continue;}
      if(fact.kind==='identity-accepted'&&fact.source.phase==='input'){
        const key=sourceKey(fact.source),old=identities.get(key);
        if(old&&!sameSource(old.source,fact.source))throw Error('Identity source mismatch');
        retain(identities,key,{source:fact.source,id:fact.id,conflict:!!old&&(old.conflict||old.id!==fact.id)});
        continue;
      }
      if(fact.kind!=='name-confirmed'||fact.source.phase!=='input')continue;
      const key=sourceKey(fact.source),identity=identities.get(key),admission=admissions.get(key);
      if(identity&&!sameSource(identity.source,fact.source)||admission&&!sameSource(admission.source,fact.source))
        throw Error('Name source mismatch');
      if(!identity||identity.conflict||identity.id!==fact.id||identity.source.frame!==fact.source.frame||!admission||!admission.fresh){
        unrecordedNames++;partial=true;continue;
      }
      if(!reducer){unrecordedNames++;partial=true;continue;}
      reducer.inventory(fact);continue;
    }
    if(event.type!=='grid-command')continue;
    const cmd=parseScanGridCommand(event.value);
    if(cmd.method==='begin'){
      if(open&&(receipts.size||cells.some(Boolean)))partial=true;
      open=cmd.args[0];receipts=new Map();cells=Array(40).fill(null);groups=new Set();frameGroups=new Set();continue;
    }
    if(cmd.method==='group'){
      if(!open){partial=true;continue;}
      const [slot,group,traceId,fresh,,source]=cmd.args;
      if(groups.has(slot))throw Error('Duplicate grid group slot');groups.add(slot);
      // Groups are assigned by same-column visual buckets. A duplicate within
      // one frame or a group appearing in another column is not independent
      // evidence, even though all the source receipts may be individually valid.
      if(frameGroups.has(group)||groupColumns.has(group)&&groupColumns.get(group)!==slot%10){groupConflicts++;partial=true;}
      frameGroups.add(group);
      if(!groupColumns.has(group))retain(groupColumns,group,slot%10);
      if(!source){unjoined++;partial=true;continue;}
      if(source.slot!==slot||source.observationId!==String(traceId))throw Error('Grid trace and source mismatch');
      const receipt=receipts.get(slot);
      if(!receipt){unjoined++;partial=true;continue;}
      if(!receipt.quality.usable||receipt.sessionId!==source.sessionId||receipt.observationId!==source.observationId||
        receipt.acquisitionFrameId!==source.frameId||receipt.captureTime!==source.captureTime||receipt.phase!==source.phase||receipt.slot!==source.slot)
        throw Error('Grid group and acquisition receipt mismatch');
      const key=sourceKey(source);
      if(admissions.has(key))throw Error('Duplicate source admission');
      retain(admissions,key,{source,fresh});
      cells[slot]={group,source};continue;
    }
    if(cmd.method==='record'){
      if(!open){partial=true;continue;}
      const processingFrame=cmd.args[0],all=[...receipts.values()];
      if(all.some(r=>r.processingFrame!==processingFrame))throw Error('Processing frame mismatch');
      const sourceFrames=new Set(all.map(r=>r.acquisitionFrameId));
      if(sourceFrames.size>1)throw Error('Multiple source frames in one processing frame');
      if(all.length!==40){partial=true;unjoined+=Math.max(0,40-all.length);}
      if(reducer&&sourceFrames.size===1){reducer.capture({version:1,kind:'frame',sessionId:reducer.sessionId,
        processingFrame,frameId:[...sourceFrames][0],cells});frames++;}
      else if(cells.some(Boolean))partial=true;
      open=false;receipts=new Map();cells=Array(40).fill(null);groups=new Set();frameGroups=new Set();
    }
  }
  if(open&&(receipts.size||cells.some(Boolean)))partial=true;
  if(!hasReceipts)return {status:'unsupported' as const,inputStatus:'unsupported' as const,reason:'input acquisition receipts absent',frames:0,unjoined,unrecordedNames,
    recoveryReceipts,recoveryEvents,recoveryCoverage:recoveryReceipts||recoveryEvents?'not-analyzed' as const:'not-present' as const,projectionHash:null};
  const inventoryResult=await inventory.summary();
  if(inventoryResult.matchesCapturedState!==true)partial=true;
  const snapshot=reducer?.snapshot();
  // A name without its source frame is unresolved diagnostic input, never a
  // matched frame even if the underlying reducer itself stayed within bounds.
  const conflicts=snapshot?.frames.reduce((sum,frame)=>sum+frame.cells.filter(cell=>cell?.conflict).length,0)??0;
  if(snapshot&&(!snapshot.complete||snapshot.pending.length>0||conflicts>0))partial=true;
  // This is a repeatable analysis digest only. There is no captured checkpoint
  // for this optional channel and no claim of live/replay equivalence.
  const recoverySkipped=recoveryReceipts>0||recoveryEvents>0;
  return {status:partial||recoverySkipped?'partial' as const:'complete' as const,
    inputStatus:partial?'partial' as const:'complete' as const,
    reason:partial?'missing, incomplete or evicted input facts':recoverySkipped?'recovery facts are not analyzed':null,
    frames,unjoined,unrecordedNames,groupConflicts,recoveryReceipts,recoveryEvents,
    recoveryCoverage:recoveryReceipts||recoveryEvents?'not-analyzed' as const:'not-present' as const,
    pendingNames:snapshot?.pending.length??0,conflicts,inventoryMatch:inventoryResult.matchesCapturedState,
    projectionHash:snapshot?await hashFrameNameEvidence(snapshot):null,
    matchesCapturedState:null,epoch:'unknown' as const};
}
