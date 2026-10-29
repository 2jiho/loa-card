import {resolveScannerNameConfiguration,assertScannerNameInputConfiguration} from './scanner-name-configuration';
import type {ScannerNameConfiguration,ScannerNameInputConfigurationFlags} from './scanner-name-configuration';
import {claimPreparedScanner,cancelPreparedScanner,disposePreparedScanner,
  cancelUnclaimedPreparedScanner,disposeUnclaimedPreparedScanner} from './scanner-preparation';
import type {PreparedScanner} from './scanner-preparation';

export interface ScannerNameOperationOptions {
  prepared?:PreparedScanner;
  configuration?:unknown;
  legacyDevPolicy?:unknown;
  development:boolean;
  input:ScannerNameInputConfigurationFlags;
  run:(signal:AbortSignal,configuration:ScannerNameConfiguration,prepared?:PreparedScanner)=>Promise<void>;
  onSettled?:()=>void;
  diagnostic?:(error:unknown)=>void;
}

/** One actual operation and its owned preparation cleanup. A watchdog may return
 * before this operation joins; settlement notification waits for that join and
 * does not assert OS/native resource reclamation. Unclaimed-only helpers ensure
 * a rejected competing caller never tears down another scan's transferred pool. */
export function createScannerNameOperation(options:ScannerNameOperationOptions) {
  const {prepared,configuration,legacyDevPolicy,development,input,run,onSettled,diagnostic}=options;
  let invoked=false,cancelled=false,settlementRequested=false,notified=false;
  let transferred:PreparedScanner|undefined,cleanup:Promise<void>|undefined,completion:Promise<void>|undefined;
  let complete:()=>void=()=>{};
  const report=(error:unknown)=>{
    try{void Promise.resolve(diagnostic?.(error)).catch(()=>{});}catch{/* Optional diagnostics have no lifecycle authority. */}
  };
  const release=()=>{
    if(cleanup)return cleanup;
    // Capture a rejection even when pre-abort cancellation starts cleanup before
    // run() exists. Keep the original promise so run() still sees cleanup errors.
    try{cleanup=Promise.resolve(transferred?disposePreparedScanner(transferred):disposeUnclaimedPreparedScanner(prepared));}
    catch(error){cleanup=Promise.reject(error);}
    void cleanup.catch(report);
    return cleanup;
  };
  const notify=()=>{
    if(notified)return;notified=true;
    try{void Promise.resolve(onSettled?.()).catch(()=>{});}catch{/* Observers cannot change the operation result. */}
  };
  return {
    async run(signal:AbortSignal):Promise<void>{
      if(invoked||settlementRequested)throw Error('이름 판독 작업은 한 번만 실행할 수 있습니다.');
      invoked=true;completion=new Promise<void>(resolve=>{complete=resolve;});
      let failure:{error:unknown}|undefined;
      try{
        signal.throwIfAborted();
        if(cancelled)throw new DOMException('스캔 중지','AbortError');
        const effective=resolveScannerNameConfiguration(configuration,legacyDevPolicy,development);
        assertScannerNameInputConfiguration(effective,input);
        signal.throwIfAborted();
        if(cancelled)throw new DOMException('스캔 중지','AbortError');
        transferred=prepared===undefined?undefined:claimPreparedScanner(prepared,effective);
        await run(signal,effective,transferred);
      }catch(error){failure={error};}
      finally{
        try{await release();}
        catch(error){failure??={error};}
        finally{complete();}
      }
      if(failure)throw failure.error;
    },
    cancel():void{
      cancelled=true;
      if(transferred){
        // Active native readers remain owned by the actual operation until its
        // promise settles. Cancellation is not permission to free them early.
        try{cancelPreparedScanner(transferred);}catch(error){report(error);}
      }else{
        try{cancelUnclaimedPreparedScanner(prepared);}catch(error){report(error);}
        void release();
      }
    },
    settled():void{
      if(settlementRequested)return;settlementRequested=true;
      // The absent-operation path covers guardScan's already-aborted signal.
      // An early/manual settlement request during a run still joins completion.
      const joined=invoked?completion!:release();
      void joined.catch(()=>{}).then(notify);
    },
  };
}
