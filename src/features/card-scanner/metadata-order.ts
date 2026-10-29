import type {CardSort,SortKind} from './capture-metadata';

export interface ScanMetadata {
  growthPoints:{current:number;maximum:number|null}|null;
  sort:CardSort|null;
}
export interface CapturedMetadata {
  /** Immutable source time captured when this OCR operation starts. */
  time:number;
  reading:Promise<ScanMetadata>;
}

/** Each field keeps its own latest successful source time. A newer failed
 * field cannot prevent an older valid fallback, or advance another field. */
export class MetadataOrder {
  private growthTime=-Infinity;
  private kindTime=-Infinity;
  private sort:CardSort|null=null;
  private kinds=new Map<SortKind,{time:number;directionTime:number;direction:CardSort['direction']}>();

  private acceptSort(time:number,value:CardSort):CardSort|null {
    const entry=this.kinds.get(value.kind)??{time:-Infinity,directionTime:-Infinity,direction:'unknown'};
    entry.time=Math.max(entry.time,time);
    if(value.direction!=='unknown'&&time>=entry.directionTime) {
      entry.directionTime=time;entry.direction=value.direction;
    }
    this.kinds.set(value.kind,entry);
    const kind=!this.sort||time>=this.kindTime?value.kind:this.sort.kind;
    this.kindTime=Math.max(this.kindTime,time);
    const current=this.kinds.get(kind)!;
    // A missing arrow can use an older direction of the same kind, but never
    // carry it across an intervening different sort. At most five kinds exist.
    let changedKindAt=-Infinity;
    for(const [other,observation] of this.kinds)if(other!==kind)changedKindAt=Math.max(changedKindAt,observation.time);
    const next:CardSort={kind,direction:current.directionTime>changedKindAt?current.direction:'unknown'};
    if(this.sort?.kind===next.kind&&this.sort.direction===next.direction)return null;
    this.sort=next;
    return next;
  }

  accept(time:number,value:ScanMetadata):ScanMetadata {
    const accepted:ScanMetadata={growthPoints:null,sort:null};
    if(!Number.isFinite(time))return accepted;
    if(value.growthPoints!==null&&time>=this.growthTime) {
      accepted.growthPoints=value.growthPoints;this.growthTime=time;
    }
    if(value.sort!==null)accepted.sort=this.acceptSort(time,value.sort);
    return accepted;
  }
}

/** Unknown is emitted only when sort history invalidates a retained direction,
 * not for a transient missing arrow. Learning a direction still keeps positions. */
export function metadataSortChanged(current:CardSort|null,next:CardSort|null):boolean {
  return !!current&&!!next&&(current.kind!==next.kind||current.direction!=='unknown'&&current.direction!==next.direction);
}
