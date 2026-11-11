import {constants} from 'node:fs';
import {copyFile,link,lstat,mkdir,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCropArchive,type SliceInput} from '../dev/crop-archive';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../fixtures/local/crop-archives');
async function inspect(path:string){
 const handle=await open(path,'r');try{
  const before=await handle.stat();if(!before.isFile())throw Error('Archive is not a regular file');
  const input:SliceInput={size:before.size,slice(start,end){return {async arrayBuffer(){
   const length=end-start;if(!Number.isSafeInteger(length)||length<0||length>16*1024*1024||start<0||end>before.size)throw Error('Invalid archive read');
   const buffer=new Uint8Array(length);let count=0;while(count<length){const read=await handle.read(buffer,count,length-count,start+count);
    if(!read.bytesRead)throw Error('Archive changed while reading');count+=read.bytesRead;}return buffer.buffer;
  }};}};
  const archive=await openCropArchive(input,AbortSignal.timeout(300000));
  const hash=createHash('sha256'),buffer=new Uint8Array(256*1024);let position=0;
  while(position<before.size){const chunk=await handle.read(buffer,0,Math.min(buffer.length,before.size-position),position);
   if(!chunk.bytesRead)throw Error('Archive changed while hashing');hash.update(buffer.subarray(0,chunk.bytesRead));position+=chunk.bytesRead;}
  const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino||after.dev!==before.dev)throw Error('Archive changed during verification');
  return {sha256:hash.digest('hex'),bytes:before.size,complete:archive.proof.complete,crops:archive.proof.crops,
   unique:archive.proof.unique,shared:archive.proof.shared,metadataSha256:archive.metadataSha256,seed:archive.seed,scope:'recognition-crops-only'};
 }finally{await handle.close();}
}
export async function runCropArchiveCli(args:string[],rootOverride?:string){
 if(args.length!==2||!['verify','add'].includes(args[0]))throw Error('Usage: node --import tsx scripts/crop-archive.ts verify|add <file.loacrops>');
 const source=resolve(args[1]);if(args[0]==='verify')return inspect(source);
 const localRoot=rootOverride?resolve(rootOverride):root;
 await mkdir(localRoot,{recursive:true});const folder=await lstat(localRoot);if(!folder.isDirectory()||folder.isSymbolicLink())throw Error('Local archive directory must not be a symlink');
 const temporary=join(localRoot,`.pending-${randomUUID()}`);let created=false;
 try{
  await copyFile(source,temporary,constants.COPYFILE_EXCL);created=true;
  const evidence=await inspect(temporary),target=join(localRoot,`${evidence.sha256}.loacrops`);let added=true;
  try{await link(temporary,target);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const existing=await inspect(target);if(existing.sha256!==evidence.sha256||existing.bytes!==evidence.bytes)throw Error('Existing archive differs');added=false;
  }
  const linked=await inspect(target);if(linked.sha256!==evidence.sha256||linked.bytes!==evidence.bytes)throw Error('Registered archive differs from verified copy');
  return {...evidence,added,path:target};
 }finally{if(created)await unlink(temporary);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runCropArchiveCli(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2)),error=>{console.error(String(error));process.exitCode=1;});
}
