import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScanLedger} from '../src/features/card-scanner/session/scan-ledger';
import {UnknownLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UnknownScanSession} from '../src/features/card-scanner/session/unknown-scan-session';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownUpsert} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import {canStopSharing,type CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';

// Characterization of an unsafe v1 boundary, not a desired completion rule.
// These inputs are synthetic facts, not authenticated pixels, OCR or a real scan.
const key={kind:'group' as const,sessionId:'s',group:7};
const source=(id:string,order:number):ObservationSource=>({sessionId:'s',frameId:order,observationId:id,
  captureOrder:order,captureTime:order,phase:'input',slot:0});
const warning=(value:ObservationSource):UnknownUpsert=>({version:1,kind:'upsert',key,source:value,
  captureOrder:value.captureOrder,captureTime:value.captureTime,pending:false,reason:'이름 판독 실패',location:null});
const sidecar={pixelKey:'diagnostic-only',preview:()=>'',recognition:()=>''};
const trace=(order:number)=>({frame:order,time:order,slot:0,box:{x:0,y:0,width:140,height:210},phase:'input' as const});
function completion(unresolved:number,order:number):CaptureCompletion {
  return {expected:1,finalExpected:1,unresolved,dropped:0,
    cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:order,observations:1}],
    latest:new Map([['a',order]]),confirmedNames:new Map([['a',order]]),confirmed:new Map([['a',order]]),
    inputSettled:true,headerAvailable:true,fieldChangesSettled:true};
}
function policies(){return {
  v1:new UnknownLifecycle({version:1,sessionId:'s',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS}),
  v2:new UnknownScanSession({sessionId:'s'}),ledger:new ScanLedger(),
};}

test('known v1 risk: a later success for a fuzzy group retires a different earlier failed source',()=>{
  const {v1,v2,ledger}=policies(),failed=source('failed',1),read=source('read',2);
  const bad=ledger.acquire(trace(1)),good=ledger.acquire(trace(2));
  ledger.finish(bad,'unidentified',{group:7});v1.apply(warning(failed));v2.report(warning(failed),sidecar);
  ledger.finish(good,'identified',{group:7,cardId:'a'});v1.confirmName(key,'a',read,[]);v2.confirmName(key,'a',read,[]);
  const v1Unresolved=Math.max(ledger.unresolvedGroups,v1.active().length);
  const v2Unresolved=Math.max(ledger.unresolvedGroups,v2.unresolved());
  assert.equal(v1Unresolved,0,'v1 loses the distinct failure through its fuzzy group');
  assert.equal(canStopSharing(completion(v1Unresolved,2)),true,'other synthetic completion gates alone do not rescue this case');
  assert.equal(v2Unresolved,1);assert.equal(canStopSharing(completion(v2Unresolved,2)),false);
  v2.confirmName(key,'a',failed,[]);
  assert.equal(v2.unresolved(),0,'an exact-source success can resolve that source in the experimental policy');
});

test('known v1 risk: a later unreported failure in an already identified fuzzy group is invisible to the ledger',()=>{
  const {v1,v2,ledger}=policies(),read=source('read',1),failed=source('failed',2);
  const good=ledger.acquire(trace(1)),bad=ledger.acquire(trace(2));
  ledger.finish(good,'identified',{group:7,cardId:'a'});v1.confirmName(key,'a',read,[]);v2.confirmName(key,'a',read,[]);
  ledger.finish(bad,'unidentified',{group:7});
  // In scanner.ts a queued, unstable image without awakening and with fewer
  // than 35 label pixels is not reported to v1; v2 reports every failure.
  v2.report(warning(failed),sidecar);
  const v1Unresolved=Math.max(ledger.unresolvedGroups,v1.active().length);
  const v2Unresolved=Math.max(ledger.unresolvedGroups,v2.unresolved());
  assert.equal(v1Unresolved,0);assert.equal(canStopSharing(completion(v1Unresolved,1)),true);
  assert.equal(v2Unresolved,1);assert.equal(canStopSharing(completion(v2Unresolved,1)),false);
  // If v1 had received this newer warning it would hold, demonstrating that
  // this case depends on the scanner's separate conditional report path.
  v1.apply(warning(failed));assert.equal(v1.active().length,1);
});
