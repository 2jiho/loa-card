import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {runRecoveryPipeline,nextRecoveryTask,recoveryVisualLanes} from '../dev/recognition-experiment/recovery-pipeline.ts';
import {patchRecovery} from '../dev/recognition-experiment/recovery-transform.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve};}

test('extra recovery image lanes are bounded and do not increase OCR reader count',()=>{
  assert.equal(recoveryVisualLanes(8,4),4);
  assert.equal(recoveryVisualLanes(12,4),6);
  assert.equal(recoveryVisualLanes(16,4),6);
  assert.equal(recoveryVisualLanes(64,4),6);
  assert.equal(recoveryVisualLanes(NaN,4),4);
});

test('idle OCR lanes help visuals without starving queued short retries',()=>{
  assert.equal(nextRecoveryTask(2,2,true,120,0),'visual');
  assert.equal(nextRecoveryTask(2,2,true,120,1),'short');
  assert.equal(nextRecoveryTask(0,2,true,120,1),'visual');
  assert.equal(nextRecoveryTask(0,2,true,0,1),'short');
  assert.equal(nextRecoveryTask(2,2,false,120,0),undefined);
  assert.equal(nextRecoveryTask(0,2,true,0,0),undefined);
});

test('surplus image lanes never take OCR retries, including when the image queue empties',()=>{
  assert.equal(nextRecoveryTask(4,2,true,1,30,true),'visual');
  assert.equal(nextRecoveryTask(4,2,true,0,30,true),undefined);
  assert.equal(nextRecoveryTask(4,2,false,1,30,true),undefined);
  assert.equal(nextRecoveryTask(2,2,true,1,30),'short');
});

test('recovery overlaps acquisition and reading without dropping frames or exceeding its crop bound', {timeout:3000}, async()=>{
  const queue:number[]=[],seen:number[]=[],started=gate(),second=gate();let max=0;
  await runRecoveryPipeline({signal:new AbortController().signal,highWater:2,
    frames:(async function*(){for(let i=0;i<20;i++)yield i;})(),
    collect:async i=>{if(i===1){await started.promise;second.resolve();}queue.push(i);max=Math.max(max,queue.length);},
    pending:()=>queue.length,lanes:[{hasWork:()=>queue.length>0,read:async()=>{
      const item=queue.shift()!;if(item===0){started.resolve();await second.promise;}seen.push(item);
    }}],
  });
  assert.deepEqual(seen,Array.from({length:20},(_,i)=>i));assert.ok(max<=2);
});

test('recovery joins in-flight readers and closes the source after reader failure', {timeout:3000}, async()=>{
  const entered=gate(),release=gate();let joined=false,closed=false;const failure=Error('reader failed');
  const job=runRecoveryPipeline({signal:new AbortController().signal,
    frames:(async function*(){try{while(true)yield 1;}finally{closed=true;}})(),
    collect:async()=>{await entered.promise;release.resolve();},pending:()=>0,
    lanes:[{hasWork:()=>true,read:async()=>{await entered.promise;throw failure;}},
      {hasWork:()=>true,read:async()=>{entered.resolve();await release.promise;joined=true;}}],
  });
  await assert.rejects(job,e=>e===failure);assert.equal(joined,true);assert.equal(closed,true);
});

test('recovery cancellation releases a producer waiting for capacity', {timeout:3000}, async()=>{
  const controller=new AbortController();let closed=false;
  const job=runRecoveryPipeline({signal:controller.signal,highWater:1,pending:()=>1,
    frames:(async function*(){try{yield 1;}finally{closed=true;}})(),collect:async()=>assert.fail('must not collect'),
    lanes:[{hasWork:()=>false,read:async()=>{}}],
  });controller.abort();await assert.rejects(job,{name:'AbortError'});assert.equal(closed,true);
});

test('idle readers wake on end of input even when no crops are produced', {timeout:1000}, async()=>{
  let frames=0;
  await runRecoveryPipeline({signal:new AbortController().signal,
    frames:(async function*(){yield 1;yield 2;})(),collect:async()=>{frames++;},pending:()=>0,
    lanes:Array.from({length:4},()=>({hasWork:()=>false,read:async()=>assert.fail('no work')})),
  });
  assert.equal(frames,2);
});

test('recovery transform keeps an explicit baseline and fails closed on source drift', async()=>{
  const source=readFileSync(new URL('../src/features/card-scanner/scanner.ts',import.meta.url),'utf8');
  const patched=patchRecovery(source);
  assert.match(patched,/debug.recoveryPipeline !== false/);
  assert.equal((patched.match(/await runRecoveryPipeline/g)??[]).length,1);
  assert.throws(()=>patchRecovery(source.replace('acquisition && !recovering ?', 'changed')),/stale/);
  const result=ts.transpileModule(patched,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext},reportDiagnostics:true});
  assert.equal(result.diagnostics?.length,0);
});
