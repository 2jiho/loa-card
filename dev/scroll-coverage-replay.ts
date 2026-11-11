import {ScrollCoverage} from '../src/features/card-scanner/session/scroll-coverage';
import type {RunStateTraceSnapshot} from './run-state-trace';

/** Recompute only the recorded scroll-hint state. This is not a UI receipt,
 * a proof of input completeness, or evidence that any card was absent. */
export function summarizeScrollCoverage(trace:RunStateTraceSnapshot) {
 const unknown=(reason:string)=>({status:'unknown' as const,reason,inputCoverage:'unknown' as const,uiReceipt:'unknown' as const,identityEvidence:false as const});
 if(!trace.complete||trace.dropped!==0)return unknown('partial-trace');
 const facts=trace.events.filter(event=>event.type==='scroll-coverage');
 if(!facts.length||facts[0].value.kind!=='seed'||facts[0].value.ordinal!==1)return unknown('missing-seed');
 const session=facts[0].value.sessionId,coverage=new ScrollCoverage();let ordinal=0,offers=0,resets=0,previousFrame=0,previousSeq=0,checkpoint=false;
 for(const event of facts){
  const value=event.value;
  if(event.seq<=previousSeq||value.ordinal!==++ordinal||value.sessionId!==session)return unknown('event-order-or-session');
  previousSeq=event.seq;
  if(checkpoint)return unknown('event-after-checkpoint');
  if(value.kind==='seed'){if(ordinal!==1)return unknown('duplicate-seed');continue;}
  if(value.kind==='checkpoint'){checkpoint=true;continue;}
  if(value.kind==='reset'){coverage.reset();resets++;continue;}
  if(value.kind!=='offer')return unknown('invalid-kind');
  if(value.processingFrame<=previousFrame)return unknown('frame-order');
  previousFrame=value.processingFrame;
  if(value.gapsTruncated)return unknown('gap-limit');
  coverage.offer(value.position,value.pageSpan,[...value.slots].map(slot=>slot==='1'));
  if(JSON.stringify(coverage.gaps())!==JSON.stringify(value.gaps))return unknown('state-mismatch');
  offers++;
 }
 if(!checkpoint)return unknown('missing-checkpoint');
 if(!offers)return unknown('missing-offers');
 return {status:'matched-hint-state' as const,scope:'recorded-coverage-hint-only' as const,inputCoverage:'unknown' as const,
  uiReceipt:'unknown' as const,identityEvidence:false as const,sessionId:session,offers,resets,gaps:coverage.gaps()};
}
