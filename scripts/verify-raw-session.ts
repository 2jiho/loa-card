import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {openCorpusInput,readCorpusCase,verifyCorpus} from './scan-corpus-core.mjs';
import {MAX_RAW_ARCHIVE_BYTES,MAX_RAW_HEADER_BYTES,openRawSessionArchive} from '../src/features/card-scanner/reproduction/raw-session-archive';

/** Read-only file-handle backed Blob. The parser asks for header and hash
 * slices only; no full-file allocation or separate path open is performed. */
class HandleBlob extends Blob {
  constructor(private readonly handle:FileHandle,private readonly start:number,private readonly end:number,
    private readonly signal:AbortSignal){super();}
  override get size(){return this.end-this.start;}
  override slice(start=0,end=this.size):Blob {
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>this.size)
      throw Error('Invalid raw archive slice');
    return new HandleBlob(this.handle,this.start+start,this.start+end,this.signal);
  }
  override async arrayBuffer():Promise<ArrayBuffer> {
    this.signal.throwIfAborted();
    if(this.size>MAX_RAW_HEADER_BYTES)throw Error('Raw archive read exceeds bounded allocation');
    const bytes=new Uint8Array(this.size);let offset=0;
    while(offset<bytes.length){
      this.signal.throwIfAborted();
      const result=await this.handle.read(bytes,offset,bytes.length-offset,this.start+offset);
      if(!result.bytesRead)throw Error('Raw archive changed or was truncated');
      offset+=result.bytesRead;
    }
    this.signal.throwIfAborted();return bytes.buffer;
  }
}

async function digestHandle(handle:FileHandle,bytes:number,signal:AbortSignal):Promise<string> {
  const hash=createHash('sha256'),buffer=new Uint8Array(256*1024);let offset=0;
  while(offset<bytes){
    signal.throwIfAborted();
    const result=await handle.read(buffer,0,Math.min(buffer.length,bytes-offset),offset);
    if(!result.bytesRead)throw Error('Raw archive changed or was truncated');
    hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;
  }
  signal.throwIfAborted();return hash.digest('hex');
}

/** Checks the stored case and object, then validates the raw envelope and
 * every chunk from one safely opened handle. It does not replay the input. */
export async function verifyRawSessionCase({root,id,signal=new AbortController().signal}:{root?:string;id:string;signal?:AbortSignal}) {
  signal.throwIfAborted();
  const manifest=await readCorpusCase({root,id});
  if(manifest.kind!=='raw-session'||manifest.inputs.length!==1)throw Error('Case is not a raw session.');
  const expected=manifest.inputs[0];
  if(expected.bytes>MAX_RAW_ARCHIVE_BYTES)throw Error('Raw archive exceeds its size limit.');
  await verifyCorpus({root,id,signal});
  const {handle,input}=await openCorpusInput({root,id,index:0});
  try {
    const before=await handle.stat();
    if(before.size!==input.bytes||input.sha256!==expected.sha256||input.bytes!==expected.bytes)
      throw Error('Raw archive case changed during verification.');
    if(await digestHandle(handle,input.bytes,signal)!==input.sha256)throw Error('Raw archive checksum mismatch.');
    const raw=await openRawSessionArchive(new HandleBlob(handle,0,input.bytes,signal),signal);
    if(await digestHandle(handle,input.bytes,signal)!==input.sha256)throw Error('Raw archive checksum changed during verification.');
    const after=await handle.stat();
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
      throw Error('Raw archive changed during verification.');
    // Recheck both persisted paths and their hashes; detecting a replaced path
    // does not imply the replacement can safely be deleted or repaired.
    await verifyCorpus({root,id,signal});
    const reopened=await openCorpusInput({root,id,index:0});
    try {
      const current=await reopened.handle.stat();
      if(current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs||
        reopened.input.sha256!==input.sha256||reopened.input.bytes!==input.bytes)throw Error('Raw archive path changed during verification.');
    } finally {await reopened.handle.close();}
    signal.throwIfAborted();
    return {verified:true,caseId:id,bytes:input.bytes,chunks:raw.chunks.length,
      videoChunks:raw.chunks.filter(chunk=>chunk.kind==='video').length,
      exactChunks:raw.chunks.filter(chunk=>chunk.kind==='exact').length,replayable:false,
      scope:'raw-container-and-chunk-integrity-only'} as const;
  } finally {await handle.close();}
}
