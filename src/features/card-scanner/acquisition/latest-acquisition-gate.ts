/** A newer located header cannot certify a frame whose card acquisition was
 * skipped or rejected. A later complete acquisition can clear that debt. */
export class LatestAcquisitionGate {
  private frame=0;
  private complete=false;
  begin(frame:number):void {
    if(!Number.isSafeInteger(frame)||frame<=this.frame)throw new TypeError('Invalid acquisition frame');
    this.frame=frame;this.complete=false;
  }
  finish(frame:number,complete:boolean):void {
    if(!Number.isSafeInteger(frame)||typeof complete!=='boolean')throw new TypeError('Invalid acquisition result');
    // An older completion cannot clear a newer pending frame.
    if(frame===this.frame)this.complete=complete;
  }
  get settled():boolean{return this.complete;}
}
