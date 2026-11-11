import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addDiagnosticFragments,verifyDiagnosticFragments} from '../scripts/scan-diagnostic-fragments.mjs';

test('partial diagnostics retain observation order, unavailable images and immutable verified bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'loacard-diag-'));
 try {
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const input=join(root,'diagnostic.json');
  await writeFile(input,JSON.stringify({createdAt:'2026-10-29T18:21:03.422Z',nameConfiguration:{version:1},
   images:[{image:`data:image/png;base64,${png.toString('base64')}`,source:'recognition',time:8}],
   unidentifiedObservations:[{group:2,captureOrder:20,source:{slot:2},recognitionImageIndex:0},
    {group:1,captureOrder:10,source:{slot:3}}],unidentifiedOmitted:2}));
  const store=join(root,'cases');const added=await addDiagnosticFragments(input,store);
  assert.deepEqual(added.observations.map(x=>x.captureOrder),[20,10]);
  assert.equal(added.observations[1].recognitionImage,null);
  assert.equal(added.source.wholeInputAvailable,false);assert.equal(added.source.recordedBuild,null);
  assert.equal(added.humanExpected,null);assert.equal(added.unidentifiedOmitted,2);
  assert.equal((await verifyDiagnosticFragments(added.id,store)).images,1);
  assert.deepEqual(await addDiagnosticFragments(input,store),added);
  const path=join(store,added.id,'images',`${added.images[0].sha256}.png`);
  await writeFile(path,Buffer.from('changed'));
  await assert.rejects(verifyDiagnosticFragments(added.id,store),/mismatch/);
  await assert.rejects(addDiagnosticFragments(input,store),/no file overwritten/);
  assert.equal((await readFile(path)).toString(),'changed');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('an invalid retained image reference cannot be treated as missing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'loacard-diag-'));
 try {const input=join(root,'d.json');await writeFile(input,JSON.stringify({images:[],unidentifiedObservations:[{recognitionImageIndex:0}]}));
  await assert.rejects(addDiagnosticFragments(input,join(root,'cases')),/image reference/);
 } finally {await rm(root,{recursive:true,force:true});}
});
