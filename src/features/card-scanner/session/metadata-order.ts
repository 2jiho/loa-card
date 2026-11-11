import type {CardSort} from '../recognition/capture-metadata';

export interface ScanMetadata {
  growthPoints:{current:number;maximum:number|null}|null;
  sort:CardSort|null;
}
export interface AcceptedMetadata extends ScanMetadata {
  /** A newer failed sort reading removes previously retained sort knowledge. */
  sortInvalidated?:true;
}
export interface CapturedMetadata {
  /** Immutable source time captured when this OCR operation starts. */
  time:number;
  /** Acquisition order disambiguates distinct inputs with the same time. */
  sourceOrder:number;
  reading:Promise<ScanMetadata>;
}

/** Growth keeps its latest successful source time. Sort failures invalidate
 * older sort knowledge without affecting the independent growth field. */
export class MetadataOrder {
  private growthTime=-Infinity;
  private growthOrder=-1;
  private sortTime=-Infinity;
  private sortOrder=-1;
  // An unlocated input with an invalid time cannot be compared by time. Its
  // acquisition order still fences older asynchronous sort results.
  private unavailableOrder=-1;
  private sort:CardSort|null=null;

  private acceptSort(time:number,value:CardSort,sourceOrder:number):CardSort|null {
    if(sourceOrder<=this.unavailableOrder)return null;
    if(time<this.sortTime||time===this.sortTime&&sourceOrder<this.sortOrder)return null;
    // A direction observed in an older frame does not prove the current
    // direction. Preserve a known reading only for the exact same timestamp.
    if(time===this.sortTime&&sourceOrder===this.sortOrder&&this.sort?.kind===value.kind&&
      this.sort.direction!=='unknown'&&value.direction==='unknown')return null;
    const next:CardSort={kind:value.kind,direction:value.direction};
    this.sortTime=time;this.sortOrder=sourceOrder;
    if(this.sort?.kind===next.kind&&this.sort.direction===next.direction)return null;
    this.sort=next;
    return next;
  }

  invalidateSortWithoutTime(sourceOrder:number):AcceptedMetadata {
    const result:AcceptedMetadata={growthPoints:null,sort:null};
    if(!Number.isSafeInteger(sourceOrder)||sourceOrder<0||sourceOrder<this.sortOrder||sourceOrder<=this.unavailableOrder)return result;
    this.unavailableOrder=Math.max(this.unavailableOrder,sourceOrder);
    if(this.sort){this.sort=null;result.sortInvalidated=true;}
    return result;
  }

  /** A lost view with an unusable or regressing clock cannot establish a
   * timestamp ordering. Fence earlier sources by acquisition order instead. */
  invalidateUnlocatedSort(time:number,sourceOrder:number):AcceptedMetadata {
    if(!Number.isFinite(time)||time<0||time<this.sortTime)return this.invalidateSortWithoutTime(sourceOrder);
    return this.accept(time,{growthPoints:null,sort:null},sourceOrder);
  }

  accept(time:number,value:ScanMetadata,sourceOrder=0):AcceptedMetadata {
    const accepted:AcceptedMetadata={growthPoints:null,sort:null};
    if(!Number.isFinite(time)||!Number.isSafeInteger(sourceOrder)||sourceOrder<0)return accepted;
    if(value.growthPoints!==null&&(time>this.growthTime||time===this.growthTime&&sourceOrder>=this.growthOrder)) {
      accepted.growthPoints=value.growthPoints;this.growthTime=time;this.growthOrder=sourceOrder;
    }
    if(value.sort!==null)accepted.sort=this.acceptSort(time,value.sort,sourceOrder);
    else if(sourceOrder>this.unavailableOrder&&(time>this.sortTime||time===this.sortTime&&sourceOrder>=this.sortOrder)){
      this.sortTime=time;this.sortOrder=sourceOrder;
      if(this.sort){this.sort=null;accepted.sortInvalidated=true;}
    }
    return accepted;
  }
}

/** Positions collected across an unknown direction must not be reused as if
 * the direction were unchanged. This guard affects placement, not card proof. */
export function metadataSortChanged(current:CardSort|null,next:CardSort|null):boolean {
  return !!next&&(!current||current.kind!==next.kind||current.direction!==next.direction);
}
