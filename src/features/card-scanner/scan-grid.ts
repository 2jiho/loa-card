export type GridStatus = 'unknown' | 'waiting' | 'read' | 'review' | 'empty';
export interface ScanGridCell { status: GridStatus; reason?: string; row?: number }
export interface ScanGridSnapshot { located: boolean; cells: ScanGridCell[]; inventory?: ScanGridCell[]; totalRows?:number; estimatedTop?:number; liveTop?:number; liveTracking?:boolean }
type StoredCell=ScanGridCell & {group?:number;frame?:number};
/** Display metadata only. Never contributes evidence or controls capture. */
export class ScanGrid {
  private cells: StoredCell[] = [];
  private groups = new Map<number, {trace: number; status: GridStatus}>();
  private identities = new Map<number,string>();
  private slotIdentities = new Map<number,string>();
  private confirmed = new Set<string>();
  private traces = new Map<number, number>();
  private nextGroupPrune = 2048;
  private located = false;
  private inventory = new Map<number, StoredCell>();
  private frames=new Map<number,StoredCell[]>();
  private currentFrame:number|undefined;
  private groupSlots = new Map<number,number>();
  private totalRows:number|undefined;
  private estimatedTop:number|undefined;
  private liveTop:number|undefined;
  private liveTracking=false;
  private livePositions=new Map<number,{id:string;status:GridStatus}>();
  /** Replace display-only placements. Status comes from the latest field
   * evidence, so a newer unresolved observation can revoke a green marker. */
  placeLive(positions:{id:string;slot:number}[],statuses:ReadonlyMap<string,GridStatus>) {
    this.livePositions.clear();
    if(new Set(positions.map(p=>p.id)).size!==positions.length||new Set(positions.map(p=>p.slot)).size!==positions.length||
      positions.some(p=>!statuses.has(p.id)||!Number.isInteger(p.slot)||p.slot<0||p.slot>=550))return;
    for(const {id,slot} of positions)this.livePositions.set(slot,{id,status:statuses.get(id)!});
  }
  liveViewport(top:number|undefined,active=true){
    const next=top!==undefined&&Number.isInteger(top)&&top>=1&&top<=52?top:undefined;
    const changed=this.liveTracking!==active||this.liveTop!==next;
    this.liveTracking=active;this.liveTop=next;return changed;
  }
  viewport(top:number|undefined) {this.estimatedTop=top!==undefined&&Number.isInteger(top)&&top>=1&&top<=52?top:undefined;}
  geometry(totalRows:number|undefined) {
    if(totalRows===undefined)return;
    if(this.totalRows!==undefined&&this.totalRows!==totalRows)this.resetPositions();
    this.totalRows=totalRows;
  }
  begin(located: boolean) { this.located = located;if(!located)this.liveTop=undefined;this.currentFrame=undefined;this.estimatedTop=undefined; this.cells = Array.from({length:40},()=>({status:'unknown'})); }
  record(frame:number) {
    this.currentFrame=frame;
    this.frames.set(frame,this.cells.map(cell=>({...cell,frame})));
    while(this.frames.size>256)this.frames.delete(this.frames.keys().next().value!);
  }
  register(frame:number,top:number) {
    const cells=this.frames.get(frame);if(!cells)return;
    cells.forEach((value,i)=>{
      const cell={...value,row:top+Math.floor(i/10)},old=this.inventory.get((cell.row-1)*10+i%10);
      if(frame===this.currentFrame)this.cells[i]=cell;
      if((old?.frame??-1)>frame)return;
      if(cell.group===undefined&&cell.status!=='empty'&&old?.group!==undefined)return;
      this.remember(i,cell);
    });
    this.frames.delete(frame);
  }
  identify(group:number,id:string) {
    this.identities.set(group,id);
    const slot=this.groupSlots.get(group);if(slot!==undefined)this.slotIdentities.set(slot,id);
    while(this.identities.size>4096)this.identities.delete(this.identities.keys().next().value!);
  }
  /** Called only after final inventory validation; never fills unobserved slots. */
  confirm(ids:string[]) {this.livePositions.clear();this.confirmed=new Set(ids);}
  restorePositions(positions:{id:string;slot:number}[]) {
    if(new Set(positions.map(p=>p.id)).size!==positions.length||new Set(positions.map(p=>p.slot)).size!==positions.length||
      positions.some(p=>!this.confirmed.has(p.id)||!Number.isInteger(p.slot)||p.slot<0||p.slot>=550))return;
    const moved=new Set(positions.map(p=>p.id));
    for(const [slot,id] of this.slotIdentities)if(moved.has(id)) {
      const old=this.inventory.get(slot);if(old?.group!==undefined)this.groupSlots.delete(old.group);
      this.inventory.delete(slot);this.slotIdentities.delete(slot);
    }
    for(const {id,slot} of positions) {
      const old=this.inventory.get(slot);if(old?.group!==undefined)this.groupSlots.delete(old.group);
      this.slotIdentities.set(slot,id);
      this.inventory.set(slot,{status:'read',row:Math.floor(slot/10)+1,reason:'동일 화면의 카드 위치 관계로 복원'});
    }
  }
  /** Reconstruct only a complete, independently checked name order, never a
   * number of green squares inferred from the inventory count. */
  restoreOrder(ids:string[]) {
    if(!ids.length||ids.length!==this.confirmed.size||new Set(ids).size!==ids.length||ids.some(id=>!this.confirmed.has(id)))return;
    ids.forEach((id,index)=>{
      this.slotIdentities.set(index,id);
      this.inventory.set(index,{status:'read',row:Math.floor(index/10)+1,reason:'검증된 이름순 목록으로 위치 복원'});
    });
  }
  /** Sorting moves cards, but does not invalidate the same observation's read
   * result. Keep jobs/identities; discard every old position and final overlay. */
  resetPositions() {
    this.livePositions.clear();
    this.liveViewport(undefined,false);
    this.slotIdentities.clear();this.confirmed.clear();this.inventory.clear();
    this.groupSlots.clear();this.frames.clear();this.totalRows=undefined;this.begin(false);
  }
  reset() {this.groups.clear();this.identities.clear();this.traces.clear();this.nextGroupPrune=2048;this.resetPositions();}
  private pruneGroups() {
    if(this.groups.size<=this.nextGroupPrune)return;
    // Keep states still referenced by the map, viewport or a pending frame.
    // These references are bounded by 550 slots + 40 cells + 256 * 40 cells.
    const retained=new Set(this.groupSlots.keys());
    for(const cell of this.cells)if(cell.group!==undefined)retained.add(cell.group);
    for(const cells of this.frames.values())for(const cell of cells)if(cell.group!==undefined)retained.add(cell.group);
    for(const [group,value] of this.groups) {
      if(this.groups.size<=2048)break;
      if(retained.has(group))continue;
      this.groups.delete(group);
      this.traces.delete(value.trace);
    }
    // Amortize reference traversal when many pending frames are pinned.
    this.nextGroupPrune=Math.max(2048,this.groups.size+256);
  }
  private remember(slot:number,cell=this.cells[slot]) {
    const row=cell?.row;
    if(row!==undefined&&Number.isInteger(row)&&row>0&&row<=55) {
      const groupSlot=cell.group===undefined?undefined:this.groupSlots.get(cell.group);
      if(groupSlot!==undefined&&(this.inventory.get(groupSlot)?.frame??-1)>(cell.frame??-1))return;
      const index=(row-1)*10+slot%10, previous=this.inventory.get(index);
      if(previous?.group!==undefined)this.groupSlots.delete(previous.group);
      if(cell.group!==undefined) {
        const old=this.groupSlots.get(cell.group);
        if(old!==undefined&&old!==index){this.inventory.delete(old);this.slotIdentities.delete(old);}
        this.groupSlots.set(cell.group,index);
        const id=this.identities.get(cell.group);if(id!==undefined)this.slotIdentities.set(index,id);
      }
      if(cell.status==='empty')this.slotIdentities.delete(index);
      this.inventory.set(index,cell);
    }
  }
  cell(slot:number, status:GridStatus, reason?:string, row?:number) {
    if(slot<0||slot>=40)return;
    this.cells[slot]={status,reason,row};
    // Transient acquisition state is not a replacement for a registered group.
    // In particular, a crop is staged as unknown before duplicate lookup.
    const previous=row===undefined?undefined:this.inventory.get((row-1)*10+slot%10);
    if(status==='empty'||previous?.group===undefined)this.remember(slot);
  }
  group(slot:number, group:number, trace:number, fresh:boolean, row?:number) {
    if(fresh)this.confirmed.clear();
    if(fresh) {
      const previous=this.groups.get(group);
      if(previous)this.traces.delete(previous.trace);
      this.groups.set(group,{trace,status:'waiting'});
      this.traces.set(trace,group);
    }
    this.cells[slot]={group,status:'unknown',row};
    this.remember(slot);
    this.pruneGroups();
  }
  finish(trace:number,status:GridStatus) {
    const group=this.traces.get(trace), value=group===undefined?undefined:this.groups.get(group);
    // A delayed result must not paint a newer, different observation green.
    if(value?.trace===trace)value.status=status;
  }
  stage(trace:number,stage:string) {
    if(['dropped','unidentified','superseded'].includes(stage))this.finish(trace,'review');
    if(stage==='deferred')this.finish(trace,'waiting');
  }
  snapshot():ScanGridSnapshot {
    const resolve=(cell:ScanGridCell & {group?:number},index?:number):ScanGridCell=>({status:cell.group===undefined?cell.status:this.confirmed.has(this.identities.get(cell.group)??(index===undefined?'':this.slotIdentities.get(index)??''))?'read':this.groups.get(cell.group)?.status??'unknown',reason:cell.reason,row:cell.row});
    const length=Math.max(-1,...this.inventory.keys(),...this.livePositions.keys())+1;
    const moved=new Map([...this.livePositions].map(([slot,value])=>[value.id,slot]));
    return {located:this.located,totalRows:this.totalRows,estimatedTop:this.estimatedTop,liveTop:this.liveTop,liveTracking:this.liveTracking,cells:this.cells.map(cell=>resolve(cell)),inventory:Array.from({length},(_,i)=>{
      const live=this.livePositions.get(i);
      if(live)return {status:live.status,row:Math.floor(i/10)+1,reason:'겹치는 카드의 위치 관계로 연결'};
      const cell=this.inventory.get(i),id=cell?.group===undefined?this.slotIdentities.get(i):this.identities.get(cell.group)??this.slotIdentities.get(i);
      if(id!==undefined&&moved.has(id)&&moved.get(id)!==i)return {status:'unknown'};
      return resolve(cell??{status:'unknown'},i);
    })};
  }
}
export function gridReady(grid:ScanGridSnapshot|undefined) {
  return !!grid?.located&&grid.cells.length===40&&grid.cells.every(c=>['waiting','read','empty'].includes(c.status));
}
/** Header capacity is the opened slot count, not the number of owned cards. */
export function isLockedInventorySlot(index:number,capacity:number|null|undefined,owned:number|null|undefined) {
  return capacity!=null&&Number.isInteger(capacity)&&capacity>0&&capacity<=550&&capacity%10===0&&owned!=null&&owned<=capacity&&index>=capacity&&index<550;
}
