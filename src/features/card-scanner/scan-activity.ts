export interface ScanActivityItem {
  id:number;
  image:string;
  name?:string;
  status:'reading'|'waiting'|'read'|'review';
}

/** Presentation only. Reuses thumbnails; never changes evidence or scheduling. */
export class RecentScanActivity {
  private items:ScanActivityItem[]=[];
  start(id:number,image:string){
    this.items=[...this.items.filter(item=>item.id!==id),{id,image,status:'reading' as const}].slice(-16);
  }
  finish(id:number,status:ScanActivityItem['status'],name?:string){
    this.items=this.items.map(item=>item.id===id?{...item,status,name}:item);
  }
  snapshot(){return this.items;}
}
