import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticReadOwner,diagnosticFieldCandidates,settleLateDiagnosticPreparation} from '../dev/crop-reread-core';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';
import {prepareOwnedRecognizerReader,rethrowAfterRecognizerInitFailure} from '../src/features/card-scanner/recognition/recognizer';
import {createScannerNameOperation} from '../src/features/card-scanner/session/scanner-name-operation';

const meta={stable:true,borderAlignment:1};
test('an unverified empty-looking counter stays null even on a stable frame',()=>{
 const value=diagnosticFieldCandidates(meta,5,{awakening:2,extraCopies:0});
 assert.equal(value.awakening,2);assert.equal(value.extraCopies,null);assert.equal(value.countReliability,'unconfirmed');
 assert.match(value.scope,/후보/);assert.match(value.scope,/비교하거나 보유 값을 확정하지 않음/);
});
test('scanner single-frame zero rules are exposed only as diagnostic candidates',()=>{
 const empty=diagnosticFieldCandidates(meta,5,{awakening:2,extraCopies:0,
  countDiagnostics:{maximum:12,reason:'빈 표시',readings:[],iconPresent:false}});
 assert.equal(empty.extraCopies,0);assert.equal(empty.countReliability,'empty-counter');
 const fixed=diagnosticFieldCandidates({stable:false,borderAlignment:0},5,{awakening:5,extraCopies:0});
 assert.equal(fixed.extraCopies,0);assert.equal(fixed.countReliability,'fixed-zero');
});
test('unknown and impossible field values are not manufactured into valid values',()=>{
 const unknown=diagnosticFieldCandidates(meta,5,{awakening:null,extraCopies:null});
 assert.equal(unknown.awakening,null);assert.equal(unknown.extraCopies,null);assert.equal(unknown.countReliability,'unconfirmed');
 const impossible=diagnosticFieldCandidates(meta,5,{awakening:4,extraCopies:10});
 assert.equal(impossible.awakening,4);assert.equal(impossible.extraCopies,null);assert.equal(impossible.countReliability,'unconfirmed');
 const invalidLevel=diagnosticFieldCandidates(meta,5,{awakening:6,extraCopies:3});
 assert.equal(invalidLevel.awakening,null);assert.equal(invalidLevel.extraCopies,3);assert.equal(invalidLevel.countReliability,'unconfirmed');
});
test('an uncorroborated positive remains an explicitly unconfirmed candidate',()=>{
 const candidate=diagnosticFieldCandidates(meta,5,{awakening:1,extraCopies:7});
 assert.equal(candidate.extraCopies,7);assert.equal(candidate.countReliability,'unconfirmed');
});
test('a timeout does not release the source canvas or admit a second read until the real operation settles',async()=>{
 const owner=createDiagnosticReadOwner(),budget=new CardReadBudget(15);let release!:()=>void;
 const owned=owner.run(()=>new Promise<void>(resolve=>{release=resolve;}));let cancelled=false;
 await assert.rejects(budget.wait(()=>owned,()=>{cancelled=true;}),CardReadTimeout);assert.equal(cancelled,true);
 let joined=false;const pending=owner.join().then(()=>{joined=true;});
 await Promise.resolve();assert.equal(joined,false);
 assert.throws(()=>owner.run(()=>42),/아직 종료되지/);
 release();await pending;assert.equal(joined,true);assert.equal(await owner.run(()=>42),42);
});
test('a rejected real operation is joined before the reader can be released',async()=>{
 const owner=createDiagnosticReadOwner(),owned=owner.run(()=>Promise.reject(Error('reader failed')));
 const joined=owner.join();await assert.rejects(owned,/reader failed/);await joined;
 assert.equal(await owner.run(()=>1),1);
});
test('normal initialization abort joins cleanup and releases the preparation gate',async()=>{
 const abort=new DOMException('cancelled','AbortError');let release!:()=>void,reported=false;
 const preparing=rethrowAfterRecognizerInitFailure(abort,()=>new Promise<void>(resolve=>{release=resolve;}),()=>{reported=true;});
 let joined=false;const late=settleLateDiagnosticPreparation(preparing,async()=>{throw Error('unexpected reader');},()=>reported).then(()=>{joined=true;});
 await Promise.resolve();assert.equal(joined,false);release();await late;assert.equal(joined,true);assert.equal(reported,false);
});
test('initialization cleanup failure retains the gate and preserves the cleanup error',async()=>{
 const primary=new DOMException('cancelled','AbortError'),cleanup=Error('dispose failed');let reported=false;
 const preparing=rethrowAfterRecognizerInitFailure(primary,async()=>{throw cleanup;},()=>{reported=true;throw Error('observer failed');});
 await assert.rejects(settleLateDiagnosticPreparation(preparing,async()=>{},()=>reported),error=>error===cleanup);
 assert.equal(reported,true);
});
test('late initialized reader is disposed before gate release and disposal failure stays visible',async()=>{
 let init!: (value:{})=>void,finish!:()=>void,disposed=false;
 const preparing=new Promise<{}>(resolve=>{init=resolve;});
 const late=settleLateDiagnosticPreparation(preparing,()=>new Promise<void>(resolve=>{finish=()=>{disposed=true;resolve();};}),()=>false);
 init({});await Promise.resolve();assert.equal(disposed,false);finish();await late;assert.equal(disposed,true);
 await assert.rejects(settleLateDiagnosticPreparation(Promise.resolve({}),async()=>{throw Error('dispose failed');},()=>false),/dispose failed/);
});
test('a throwing ready-status callback disposes the initialized reader and preserves the primary error',async()=>{
 const failure=Error('status callback failed');let disposed=0,reported=false;
 await assert.rejects(prepareOwnedRecognizerReader({ready:async()=>{},dispose:async()=>{disposed++;}},undefined,
  ()=>{throw failure;},()=>{reported=true;}),error=>error===failure);
 assert.equal(disposed,1);assert.equal(reported,false);
});
test('ready-status failure with disposal failure reports cleanup and keeps existing cleanup-error precedence',async()=>{
 const primary=Error('status callback failed'),cleanup=Error('dispose failed');let reported:unknown;
 await assert.rejects(prepareOwnedRecognizerReader({ready:async()=>{},dispose:async()=>{throw cleanup;}},undefined,
  ()=>{throw primary;},error=>{reported=error;}),error=>error===cleanup);
 assert.equal(reported,cleanup);
});
test('reported recognizer init cleanup uncertainty keeps the enclosing scanner operation gated',async()=>{
 const cleanup=Error('dispose failed');let unsafe=false,settled=0,uncertain=0;
 const operation=createScannerNameOperation({development:false,input:{},isCleanupUncertain:()=>unsafe,
  onSettled:()=>{settled++;},onCleanupUncertain:()=>{uncertain++;},
  run:()=>prepareOwnedRecognizerReader({ready:async()=>{throw Error('ready failed');},dispose:async()=>{throw cleanup;}},
   undefined,()=>{},()=>{unsafe=true;})});
 await assert.rejects(operation.run(new AbortController().signal),error=>error===cleanup);
 operation.settled();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(settled,0);assert.equal(uncertain,1);
});
