import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {addCorpusCase} from '../scripts/scan-corpus-core.mjs';
import {runCorpusCli} from '../scripts/scan-corpus.mjs';

test('selection CLI checks ordered case and optional receipt hash without promoting times to capture evidence',async()=>{
 const base=tmpdir(),directory=await mkdtemp(join(base,'loa-selection-cli-'));
 try{
  const root=join(directory,'corpus'),file=join(directory,'one.png');await writeFile(file,'synthetic-input');
  const selection={id:'0b33a0f5-4864-4a2d-8845-26cb70e82448',selectedAt:null,
    registrationStartedAt:'2026-10-30T01:02:03.000Z',lastModifiedMs:[123]};
  const added=await addCorpusCase([file],{root,selection});assert.ok(added.selection);
  const output:string[]=[];assert.equal(await runCorpusCli(['verify-selection',added.manifest.id,selection.id,
    '--sha256',added.selection.sha256,'--root',root],value=>output.push(value)),0);
  const result=JSON.parse(output[0]);assert.equal(result.receiptMatches,true);assert.equal(result.record.captureTime,null);
  assert.equal(result.record.selection.selectedAt,null);assert.equal(result.record.selection.lastModifiedMs[0],123);
  await assert.rejects(runCorpusCli(['verify-selection',added.manifest.id,selection.id,'--sha256','a'.repeat(64),'--root',root]),/hash mismatch/);
 }finally{
  const path=relative(base,directory);assert.ok(path&&!isAbsolute(path)&&!path.startsWith('..'));
  await rm(directory,{recursive:true,force:true});
 }
});
