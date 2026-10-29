import {entryParts,fastCompress,packPixels,pixelHash} from '../../src/features/card-scanner/exact-recording-codec';
import type {ExactEntry,ExactEvent} from '../../src/features/card-scanner/exact-recording-codec';
import type {ExactRecording,ExactRecordingStats} from '../../src/features/card-scanner/exact-recording';
import {createLiveInputAdmission} from '../../src/features/card-scanner/live-input-admission';
import {createLiveCapturePipeline} from '../../src/features/card-scanner/live-capture-pipeline';
import {InputDecisionReplay} from '../../src/features/card-scanner/live-input-decision-replay';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData} from '../../src/features/card-scanner/inventory-evidence';
import type {InventorySource} from '../../src/features/card-scanner/inventory-evidence';
import {ScanGrid} from '../../src/features/card-scanner/scan-grid';
import {recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../../src/features/card-scanner/scan-grid-command';
import {UnknownLifecycle,hashUnknownLifecycle} from '../../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../../src/features/card-scanner/unknown-lifecycle-types';
import {FreshnessEvidence,hashFreshnessEvidence} from '../../src/features/card-scanner/freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS} from '../../src/features/card-scanner/freshness-evidence-types';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from '../../src/features/card-scanner/rgba-window-policy';
import type {ScannedCard} from '../../src/features/card-scanner/recognizer';

export interface CanonicalFixtureEntry {readonly header:ExactEntry;readonly payload?:Uint8Array<ArrayBuffer>}
/** Real production event reducers/pipeline/checkpoints; no serialized summary is
 * injected. The helper simulates finished producer/ACK stats, not Worker/OS live
 * ownership. Tests which exercise live ownership must supply that boundary. */
export async function createCanonicalFinalizationFixture(options:{extraFrameBytes?:number;codecPolicy?:typeof RGBA_WINDOW_POLICY}={}){
  const signal=AbortSignal.timeout(30_000),entries:CanonicalFixtureEntry[]=[],events:ExactEvent[]=[];
  const emit=(type:string,value:unknown)=>{
    const event:ExactEvent={kind:'event',seq:events.length+1,time:events.length/100,type,value:structuredClone(value)};
    events.push(event);entries.push({header:event});
  };
  const codecFields=options.codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY}:{};
  const pixels=new Uint8Array(4*4*4).fill(23),hash=await pixelHash(pixels),time=2;
  entries.push({header:{kind:'frame',id:1,time,width:4,height:4,key:true,codec:'lz4',xor:true,canonical:true,hash,...codecFields},
    payload:fastCompress(packPixels(pixels,undefined,true))});
  emit('canonical-raster-contract',{version:1});
  if(options.extraFrameBytes!==undefined){
    const bytes=options.extraFrameBytes;
    if(!Number.isSafeInteger(bytes)||bytes<4||bytes%4||bytes>64*1024*1024)throw Error('Invalid fixture extra-frame bytes');
    const extra=new Uint8Array(bytes);let random=0x193a81;
    for(let index=0;index<extra.length;index++){random^=random<<13;random^=random>>>17;random^=random<<5;extra[index]=random&255;}
    entries.push({header:{kind:'frame',id:2,time:2.1,width:bytes/4,height:1,key:true,codec:'lz4',xor:true,canonical:true,
      hash:await pixelHash(extra),...codecFields},payload:fastCompress(packPixels(extra,undefined,true))});
  }
  const sessionId='canonical-finalization-fixture',source:InventorySource={sessionId,frameId:1,observationId:'1',
    captureOrder:1,captureTime:time,phase:'input',slot:0,frame:'fixture-source'};
  const observationSource={sessionId,frameId:1,observationId:source.observationId,captureOrder:1,captureTime:time,phase:'input' as const,slot:0};
  const inventory=new InventoryEvidence([],{onEvent:event=>emit('inventory-event',inventoryEventData(event))});
  emit('inventory-seed',{version:1,cards:[]});
  const freshnessSeed={version:1 as const,sessionId,limits:FRESHNESS_EVIDENCE_LIMITS};emit('freshness-seed',freshnessSeed);
  const freshness=new FreshnessEvidence(freshnessSeed,{confirmedFields:()=>inventory.confirmedFieldOrder,onEvent:fact=>emit('freshness-event',fact)});
  const binding={key:'fixture-known',order:1,frame:source.frame,stable:true};
  freshness.apply({version:1,kind:'accepted',group:1,time,source:observationSource,binding,pixelKey:'fixture-pixels',fieldRevision:'revision1',requiresProof:true});
  freshness.apply({version:1,kind:'identity-linked',binding,source:observationSource,pixelKey:'fixture-pixels',id:'known',review:[]});
  const card:ScannedCard={id:'known',name:'검증 카드',awakening:0,extraCopies:0,countReliable:true,confidence:1,review:[],
    time,observations:1,image:'',captureOrder:1,capturePosition:{frame:source.frame,slot:0,stable:true,sort:null}};
  inventory.acceptIdentity(source,card.id);inventory.recordObservation(source,card,1);freshness.guard('final');
  const rawGrid=new ScanGrid(fact=>emit('observation-fact',fact)),grid=recordScanGrid(rawGrid,command=>emit('grid-command',command));
  grid.geometry(55);grid.begin(true);grid.viewport(1);grid.liveViewport(1);grid.group(0,1,1,true,undefined,observationSource);
  grid.record(1);const attempt=grid.start(1);grid.identify(1,'known');grid.finish(1,'read',attempt);
  const unknownSeed={version:1 as const,sessionId,origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};emit('unknown-seed',unknownSeed);
  const unknown=new UnknownLifecycle(unknownSeed,{onEvent:fact=>emit('unknown-event',fact)});
  unknown.apply({version:1,kind:'upsert',key:{kind:'group',sessionId,group:2},source:{...observationSource,observationId:'review',captureOrder:2,slot:1},
    captureOrder:2,captureTime:time,pending:false,reason:'확인 필요',location:null});
  const admission=createLiveInputAdmission(),inputReplay=new InputDecisionReplay(signal);
  const stamp=admission.stamp(time,0),gates={capturing:true,checkingCompletion:false};
  const decision=admission.consider(stamp,gates);
  if(decision.kind!=='freeze')throw Error('Fixture admission failed');
  const considered={kind:'consider' as const,stamp,gates,expected:'freeze' as const};inputReplay.admission(considered);emit('input-admission',considered);
  admission.frozen(stamp,{succeeded:true,freezeMs:0});const frozen={kind:'frozen' as const,stamp,succeeded:true,freezeMs:0};
  inputReplay.admission(frozen);emit('input-admission',frozen);
  const pipeline=createLiveCapturePipeline<number>({now:()=>0,yieldTask:()=>Promise.resolve(),
    onDecision:fact=>{inputReplay.pipeline(fact);emit('input-decision',fact);},
    onError:error=>{throw error;},onRecordError:error=>{throw error;},release:()=>{},
    consume:()=>{
      const link={inputId:stamp.inputId,frameId:1,captureTime:time,phase:'input' as const};inputReplay.link(link);emit('input-link',link);
      emit('canonical-source-use',{sourceFrameId:1,acquisitionFrameId:1,captureTime:time,phase:'input'});
      emit('canonical-raster-receipt',{version:1,kind:'measured',sourceFrameId:1,acquisitionFrameId:1,captureTime:time,width:4,height:4,hash});
      admission.completed(0,0);const completed={kind:'completed' as const,startedAtMs:0,endedAtMs:0};inputReplay.admission(completed);emit('input-admission',completed);
    }});
  pipeline.offer(1,time,stamp);await pipeline.flush();
  emit('input-checkpoint',{complete:true,hash:(await inputReplay.summary()).hash});
  emit('inventory-checkpoint',{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
  emit('grid-checkpoint',{complete:true,hash:await hashScanGridReplay(scanGridReplaySnapshot(rawGrid))});
  const unknownSnapshot=unknown.snapshot();emit('unknown-checkpoint',{version:1,complete:true,events:unknownSnapshot.facts,hash:await hashUnknownLifecycle(unknownSnapshot)});
  const freshnessSnapshot=freshness.snapshot();emit('freshness-checkpoint',{version:1,complete:true,events:freshnessSnapshot.facts,hash:await hashFreshnessEvidence(freshnessSnapshot)});
  const recordingFrom=(parts:readonly CanonicalFixtureEntry[]=entries,changes:Partial<ExactRecordingStats>={}):ExactRecording=>{
    const blob=new Blob(parts.flatMap(part=>entryParts(part.header,part.payload))),count=parts.filter(part=>part.header.kind==='event').length;
    const queueBytes=parts.filter(part=>part.header.kind==='event').reduce((sum,part)=>sum+JSON.stringify(part.header).length*2+64,0);
    const stats:ExactRecordingStats={canonical:true,complete:true,dropped:0,error:'',frames:parts.length-count,events:count,bytes:blob.size,
      peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,...codecFields,
      eventQueue:{version:1,acceptedEvents:count,postedBatches:1,acknowledgedBatches:1,pendingEvents:0,pendingBytes:0,
        peakPendingBytes:queueBytes,inFlightBatches:0,peakInFlightBatches:1,firstFailure:null},...changes};
    return {blob,stats,dispose:async()=>{}};
  };
  return {recording:recordingFrom(),entries,events,recordingFrom};
}
