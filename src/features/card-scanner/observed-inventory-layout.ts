export interface ObservedPosition {id:string;slot:number}

/** Compact relative-position receipts, independent of OCR jobs and scrollbar
 * estimates. Only border-checked, accepted crops belong here; no pixels are retained.
 * OCR field stability is separate from same-frame geometric spacing. */
export class ObservedInventoryLayout {
  private frames=new Map<string,(number|undefined)[]>();
  private identities=new Map<number,string>();
  capture(groups:(number|undefined)[]) {
    if(groups.length!==40||new Set(groups.flatMap((g,i)=>g===undefined?[]:[i%10])).size<6)return;
    const key=groups.map(g=>g??'').join(',');
    if(this.frames.has(key))return;
    this.frames.set(key,[...groups]);
    while(this.frames.size>1024)this.frames.delete(this.frames.keys().next().value!);
  }
  identify(group:number,id:string) {
    this.identities.set(group,id);
    while(this.identities.size>40960)this.identities.delete(this.identities.keys().next().value!);
  }
  // Sorting invalidates spatial receipts, but not an already identified crop.
  resetPositions(){this.frames.clear();}
  resolve(confirmed:string[],anchors:ObservedPosition[],complete=true):ObservedPosition[] {
    const allowed=new Set(confirmed);
    if(!allowed.size||allowed.size!==confirmed.length||allowed.size>550)return [];
    const graph=new Map<string,{id:string;delta:number}[]>(),columns=new Map<string,Set<number>>();
    const connect=(a:string,b:string,delta:number)=>{const edges=graph.get(a)??[];edges.push({id:b,delta});graph.set(a,edges);};
    for(const groups of this.frames.values()) {
      const cells=groups.flatMap((g,i)=>{const id=g===undefined?undefined:this.identities.get(g);return id&&allowed.has(id)?[{id,i}]:[];});
      if(new Set(cells.map(c=>c.i%10)).size<6)continue;
      const first=cells[0];
      for(const cell of cells) {
        const cols=columns.get(cell.id)??new Set<number>();cols.add(cell.i%10);columns.set(cell.id,cols);
        connect(first.id,cell.id,cell.i-first.i);connect(cell.id,first.id,first.i-cell.i);
      }
    }
    const visited=new Set<string>(),result:ObservedPosition[][]=[],unplaced:ObservedPosition[][]=[];
    let inconsistent=false;
    for(const start of graph.keys()) {
      if(visited.has(start))continue;
      const offsets=new Map<string,number>([[start,0]]),queue=[start];let conflict=false;
      for(let cursor=0;cursor<queue.length;cursor++) {
        const id=queue[cursor];visited.add(id);
        if(columns.get(id)!.size!==1)conflict=true;
        for(const edge of graph.get(id)??[]) {
          const offset=offsets.get(id)!+edge.delta,old=offsets.get(edge.id);
          if(old!==undefined){if(old!==offset)conflict=true;}
          else {offsets.set(edge.id,offset);queue.push(edge.id);}
        }
      }
      if(conflict||new Set(offsets.values()).size!==offsets.size){inconsistent=true;continue;}
      const witnesses=anchors.filter(a=>offsets.has(a.id));
      const shifts=new Set(witnesses.map(a=>a.slot-offsets.get(a.id)!));
      if(shifts.size>1){inconsistent=true;continue;}
      // A connected complete inventory has a unique origin only when every
      // observed ID occupies one consecutive slot, including column alignment.
      const whole=complete&&offsets.size===allowed.size;
      const shift=whole?-Math.min(...offsets.values()):shifts.size===1&&new Set(witnesses.map(a=>a.slot%10)).size>=6?[...shifts][0]:undefined;
      if(shift===undefined) {
        const origin=Math.min(...offsets.values());
        unplaced.push([...offsets].map(([id,offset])=>({id,slot:offset-origin})));
        continue;
      }
      if(shifts.size===1&&![...shifts].includes(shift)){inconsistent=true;continue;}
      const placements=[...offsets].map(([id,offset])=>({id,slot:offset+shift}));
      if(new Set(placements.map(p=>p.slot)).size!==placements.length||placements.some(p=>
        !Number.isInteger(p.slot)||p.slot<0||p.slot>=(complete?allowed.size:550)||!columns.get(p.id)!.has(p.slot%10))){inconsistent=true;continue;}
      result.push(placements);
    }
    // Separate components must not claim the same absolute slot.
    const counts=new Map<number,number>();for(const p of result.flat())counts.set(p.slot,(counts.get(p.slot)??0)+1);
    const placed=result.flatMap(component=>component.some(p=>counts.get(p.slot)!==1)?[]:component);
    // During capture, a partial connected set is not the entire inventory.
    // Only independent anchors locate it; no origin/gap inference from counts.
    if(!complete)return placed;
    // A fast four-row jump can leave a disconnected tail. Reconnect only if
    // every confirmed ID has an actual geometric receipt, all anchored parts
    // agree, and a component has exactly one possible non-overlapping placement.
    // Ambiguous gaps remain unknown; this never creates cards from a count.
    if(inconsistent||graph.size!==allowed.size||placed.length!==result.flat().length)return placed;
    const anchoredCount=placed.length,occupied=new Set(placed.map(p=>p.slot));
    let changed=true;
    while(changed) {
      changed=false;
      for(let i=unplaced.length-1;i>=0;i--) {
        const component=unplaced[i],last=Math.max(...component.map(p=>p.slot)),candidates:number[]=[];
        if(new Set(component.map(p=>p.slot)).size!==component.length)continue;
        for(let offset=0;offset+last<allowed.size;offset++) {
          if(component.every(p=>!occupied.has(p.slot+offset)&&columns.get(p.id)!.has((p.slot+offset)%10)&&
            anchors.every(a=>a.id!==p.id||a.slot===p.slot+offset)))candidates.push(offset);
          if(candidates.length>1)break;
        }
        if(candidates.length!==1)continue;
        for(const p of component){const value={id:p.id,slot:p.slot+candidates[0]};placed.push(value);occupied.add(value.slot);}
        unplaced.splice(i,1);changed=true;
      }
    }
    return unplaced.length?placed.slice(0,anchoredCount):placed;
  }
}
