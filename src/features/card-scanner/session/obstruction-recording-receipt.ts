import type {ExactEventQueueStats} from '../reproduction/exact-recording';

/** Synchronous admission is only a queue receipt, never durable storage. A
 * completed exact file and replayed checkpoint are still required later. */
export function obstructionEventAdmitted(input:{attempted:boolean;exactRequested:boolean;traceRequested:boolean;
  before?:ExactEventQueueStats;after?:ExactEventQueueStats;traceAck?:boolean}):boolean {
 if(!input.attempted||!input.exactRequested&&!input.traceRequested)return false;
 if(input.traceRequested&&input.traceAck!==true)return false;
 if(input.exactRequested){
  const {before,after}=input;
  if(!before||!after||before.firstFailure!==null||after.firstFailure!==null||
    !Number.isSafeInteger(before.acceptedEvents)||after.acceptedEvents!==before.acceptedEvents+1)return false;
 }
 return true;
}
