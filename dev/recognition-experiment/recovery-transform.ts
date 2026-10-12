/** Local-only patch with a per-run baseline switch for same-input comparisons. */
export function patchRecovery(source:string) {
  const replace=(from:string,to:string)=>{
    if(!source.includes(from))throw Error('Recovery experiment patch is stale: '+from);
    source=source.replace(from,to);
  };
  replace('debug: { nativeAcquisition?: boolean;', 'debug: { recoveryVisualWorkers?: number; recoveryWorkSharing?: boolean; recoveryPipeline?: boolean; nativeAcquisition?: boolean;');
  replace('acquisition && !recovering ?',
    'acquisition && (!recovering || debug.recoveryPipeline !== false) ?');
  const start=source.indexOf('        for await (const input of recovery) {');
  const end=source.indexOf('        state.recoveryPercent = 100;',start);
  if(start<0||end<0)throw Error('Recovery loop not found');
  const original=source.slice(start,end);
  const drainStart=original.indexOf('          // Reuse independent live readers');
  const drainEnd=original.indexOf('          state.recoveryFrames++;');
  if(drainStart<0||drainEnd<0)throw Error('Recovery consumer block not found');
  const body=original.slice(original.indexOf('{')+1,drainStart)+original.slice(drainEnd,original.lastIndexOf('}'));
  source=source.slice(0,start)+`
        if(debug.recoveryPipeline !== false && debug.parallelRecovery !== false && recognizer && visuals.length) {
          // Capture has ended: idle OCR lanes help visuals while short retries
          // retain priority. Extra image lanes do not create OCR model sessions.
          if(debug.recoveryWorkSharing !== false && navigator.hardwareConcurrency>=8) {
            const existing=visuals.length;
            try {
              const desired=debug.recoveryVisualWorkers??recoveryVisualLanes(navigator.hardwareConcurrency,1+extraRecognizers.length);
              while(visuals.length<Math.min(8,desired)) {
                const worker=createVisualClient(signal);
                if(!worker)break;
                visuals.push(worker);
              }
              await Promise.all(visuals.slice(existing).map(worker=>worker?.ready()));
            } catch {
              for(const worker of visuals.splice(existing))worker?.dispose();
              signal.throwIfAborted();
            }
          }
          await runRecoveryPipeline({frames:recovery,signal,pending:()=>queue.length,
            collect:async input=>{${body}},
            lanes:Array.from({length:Math.max(1+extraRecognizers.length,visuals.length)},(_,index)=>{
              const reader=[recognizer,...extraRecognizers][index]??recognizer;
              const visual=visuals[index];
              if(debug.recoveryWorkSharing===false) {
                const fast=index<lanePlan.fast;
                return {hasWork:()=>!!(fast?queue.length:deferred.length),read:()=>drainOne(!fast,reader,fast,!fast,visual)};
              }
              // Surplus visual lanes never enter OCR: each OCR session retains
              // its sole owner while lightweight image matching can scale out.
              const visualOnly=index>=1+extraRecognizers.length;
              const next=()=>nextRecoveryTask(index,lanePlan.fast,!!visual,queue.length,deferred.length,visualOnly);
              return {hasWork:()=>next()!==undefined,
                read:()=>{const task=next();if(!task)return Promise.resolve();const fast=task==='visual';
                  return drainOne(!fast,reader,fast,!fast,visual);}};
            }),
          });
        } else {
${original}
        }
`+source.slice(end);
  return "import {runRecoveryPipeline,nextRecoveryTask,recoveryVisualLanes} from '/dev/recognition-experiment/recovery-pipeline';\n"+source;
}
