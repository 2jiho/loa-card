/** Display-only active OCR/visual reading count. A scheduler lane can remain
 * occupied for non-reading work (such as a preview) without claiming the
 * card is still being read. This counter never gates work or completion. */
export class ActiveReadingCounter {
  private count=0;
  get active(){return this.count;}
  begin(){
    let phase:'active'|'paused'|'finished'='active';this.count++;
    return {
      pause:()=>{if(phase==='active'){phase='paused';this.count--;}},
      resume:()=>{if(phase==='paused'){phase='active';this.count++;}},
      finish:()=>{if(phase==='active')this.count--;phase='finished';},
    };
  }
}
