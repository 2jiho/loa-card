import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addCorpusCase} from '../scripts/scan-corpus-core.mjs';
import {runCorpusCli} from '../scripts/scan-corpus.mjs';
import {verifyRawSessionCase} from '../scripts/verify-raw-session';
import {createRawSessionArchive} from '../src/features/card-scanner/reproduction/raw-session-archive';

async function fixture(fn:(directory:string,root:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'loacard-raw-verify-'));
  try{await fn(directory,join(directory,'corpus'));}finally{await rm(directory,{recursive:true,force:true});}
}
async function sample(){
  const data=new TextEncoder().encode('incomplete exact bytes');
  const sha256=createHash('sha256').update(data).digest('hex');
  return createRawSessionArchive({index:{version:1,id:'session',createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z',
    environment:{browser:'test',catalog:'test',build:'test'},record:true,status:'partial',sealed:true,pinned:false,ownerId:'owner',leaseUntil:null,
    bytes:data.byteLength,detailsBytes:0,chunkCounts:{video:0,exact:1},chunkBytes:{video:0,exact:data.byteLength},hasInput:true,
    read:null,expected:null,cards:null,generation:'generation',archiveRevision:'revision',archive:{state:'pending'}},
    chunks:[{kind:'exact',seq:0,bytes:data.byteLength,sha256,blob:new Blob([data])}]},new AbortController().signal);
}

test('raw verification checks the corpus object and each internal chunk without claiming replay',async()=>{
  await fixture(async(directory,root)=>{
    const file=join(directory,'source.loaraw'),blob=await sample();await writeFile(file,new Uint8Array(await blob.arrayBuffer()));
    const {manifest}=await addCorpusCase([file],{root});
    const result=await verifyRawSessionCase({root,id:manifest.id});
    assert.deepEqual(result,{verified:true,caseId:manifest.id,bytes:blob.size,chunks:1,videoChunks:0,exactChunks:1,
      replayable:false,scope:'raw-container-and-chunk-integrity-only'});
    const output:string[]=[];assert.equal(await runCorpusCli(['verify-raw',manifest.id,'--root',root],s=>output.push(s)),0);
    assert.deepEqual(JSON.parse(output[0]),result);
  });
});

test('raw verification refuses a corrupt internal chunk even if corpus file hash is valid',async()=>{
  await fixture(async(directory,root)=>{
    const blob=await sample(),bytes=new Uint8Array(await blob.arrayBuffer());bytes[bytes.length-1]^=1;
    const file=join(directory,'corrupt.loaraw');await writeFile(file,bytes);
    // Corpus registration authenticates these bytes, but not their internal chunk claim.
    const {manifest}=await addCorpusCase([file],{root});
    await assert.rejects(verifyRawSessionCase({root,id:manifest.id}),/해시/);
  });
});

test('raw verification rejects altered corpus bytes, wrong kind, invalid IDs and cancellation',async()=>{
  await fixture(async(directory,root)=>{
    const blob=await sample(),file=join(directory,'source.loaraw');await writeFile(file,new Uint8Array(await blob.arrayBuffer()));
    const {manifest}=await addCorpusCase([file],{root});
    const controller=new AbortController();controller.abort();
    await assert.rejects(verifyRawSessionCase({root,id:manifest.id,signal:controller.signal}),{name:'AbortError'});
    await assert.rejects(verifyRawSessionCase({root,id:'../outside'}));
    const video=join(directory,'other.mp4');await writeFile(video,'video');
    const other=await addCorpusCase([video],{root});await assert.rejects(verifyRawSessionCase({root,id:other.manifest.id}),/not a raw session/);
    const stored=join(root,'cases',manifest.id,'input','0001.loaraw');
    const altered=new Uint8Array(await blob.arrayBuffer());altered[altered.length-1]^=1;await writeFile(stored,altered);
    await assert.rejects(verifyRawSessionCase({root,id:manifest.id}),/checksum/i);
  });
});

test('raw verification does not follow a linked corpus root',async t=>{
  await fixture(async(directory,root)=>{
    const blob=await sample(),file=join(directory,'source.loaraw');await writeFile(file,new Uint8Array(await blob.arrayBuffer()));
    const {manifest}=await addCorpusCase([file],{root});
    const linked=join(directory,'linked');
    try{await symlink(root,linked,'junction');}catch(error){
      if(['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('junction unavailable');return;}
      throw error;
    }
    await assert.rejects(verifyRawSessionCase({root:linked,id:manifest.id}),/Symlinks|junctions/i);
  });
});
