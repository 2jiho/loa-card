import type {SnapshotSource} from './bitmap-dispatch';
import type {CanonicalRawLease,createCanonicalCapture} from './canonical-capture';
import {parseBackupCapacityDeferral,type BackupCapacityDeferral} from './input-arrival';
export type {CanonicalRawLease} from './canonical-capture';

type Store=Pick<ReturnType<typeof createCanonicalCapture>,'rawCapacity'|'leaseRaw'|'submit'|'stats'>;
function dimensions(source:SnapshotSource){
 return {width:'displayWidth'in source?source.displayWidth:'videoWidth'in source?source.videoWidth:source.width,
  height:'displayHeight'in source?source.displayHeight:'videoHeight'in source?source.videoHeight:source.height};
}

/** Raw live admission only. A lease holds byte credit while a frozen input is
 * a replaceable representative. A physical ID exists only after input/backup
 * commit; a lease neither saves pixels nor advances the backup clock. */
export function createLiveRawSource(store:Store,options:{
 remember(elapsed:number):void;
 backupDeferred(value:BackupCapacityDeferral):void;
}){
 const commit=(lease:CanonicalRawLease|undefined,source:SnapshotSource,time:number,elapsed:number,role:'input'|'backup'='input')=>{
  const id=lease?lease.commit(source,time,elapsed,role):store.submit(source,time,elapsed,role);
  if(id!==undefined)options.remember(elapsed);
  return id;
 };
 return {
  capacity(source:SnapshotSource):boolean {
   const {width,height}=dimensions(source);
   // Permanent/unavailable conditions retain submit's existing failure path.
   // Only a temporary pending-byte backlog defers a future snapshot.
   return store.rawCapacity(width,height,'input')!=='busy';
  },
  lease(source:SnapshotSource):CanonicalRawLease|undefined {
   const {width,height}=dimensions(source);
   return store.leaseRaw(width,height);
  },
  commit,
  input(source:SnapshotSource,time:number,elapsed:number):number|undefined {
   return commit(undefined,source,time,elapsed);
  },
  backup(source:SnapshotSource,time:number,elapsed:number):number|undefined {
   const {width,height}=dimensions(source);
   if(store.rawCapacity(width,height,'backup')==='busy'){
    options.backupDeferred(parseBackupCapacityDeferral({version:1,reason:'source-capacity',captureTime:time,
     observedAtMs:elapsed,width,height,pendingBytes:store.stats.pendingBytes}));
    return;
   }
   return store.submit(source,time,elapsed,'backup');
  },
 };
}
