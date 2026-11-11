/** DEV experiment: a bounded admission reservation, not a completion proof.
 * Its expiry must reopen capture even if an awaited OCR promise never settles. */
export class CompletionDrainReservation {
 private token=0;private current=0;private deadline=0;private timer:ReturnType<typeof setTimeout>|undefined;
 private readonly onRelease:(reason:'expired'|'invalidated'|'finished'|'disposed')=>void;private readonly timeoutMs:number;private readonly now:()=>number;
 constructor(onRelease:(reason:'expired'|'invalidated'|'finished'|'disposed')=>void,timeoutMs=1500,now:()=>number=()=>performance.now()) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>5000)throw TypeError('Invalid drain timeout');
  this.onRelease=onRelease;this.timeoutMs=timeoutMs;this.now=now;
 }
 get active(){return this.current!==0&&this.valid(this.current);}
 get id(){return this.active?this.current:0;}
 start():number {
  if(this.active)throw Error('Drain reservation already active');
  const at=this.now();if(!Number.isFinite(at))throw TypeError('Invalid drain clock');
  const id=++this.token;this.current=id;this.deadline=at+this.timeoutMs;
  this.timer=setTimeout(()=>{this.finish(id,'expired');},this.timeoutMs);
  return id;
 }
 valid(id:number){
  if(id<=0||this.current!==id)return false;
  const at=this.now();if(!Number.isFinite(at)||at>=this.deadline){this.finish(id,'expired');return false;}
  return true;
 }
 finish(id:number,reason:'expired'|'invalidated'|'finished'|'disposed'):boolean {
  if(id<=0||this.current!==id)return false;
  this.current=0;this.deadline=0;clearTimeout(this.timer);this.timer=undefined;this.onRelease(reason);return true;
 }
 dispose(){if(this.active)this.finish(this.current,'disposed');}
}
