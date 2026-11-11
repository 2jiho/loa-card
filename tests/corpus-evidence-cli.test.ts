import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runCorpusCli} from '../scripts/scan-corpus.mjs';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData} from '../src/features/card-scanner/session/inventory-evidence';
import {RunStateTrace} from '../dev/run-state-trace';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../src/features/card-scanner/session/scan-grid-command';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import {FreshnessEvidence,hashFreshnessEvidence,FRESHNESS_EVIDENCE_LIMITS} from '../src/features/card-scanner/session/freshness-evidence';

const execFileAsync=promisify(execFile);

async function unknownStateReport(withCheckpoint=true){
  const trace=new RunStateTrace();let clock=0;
  const grid=recordScanGrid(new ScanGrid(),command=>trace.record('grid-command',command,clock++));
  grid.begin(true);grid.geometry(55);
  trace.record('inventory-seed',{version:1,cards:[]},clock++);
  const inventory=new InventoryEvidence([],{onEvent:event=>trace.record('inventory-event',inventoryEventData(event),clock++)});
  const source={sessionId:'unknown-cli',frameId:1,observationId:'1',captureOrder:1,captureTime:0,phase:'input' as const,slot:0};
  inventory.acceptIdentity({...source,frame:'unknown-cli/1'},'card-a');
  const seed={version:1 as const,sessionId:source.sessionId,origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
  trace.record('unknown-seed',seed,clock++);
  const unknown=new UnknownLifecycle(seed,{onEvent:fact=>trace.record('unknown-event',fact,clock++)});
  unknown.apply({version:1,kind:'upsert',key:{kind:'group',sessionId:source.sessionId,group:1},source,
    captureOrder:1,captureTime:0,pending:false,reason:'장수 확인',location:{percent:0,column:1,row:1}});
  const unknownHash=await hashUnknownLifecycle(unknown.snapshot());
  if(withCheckpoint)trace.record('unknown-checkpoint',{version:1,complete:true,events:1,hash:unknownHash},clock++);
  return {execution:JSON.parse(await(await trace.snapshotBlob()).text()),executionExpected:{
    gridHash:await hashScanGridReplay(scanGridReplaySnapshot(grid)),
    inventoryHash:await hashInventoryEvidence(inventory.snapshot()),unknownHash}};
}

test('a legacy grid-only trace remains partial without inventory state',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-grid-only-'));
  try{
    const trace=new RunStateTrace();let clock=0;
    const grid=recordScanGrid(new ScanGrid(),command=>trace.record('grid-command',command,clock++));
    grid.begin(true);grid.geometry(55);
    const execution=JSON.parse(await(await trace.snapshotBlob()).text());
    const gridHash=await hashScanGridReplay(scanGridReplaySnapshot(grid));
    const file=join(directory,'legacy.json');
    await writeFile(file,JSON.stringify({execution,executionExpected:{gridHash}}));
    let output='';assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),0);
    const result=JSON.parse(output);
    assert.equal(result.componentChecks.grid.matchesCapturedState,true);
    assert.equal(result.inventory.supported,false);
    assert.equal(result.matchesCapturedState,null);assert.equal(result.verificationStatus,'partial');
    assert.match(result.interpretation,/absent legacy channels are not proof of absence/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a missing report hash cannot conceal a conflicting inventory checkpoint',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-checkpoint-'));
  try {
    const file=join(directory,'report.json');
    for(const checkpointMatches of [false,true]) {
      const trace=new RunStateTrace();let clock=0;
      const grid=recordScanGrid(new ScanGrid(),command=>trace.record('grid-command',command,clock++));
      grid.begin(true);grid.geometry(55);
      trace.record('inventory-seed',{version:1,cards:[]},clock++);
      const inventory=new InventoryEvidence([],{onEvent:event=>trace.record('inventory-event',inventoryEventData(event),clock++)});
      inventory.acceptIdentity({sessionId:'case',frameId:1,observationId:'1',captureOrder:1,captureTime:1,
        phase:'input',slot:0,frame:'case/1'},'card-a');
      const hash=await hashInventoryEvidence(inventory.snapshot()),gridHash=await hashScanGridReplay(scanGridReplaySnapshot(grid));
      trace.record('inventory-checkpoint',{complete:true,hash:checkpointMatches?hash:'f'.repeat(64)},clock++);
      const execution=JSON.parse(await(await trace.snapshotBlob()).text());
      // In each case the present grid hash matches. Only inventory differs.
      for(const includeInventory of [false,true]) {
        await writeFile(file,JSON.stringify({execution,executionExpected:{gridHash,...(includeInventory?{inventoryHash:hash}:{})}}));
        let output='';const code=await runCorpusCli(['replay-state',file],value=>{output=value;});
        const result=JSON.parse(output),check=result.componentChecks.inventory;
        assert.equal(result.componentChecks.grid.matchesCapturedState,true);
        assert.equal(check.checkpointMatchesCapturedState,checkpointMatches);
        if(!checkpointMatches){
          assert.equal(code,2);assert.equal(result.matchesCapturedState,false);
          assert.equal(result.verificationStatus,'mismatch');assert.equal(check.status,'checkpoint-mismatch');
        }else if(!includeInventory){
          assert.equal(code,0);assert.equal(result.matchesCapturedState,null);
          assert.equal(result.verificationStatus,'partial');assert.equal(check.status,'missing-report-hash');
        }else{
          assert.equal(code,0);assert.equal(result.matchesCapturedState,true);assert.equal(result.verificationStatus,'verified');
        }
      }
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('optional real video6 trace cannot hide its mismatching inventory checkpoint',
  {skip:!process.env.LOACARD_OLD_REPLAY_REPORT},async()=>{
    const original=JSON.parse(await readFile(process.env.LOACARD_OLD_REPLAY_REPORT!,'utf8'));
    assert.ok(original.executionExpected?.inventoryHash);
    const {inventoryHash:_,...expected}=original.executionExpected;
    const directory=await mkdtemp(join(tmpdir(),'loa-corpus-real-checkpoint-'));
    try {
      const file=join(directory,'report.json');
      await writeFile(file,JSON.stringify({...original,executionExpected:expected}));
      let output='';assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),2);
      const result=JSON.parse(output);
      assert.equal(result.inventory.matchesCapturedState,false);
      assert.equal(result.componentChecks.inventory.status,'checkpoint-mismatch');
      assert.equal(result.matchesCapturedState,false);
    } finally {await rm(directory,{recursive:true,force:true});}
  });

