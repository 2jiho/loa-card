/** A recovery input is not processed merely because its acquired frame was
 * linked to the input ID. Only a completed pass over its located card cells,
 * without a rejected queue admission, can acknowledge that input. This is
 * capture acceptance, not proof of card identity or final field values. */
export class CompletionDrainRecovery {
  private readonly started = new Set<number>();
  private readonly accepted = new Set<number>();

  start(inputId:number):void { this.started.add(inputId); }

  accept(inputId:number,cells:readonly {slot:number}[],expectedCells:number,allAdmitted:boolean):boolean {
    if(!this.started.has(inputId)||!Array.isArray(cells)||cells.length<1||
      !Number.isSafeInteger(expectedCells)||cells.length!==expectedCells||!allAdmitted)return false;
    for(let index=0;index<cells.length;index++)if(!cells[index]||cells[index].slot!==index)return false;
    this.accepted.add(inputId);
    return true;
  }

  /** An early return can report a successful pipeline call without accepting
   * the input. It must still create loss debt and block completion. */
  verified(inputId:number,outcome:'completed'|'error'):boolean {
    return outcome==='completed'&&this.started.has(inputId)&&this.accepted.has(inputId);
  }

  release(inputId:number):void { this.started.delete(inputId);this.accepted.delete(inputId); }
}
