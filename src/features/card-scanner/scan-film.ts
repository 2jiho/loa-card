import type {ScanActivityItem} from './scan-activity';

export const FILM_PITCH=78;
export const FILM_STEP_MS=240;

/** Bounded presentation queue, independent of scanner work. */
export class ScanFilm {
  private shown:ScanActivityItem[]=[];
  private pending:ScanActivityItem[]=[];
  private incoming:ScanActivityItem|null=null;
  private durationMs=FILM_STEP_MS;
  private seen=new Set<number>();
  ingest(items:ScanActivityItem[]){
    const latest=new Map(items.map(item=>[item.id,item]));
    this.shown=this.shown.map(item=>latest.get(item.id)??item);
    this.pending=this.pending.map(item=>latest.get(item.id)??item);
    if(this.incoming)this.incoming=latest.get(this.incoming.id)??this.incoming;
    for(const item of items){
      if(!this.seen.has(item.id))this.pending.push(item);
      this.seen.add(item.id);
    }
    this.pending=this.pending.slice(-16);
    this.seen=new Set([...this.seen].slice(-64));
  }
  prepare(capacity:number,reduced=false){
    capacity=Math.max(1,Math.min(16,capacity));
    if(reduced){
      this.shown=[...this.shown,...(this.incoming?[this.incoming]:[]),...this.pending].slice(-capacity);
      this.pending=[];this.incoming=null;
    }else{
      this.shown=this.shown.slice(-capacity);
      while(this.shown.length<capacity&&this.pending.length&&!this.incoming)this.shown.push(this.pending.shift()!);
      if(!this.incoming){
        // Choose speed only at the next tile boundary, never restart a move.
        this.durationMs=Math.max(100,FILM_STEP_MS-this.pending.length*12);
        this.incoming=this.pending.shift()??null;
      }
    }
    return this.snapshot();
  }
  complete(){
    if(this.incoming){this.shown=[...this.shown.slice(1),this.incoming];this.incoming=null;}
  }
  snapshot(){return {items:[...this.shown,...(this.incoming?[this.incoming]:[])],incomingId:this.incoming?.id??null,durationMs:this.durationMs};}
}
