import test from 'node:test';import assert from 'node:assert/strict';
import {createScannerNameOperation} from '../src/features/card-scanner/session/scanner-name-operation';
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
test('independent unsafe cleanup signal keeps gate closed even when operation failure had priority',async()=>{
 let unsafe=false,settled=0,uncertain=0;const primary=Error('primary');
 const operation=createScannerNameOperation({development:false,input:{},run:async()=>{unsafe=true;throw primary;},
  isCleanupUncertain:()=>unsafe,onSettled:()=>{settled++;},onCleanupUncertain:()=>{uncertain++;}});
 await assert.rejects(operation.run(new AbortController().signal),e=>e===primary);operation.settled();await tick();
 assert.equal(settled,0);assert.equal(uncertain,1);
});
test('operation error with independently confirmed disposal still releases gate',async()=>{
 let settled=0,uncertain=0;const operation=createScannerNameOperation({development:false,input:{},run:async()=>{throw Error('primary');},
  isCleanupUncertain:()=>false,onSettled:()=>{settled++;},onCleanupUncertain:()=>{uncertain++;}});
 await assert.rejects(operation.run(new AbortController().signal),/primary/);operation.settled();await tick();assert.equal(settled,1);assert.equal(uncertain,0);
});
