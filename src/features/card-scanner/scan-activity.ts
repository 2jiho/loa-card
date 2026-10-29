export interface ScanActivityItem {
  id:number;
  image:string;
  name?:string;
  status:'reading'|'waiting'|'read'|'review';
}

/** Presentation only. Reuses thumbnails; never changes evidence or scheduling. */
export class RecentScanActivity {
  private items:ScanActivityItem[]=[];
  private attempts=new Map<number,number>();
  private nextAttempt=0;
  start(id:number,image:string){
    const attempt=++this.nextAttempt;
    this.attempts.set(id,attempt);
    this.items=[...this.items.filter(item=>item.id!==id),{id,image,status:'reading' as const}].slice(-16);
    const retained=new Set(this.items.map(item=>item.id));
    for(const key of this.attempts.keys())if(!retained.has(key))this.attempts.delete(key);
    return attempt;
  }
  finish(id:number,status:ScanActivityItem['status'],name?:string,attempt?:number){
    if(attempt!==undefined&&this.attempts.get(id)!==attempt)return;
    this.attempts.delete(id);
    this.items=this.items.map(item=>item.id===id?{...item,status,name}:item);
  }
  updateImage(id:number,image:string){
    if(!image||!this.items.some(item=>item.id===id&&item.image!==image))return false;
    this.items=this.items.map(item=>item.id===id?{...item,image}:item);
    return true;
  }
  snapshot(){return this.items;}
}
