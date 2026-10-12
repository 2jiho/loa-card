import type { acquireCards } from './card-acquisition';
import type { Layout } from './detector';
import { obsoleteFieldRetry } from './field-retry';
import type { createRecognizer } from './recognizer';

type Cell=ReturnType<typeof acquireCards>[number];
export interface SavedObservation {
  order:number;
  frame:string;
  stable:boolean;
  identity?:NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createRecognizer>>['identify']>>>;
}
/** Bound to one lossless encoder frame ID, never a nearby timestamp or video decode. */
export interface SavedAcquisition {
  width:number;
  height:number;
  layout:Layout|null;
  cells:Omit<Cell,'image'>[];
  observations:(SavedObservation|undefined)[];
}

export function saveAcquisition(width:number,height:number,layout:Layout|null,cells:(Cell&{previewImage?:HTMLCanvasElement})[]):SavedAcquisition {
  return {width,height,layout:structuredClone(layout),observations:[],
    cells:cells.map(({image:_image,previewImage:_preview,...cell})=>structuredClone(cell))};
}

/** Only exact, accepted identities can let newer fully confirmed evidence retire a replay. */
export function resolvedSavedObservation(observation:SavedObservation|undefined,confirmed:ReadonlyMap<string,number>) {
  return !!observation?.identity && !observation.identity.review.length &&
    obsoleteFieldRetry({needsIdentity:false,fieldTarget:{id:observation.identity.id,order:observation.order}},confirmed);
}

export function coveredSavedAcquisition(saved:SavedAcquisition|undefined,confirmed:ReadonlyMap<string,number>) {
  return !!saved?.layout && saved.cells.length>0 && saved.cells.every((cell,index)=>
    cell.quality.reason==='미보유 카드 뒷면 · 빈 슬롯' ||
    (cell.quality.usable && resolvedSavedObservation(saved.observations[index],confirmed)));
}

/** Analysis is optional: eviction means reacquire, never discard source frames. */
export class SavedAcquisitions {
  private entries=new Map<number,SavedAcquisition>();
  private limit:number;
  constructor(limit=128){
    if(!Number.isInteger(limit)||limit<1)throw Error('Invalid acquisition cache limit');
    this.limit=limit;
  }
  set(id:number,value:SavedAcquisition){
    this.entries.delete(id);this.entries.set(id,value);
    while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);
  }
  get(id:number){return this.entries.get(id);}
  delete(id:number){this.entries.delete(id);}
  clear(){this.entries.clear();}
  coveredFrom(first:number,last:number,covered:(value:SavedAcquisition|undefined)=>boolean){
    for(let id=first;id<=last;id++)if(!covered(this.entries.get(id)))return false;
    return true;
  }
}
