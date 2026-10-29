/** Fixed grayscale anchor derivatives only; never caches an input or a match.
 * A lease keeps oversized templates usable without retaining them. */
export function createDetectorTemplateCache<T extends {delete():void}>(
  create:(width:number,height:number)=>T,maxBytes=4*1024*1024,maxEntries=32,
) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxEntries)||maxEntries<0)
    throw new RangeError('Invalid detector template cache limit');
  const entries=new Map<string,{value:T;bytes:number}>();let bytes=0;
  return {
    acquire(width:number,height:number) {
      if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||!Number.isSafeInteger(width*height))
        throw new RangeError('Invalid detector template size');
      const key=`${width}:${height}`,hit=entries.get(key);
      if(hit){entries.delete(key);entries.set(key,hit);return {value:hit.value,release:()=>{}};}
      const value=create(width,height),size=width*height;
      if(!maxEntries||size>maxBytes){let released=false;return {value,release:()=>{if(!released){released=true;value.delete();}}};}
      while(entries.size>=maxEntries||bytes+size>maxBytes){
        const [oldKey,old]=entries.entries().next().value!;
        entries.delete(oldKey);bytes-=old.bytes;old.value.delete();
      }
      entries.set(key,{value,bytes:size});bytes+=size;
      return {value,release:()=>{}};
    },
    dispose(){for(const entry of entries.values())entry.value.delete();entries.clear();bytes=0;},
  };
}