test('corpus CLI compares inventory hashes separately and rejects absent or mismatched declared components',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-evidence-'));
  try {
    const trace=new RunStateTrace();let clock=0;
    trace.record('inventory-seed',{version:1,cards:[]},clock++);
    const inventory=new InventoryEvidence([],{onEvent:event=>trace.record('inventory-event',inventoryEventData(event),clock++)});
    const source={sessionId:'case',frameId:1,observationId:'1',captureOrder:1,captureTime:1,phase:'input' as const,slot:0,frame:'case/1'};
    inventory.acceptIdentity(source,'a');
    const hash=await hashInventoryEvidence(inventory.snapshot());
    trace.record('inventory-checkpoint',{complete:true,hash},clock++);
    const execution=JSON.parse(await (await trace.snapshotBlob()).text());
    const file=join(directory,'result.json');let output='';
    for(const [expected,code] of [[{inventoryHash:hash},0],[{inventoryHash:'f'.repeat(64)},2],
      [{inventoryHash:hash,inputHash:hash},2]] as const) {
      await writeFile(file,JSON.stringify({execution,executionExpected:expected}));
      assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),code);
      const result=JSON.parse(output);assert.equal(result.matchesCapturedState,code===0?null:false);
      if(code===0)assert.equal(result.verificationStatus,'partial','inventory alone cannot prove grid-state equality');
      assert.equal(result.inventory.hash,hash);assert.equal(result.input.supported,false);
      assert.equal(result.componentChecks.inventory.matchesCapturedState,expected.inventoryHash===hash);
    }
    await writeFile(file,JSON.stringify({execution,executionExpected:{inventoryHash:42}}));
    await assert.rejects(runCorpusCli(['replay-state',file],()=>{}),/Invalid captured state hash/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('replay CLI rejects an unknownHash mismatch even when every other supplied component matches',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-unknown-cli-'));
  try{
    const report=await unknownStateReport(),file=join(directory,'report.json');
    const {unknownHash,...legacyExpected}=report.executionExpected;
    assert.ok(unknownHash);assert.notEqual(unknownHash,'f'.repeat(64));
    for(const [expected,code,overall]of [[report.executionExpected,0,true],[{...report.executionExpected,unknownHash:'f'.repeat(64)},2,false],
      [legacyExpected,0,null]] as const){
      await writeFile(file,JSON.stringify({...report,executionExpected:expected}));
      let output='';assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),code);
      const replay=JSON.parse(output);assert.equal(replay.matchesCapturedState,overall);
      assert.equal(replay.componentChecks.grid.matchesCapturedState,true);
      assert.equal(replay.componentChecks.inventory.matchesCapturedState,true);
      assert.equal(replay.unknownLifecycle.hash,unknownHash);assert.equal(replay.unknownLifecycle.matchesCapturedState,true,
        'the event checkpoint stays valid when only the independently supplied report hash is wrong');
      assert.equal(replay.input.supported,false);assert.equal(Object.hasOwn(replay.componentChecks,'input'),false);
      if(Object.hasOwn(expected,'unknownHash'))assert.equal(replay.componentChecks.unknownLifecycle.matchesCapturedState,code===0);
      else {assert.equal(replay.componentChecks.unknownLifecycle.matchesCapturedState,null);
        assert.equal(replay.componentChecks.unknownLifecycle.status,'missing-report-hash');
        assert.equal(replay.verificationStatus,'partial');}
      const command=['--import','tsx',resolve('scripts/scan-corpus.mjs'),'replay-state',file];
      if(code===0){const actual=await execFileAsync(process.execPath,command);assert.deepEqual(JSON.parse(actual.stdout),replay);assert.equal(actual.stderr,'');}
      else await assert.rejects(execFileAsync(process.execPath,command),error=>{
        const actual=error as Error&{code:number;stdout:string;stderr:string};assert.equal(actual.code,2);
        assert.deepEqual(JSON.parse(actual.stdout),replay);assert.equal(actual.stderr,'');return true;
      });
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('replay CLI validates unknownHash with the same strict hash format as other components',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-unknown-format-'));
  try{
    const report=await unknownStateReport(),file=join(directory,'report.json');
    for(const unknownHash of [null,42,'','F'.repeat(64),'0'.repeat(63)]){
      await writeFile(file,JSON.stringify({...report,executionExpected:{...report.executionExpected,unknownHash}}));
      await assert.rejects(runCorpusCli(['replay-state',file],()=>{}),/Invalid captured state hash/);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('legacy traces remain unknown-lifecycle unsupported and cannot satisfy a declared unknownHash',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-unknown-legacy-'));
  try{
    const trace=new RunStateTrace(),file=join(directory,'legacy.json');
    trace.record('inventory-seed',{version:1,cards:[]},0);
    const execution=JSON.parse(await(await trace.snapshotBlob()).text());
    const inventoryHash=await hashInventoryEvidence(new InventoryEvidence([]).snapshot());
    for(const [expected,code]of [[{inventoryHash},0],[{inventoryHash,unknownHash:'0'.repeat(64)},2]] as const){
      await writeFile(file,JSON.stringify({execution,executionExpected:expected}));let output='';
      assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),code);
      const replay=JSON.parse(output);assert.equal(replay.unknownLifecycle.supported,false);assert.equal(replay.unknownLifecycle.hash,null);
      assert.equal(replay.componentChecks.inventory.matchesCapturedState,true);assert.equal(replay.matchesCapturedState,code===0?null:false);
      assert.equal(Object.hasOwn(replay.componentChecks,'unknownLifecycle'),code===2);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('replay CLI verifies the declared fifth channel and rejects a matching hash without its complete checkpoint',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-freshness-'));
  try{
    const file=join(directory,'report.json');
    for(const withCheckpoint of [true,false]) {
      const trace=new RunStateTrace();let clock=0;
      const inventory=new InventoryEvidence();
      trace.record('inventory-seed',{version:1,cards:[]},clock++);
      const seed={version:1 as const,sessionId:'freshness-cli',limits:FRESHNESS_EVIDENCE_LIMITS};
      trace.record('freshness-seed',seed,clock++);
      const freshness=new FreshnessEvidence(seed,{confirmedFields:()=>inventory.confirmedFieldOrder,
        onEvent:fact=>{assert.equal(trace.record('freshness-event',fact,clock++),true);}});
      freshness.guard('final');
      const snapshot=freshness.snapshot(),freshnessHash=await hashFreshnessEvidence(snapshot);
      if(withCheckpoint)trace.record('freshness-checkpoint',{version:1,complete:true,events:snapshot.facts,hash:freshnessHash},clock++);
      const execution=JSON.parse(await(await trace.snapshotBlob()).text());
      const inventoryHash=await hashInventoryEvidence(inventory.snapshot());
      for(const declaredHash of [freshnessHash,'f'.repeat(64)]) {
        await writeFile(file,JSON.stringify({execution,executionExpected:{inventoryHash,freshnessHash:declaredHash}}));
        let output='';const code=withCheckpoint&&declaredHash===freshnessHash?0:2;
        assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),code);
        const replay=JSON.parse(output);
        assert.equal(replay.componentChecks.inventory.matchesCapturedState,true);
        assert.equal(replay.componentChecks.freshness.matchesCapturedState,code===0);
        assert.equal(replay.matchesCapturedState,code===0?null:false);
        assert.equal(replay.freshness.hash,freshnessHash);
      }
      await writeFile(file,JSON.stringify({execution,executionExpected:{inventoryHash}}));
      let omittedOutput='';assert.equal(await runCorpusCli(['replay-state',file],value=>{omittedOutput=value;}),2);
      assert.equal(JSON.parse(omittedOutput).componentChecks.freshness.expectedHash,null);
      assert.equal(JSON.parse(omittedOutput).componentChecks.freshness.matchesCapturedState,null);
      assert.equal(JSON.parse(omittedOutput).verificationStatus,'partial');
    }
    const command=['--import','tsx',resolve('scripts/scan-corpus.mjs'),'replay-state',file];
    await assert.rejects(execFileAsync(process.execPath,command),error=>{
      const actual=error as Error&{code:number;stdout:string};assert.equal(actual.code,2);
      assert.equal(JSON.parse(actual.stdout).componentChecks.freshness.matchesCapturedState,null);return true;
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a matching outer unknown hash does not certify a missing internal checkpoint',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-unknown-incomplete-'));
  try{
    const file=join(directory,'report.json'),report=await unknownStateReport(false);
    await writeFile(file,JSON.stringify(report));let output='';
    assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),2);
    const result=JSON.parse(output);
    assert.equal(result.unknownLifecycle.hash,report.executionExpected.unknownHash);
    assert.equal(result.unknownLifecycle.complete,false);
    assert.equal(result.componentChecks.unknownLifecycle.status,'unsupported-or-incomplete');
    assert.equal(result.matchesCapturedState,false);assert.equal(result.verificationStatus,'unverified');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('legacy and malformed reports cannot silently ignore a declared freshnessHash',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'loa-corpus-freshness-legacy-'));
  try{
    const file=join(directory,'report.json'),trace=new RunStateTrace();
    trace.record('inventory-seed',{version:1,cards:[]},0);
    const execution=JSON.parse(await(await trace.snapshotBlob()).text());
    await writeFile(file,JSON.stringify({execution,executionExpected:{freshnessHash:'0'.repeat(64)}}));
    let output='';assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),2);
    const replay=JSON.parse(output);assert.equal(replay.freshness.supported,false);
    assert.equal(replay.componentChecks.freshness.matchesCapturedState,false);
    for(const freshnessHash of [null,42,'','F'.repeat(64),'0'.repeat(63)]) {
      await writeFile(file,JSON.stringify({execution,executionExpected:{freshnessHash}}));
      await assert.rejects(runCorpusCli(['replay-state',file],()=>{}),/Invalid captured state hash/);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
