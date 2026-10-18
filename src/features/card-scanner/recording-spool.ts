/** Stream encoded chunks to a private temporary file. Only the write backlog is
 * retained in JS; unsupported browsers use a strictly bounded fallback. */
export interface RecordingSpool {
  write(blob:Blob):Promise<void>;
  finish(type:string):Promise<Blob>;
  dispose():Promise<void>;
}
export async function createRecordingSpool():Promise<RecordingSpool> {
  if(typeof navigator!=='undefined'&&navigator.storage?.getDirectory){
    const root=await navigator.storage.getDirectory();
    const directory=await root.getDirectoryHandle('loacard-recordings',{create:true});
    // A closed/crashed tab cannot run dispose. Remove only expired files in
    // this feature's directory, never another tab's active recording.
    const entries=directory as FileSystemDirectoryHandle&{keys:()=>AsyncIterable<string>};
    for await(const entry of entries.keys()){
      const stamp=/^(\d+)-[\da-f-]+\.webm$/.exec(entry);
      if(stamp&&Date.now()-Number(stamp[1])>24*60*60*1000)await directory.removeEntry(entry).catch(()=>{});
    }
    const name=`${Date.now()}-${crypto.randomUUID()}.webm`;
    const file=await directory.getFileHandle(name,{create:true});
    const writer=await file.createWritable();
    let closed=false;
    return {
      write:blob=>writer.write(blob),
      async finish(type){await writer.close();closed=true;const value=await file.getFile();return value.slice(0,value.size,type);},
      async dispose(){if(!closed){await writer.abort().catch(()=>{});closed=true;}await directory.removeEntry(name).catch(()=>{});},
    };
  }
  let chunks:Blob[]=[],size=0;
  return {
    async write(blob){size+=blob.size;if(size>32*1024*1024)throw Error('임시 파일 미지원 · 메모리 기록 32MB 한도');chunks.push(blob);},
    async finish(type){const result=new Blob(chunks,{type});chunks=[];return result;},
    async dispose(){chunks=[];},
  };
}
