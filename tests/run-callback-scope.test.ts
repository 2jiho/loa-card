import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunCallbackScope} from '../dev/run-callback-scope';
import {guardScan,scanLimits} from '../src/features/card-scanner/scan-watchdog';
import type {ScannerState} from '../src/features/card-scanner/scanner';

test('watchdog return cannot let late traces corrupt the next run or its input consumer',async()=>{
 let current=1,values:string[]=[],lateTrace!:(value:string)=>void,oldOwnerCleanup=0;
 const scope=createRunCallbackScope(()=>current===1);
 const state={sampled:0,stable:0,queued:0,cards:[],workPhase:'reading'} as unknown as ScannerState;
 try{await assert.rejects(guardScan({signal:new AbortController().signal,sharing:()=>false,update:()=>{},cancelResources:()=>{oldOwnerCleanup++;},
  intervalMs:2,limits:{...scanLimits,stall:15},run:async(_signal,publish,ready)=>{
   lateTrace=scope.wrap(value=>values.push(value));ready();publish(state);lateTrace('old-input');await new Promise<void>(()=>{});
  }}),/진척/);}finally{scope.close();}
 assert.equal(oldOwnerCleanup,1);assert.deepEqual(values,['old-input']);
 current=2;values=[];const next=createRunCallbackScope(()=>current===2),trace=next.wrap(value=>values.push(value as string));
 lateTrace('late-old-frame');lateTrace('late-old-checkpoint');trace('next-input');assert.deepEqual(values,['next-input']);
 next.close();trace('late-next-frame');assert.deepEqual(values,['next-input']);
});
test('ownership changes suppress callbacks even before an explicit close',()=>{
 let current:object={},calls=0;const owner=current,scope=createRunCallbackScope(()=>current===owner),callback=scope.wrap(()=>{calls++;});
 callback();current={};callback();assert.equal(calls,1);scope.close();scope.close();callback();assert.equal(calls,1);
});
