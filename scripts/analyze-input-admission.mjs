import {createLiveInputAdmission,applyLiveInputAdmissionFact} from '../src/features/card-scanner/live-input-admission.ts';

/** Replay the actual admission policy; skipped callbacks contain no retained pixels. */
export function analyzeInputAdmission(trace) {
  const policy=createLiveInputAdmission(),reasons={},spacing=[];
  let seq=0,facts=0,considered=0,successful=0,failed=0;
  for(const event of trace.events){
    if(!Number.isSafeInteger(event.seq)||event.seq<=seq)throw Error('Expected ordered validated events');
    seq=event.seq;
    if(event.type!=='input-admission')continue;
    const before=policy.snapshot(),decision=applyLiveInputAdmissionFact(policy,event.value);
    facts++;
    if(decision){
      considered++;
      const reason=decision.kind==='freeze'?'freeze':decision.reason;
      reasons[reason]=(reasons[reason]??0)+1;
      if(reason==='cadence'&&before.lastOfferedAtMs!==null){
        const elapsed=decision.stamp.observedAtMs-before.lastOfferedAtMs;
        // Reversed clocks are not meaningful spacing samples.
        if(elapsed>=0)spacing.push(elapsed);
      }
    }
    if(event.value.kind==='frozen'){
      if(event.value.succeeded)successful++;else failed++;
    }
  }
  spacing.sort((a,b)=>a-b);
  return {status:!facts?'unmeasured':!trace.complete||trace.dropped||policy.snapshot().pending?'partial':'measured',
    considered: facts?considered:null,successfulFreezes:facts?successful:null,failedFreezes:facts?failed:null,reasons,
    cadenceSpacing:{samples:spacing.length,p50Ms:spacing.length?spacing[Math.ceil(spacing.length*.5)-1]:null,
      p95Ms:spacing.length?spacing[Math.ceil(spacing.length*.95)-1]:null,
      below25Ms:spacing.filter(v=>v<25).length,from25To33Ms:spacing.filter(v=>v>=25&&v<33).length,
      atLeast33Ms:spacing.filter(v=>v>=33).length},
    scope:'Admission facts replayed through the common policy. Spacing uses arrival time since the last successful freeze only; it does not identify skipped pixels, original media frames, or the cause of missing cards. Incompatible policy histories fail instead of silently changing recorded decisions.'};
}
