import {exactEntries} from '../reproduction/exact-recording-codec';
import {parseLiveInputAdmissionFact} from '../capture/live-input-admission';
import {parseLiveCaptureDecision} from '../capture/live-capture-pipeline';
import {parseInputFrameLink,parseInputRecoveryFact} from '../reproduction/live-input-decision-replay';
import {parseInputArrival,parseInputBackupReservation} from '../capture/input-arrival';
import {yieldForCapture} from '../capture/input-source';

/** Separate the recorded selection stream from a claim about delivered pixels.
 * This pass retains only counters; it neither reconstructs the scanner nor
 * treats a backup reservation or compressed video as a source-bound input. */
export async function auditDeliveredInputs(blob:Blob,signal:AbortSignal,acquisitionPixelCoverage:'partial'|'unknown'|undefined){
 const skipped={ended:0,verification:0,'source-capacity':0,cadence:0};
 const released={replaced:0,capacity:0,error:0,disposed:0,rejected:0};
 let arrivals=0,considered=0,frozen=0,freezeFailed=0,replacements=0,links=0,reservations=0,reserved=0;
 let compared=0,recoveryLost=0,malformed=0,recorderErrors=0,arrivalIdGaps=0,lastArrivalId=0,consideredWithoutRecordedDecision=0,entries=0;
 const inc=(value:number,by=1)=>Math.min(Number.MAX_SAFE_INTEGER,value+by);
 for await(const {header} of exactEntries(blob,signal)){
  if(++entries%256===0)await yieldForCapture(signal);
  if(header.kind!=='event')continue;
  try{
   if(header.type==='input-arrival'){
    const event=parseInputArrival(header.value);arrivals=inc(arrivals);
    if(event.inputId<=lastArrivalId)malformed=inc(malformed);
    else if(event.inputId>lastArrivalId+1)arrivalIdGaps=inc(arrivalIdGaps,event.inputId-lastArrivalId-1);
    lastArrivalId=Math.max(lastArrivalId,event.inputId);
   }else if(header.type==='input-admission'){
    const fact=parseLiveInputAdmissionFact(header.value);
    if(fact.kind==='consider'){
     considered=inc(considered);
     if(fact.expected&&fact.expected!=='freeze')skipped[fact.expected]=inc(skipped[fact.expected]);
     else if(fact.expected===undefined)consideredWithoutRecordedDecision=inc(consideredWithoutRecordedDecision);
    }else if(fact.kind==='frozen'){
     if(fact.succeeded)frozen=inc(frozen);else freezeFailed=inc(freezeFailed);
    }
   }else if(header.type==='input-decision'){
    const decision=parseLiveCaptureDecision(header.value);
    if(decision.kind==='replaced')replacements=inc(replacements);
    if(decision.kind==='released'&&decision.reason!=='normal')released[decision.reason]=inc(released[decision.reason]);
   }else if(header.type==='input-link'){parseInputFrameLink(header.value);links=inc(links);}
   else if(header.type==='input-backup-reservation'){
    const reservation=parseInputBackupReservation(header.value);reservations=inc(reservations);
    if(reservation.reservationId!==null)reserved=inc(reserved);
   }else if(header.type==='input-recovery'){
    const fact=parseInputRecoveryFact(header.value);
    if(fact.kind==='released'&&fact.reason==='compared')compared=inc(compared);
    if(fact.kind==='lost')recoveryLost=inc(recoveryLost);
   }else if(header.type==='input-recording-error')recorderErrors=inc(recorderErrors);
  }catch{malformed=inc(malformed);}
 }
 // Only the versioned acquisition contract can currently identify a started
 // attempt for which the link is explicitly absent. Other selection/recovery
 // facts indicate a replay gap risk but are not proof about alternate storage.
 const status=acquisitionPixelCoverage==='partial'?'partial':arrivals||considered?'unproven':'unknown';
 return {status,scope:'recorded-admission-arrivals' as const,sourceDeliveryCompleteness:'unproven' as const,
  sourcePixelsAuthenticated:false as const,callbackPixelBinding:'unproven' as const,
  recorded:{arrivals,arrivalIdGaps,considered,skipped,consideredWithoutRecordedDecision,frozen,freezeFailed,replacements,released,links,
   backupReservations:reservations,nonNullBackupReservations:reserved,recoveryComparedWithoutReplayLink:compared,recoveryLost,malformed,recorderErrors},
  evidence:'Recorded choices and reservations do not by themselves bind every delivered input to replay pixels.'};
}
