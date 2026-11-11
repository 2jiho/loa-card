/** Development analysis (docs/dev-recording.md, "줄 중심 설계의 타당성 측정"). Not a scanner.
 *
 * Input: for every frame with a card window, what each of the 40 grid slots showed
 * (a card id, an unidentified card, an empty slot, or nothing usable) and where the scrollbar
 * thumb was. Output: answers to two questions about a row-centred design.
 *
 * 1. Can the scrollbar alone say which rows of the whole list a frame shows? The reference is
 *    built without the scrollbar: frames are chained by the cards they share, which gives every
 *    frame the list row of its top grid row.
 * 2. How often was each list row shown cleanly (every slot usable), and at rest (the same
 *    pixels as the frame before)? A row never shown cleanly cannot be read by any design.
 *
 * The reference rows come from program output (artwork identification), not from a person. */
export const COLUMNS=10,GRID_ROWS=4;
/** Slot codes below zero; zero and above is an index into the card id table. */
export const UNUSABLE=-1,UNIDENTIFIED=-2,EMPTY=-3;
export interface RowFrame {
  readonly time:number;
  /** Scrollbar thumb position 0..1 and thumb size relative to its travel; null when unread. */
  readonly position:number|null;readonly pageSpan:number|null;
  /** 40 slot codes, row by row. */
  readonly slots:readonly number[];
  /** 40 pixel identities (equal numbers mean equal crop pixels); -1 without a crop. */
  readonly keys:readonly number[];
}
export interface RowAnalysis {
  readonly frames:number;
  /** Frames given a list row / chains of frames linked by shared cards that stayed apart (a
   * jump of four rows or more starts a chain; a later frame that overlaps two chains joins them;
   * the scrollbar places each remaining chain in the list). */
  readonly placedFrames:number;readonly segments:number;
  /** Shared-card votes that disagreed about a frame's row inside one chain. */
  readonly conflicts:number;
  /** Sightings of a card at a list position other than its first one: chains placed by the
   * scrollbar that do not agree with each other. */
  readonly crossConflicts:number;
  readonly listRows:number;readonly cards:number;
  readonly scrollbar:{
    /** Chained frames that also have a scrollbar reading. */
    readonly frames:number;
    /** List rows implied by the thumb size (4 visible rows / thumb share), median over frames. */
    readonly rowsFromThumb:number|null;
    /** Scrollbar-only top row against each chain (one constant offset per chain): share exactly
     * right, share within one row, and the largest error in rows. */
    readonly exact:number;readonly withinOne:number;readonly maxError:number;
    /** Frames whose grid was between rows by the scrollbar (fraction of a row from a whole row > 0.25). */
    readonly betweenRows:number;
    /** Thumb row minus the row the cards show, per frame (positive: the thumb is further down). */
    readonly lead:readonly {readonly rows:number;readonly frames:number}[];
    /** Agreement by the time since the thumb last moved (untilMs null: longer than the last limit). */
    readonly bySettle:readonly {readonly untilMs:number|null;readonly frames:number;readonly exact:number}[];
  };
  readonly rows:readonly {readonly row:number;readonly shown:number;readonly clean:number;readonly rest:number;readonly firstCleanTime:number|null;
    /** Identified cards placed in this row. */
    readonly cards:number}[];
  readonly rowSummary:{readonly neverClean:readonly number[];readonly neverRest:readonly number[];readonly cleanOnce:readonly number[];
    readonly medianClean:number;readonly minClean:number};
  /** Per card: the list position the chain gave it and how many frames showed its slot usable. */
  readonly cardLooks:readonly {readonly id:number;readonly row:number;readonly column:number;readonly looks:number}[];
}

const median=(values:readonly number[])=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor((sorted.length-1)/2)]:0;};

/** `listRows`: the number of rows of the whole list when it is known (the game's card list has a
 * fixed number of rows); without it the thumb size is used, which is only an estimate. */
export function analyzeRows(frames:readonly RowFrame[],listRows?:number):RowAnalysis {
  // --- 1. Chain frames by shared cards: the list row of each frame's top grid row.
  // A frame that shares cards with two chains joins them (a jump left them apart; scrolling
  // back over the gap connects them). Only votes that disagree about the row inside ONE chain
  // are conflicts.
  const place=new Map<number,{row:number;column:number;segment:number}>();
  const top:(number|null)[]=[],segmentOf:number[]=[];
  let created=0,merged=0,conflicts=0,nextBase=0;
  frames.forEach((frame,index)=>{
    const votes=new Map<number,Map<number,number>>();   // chain -> candidate top row -> votes
    frame.slots.forEach((code,slot)=>{
      const known=code>=0?place.get(code):undefined;
      if(!known)return;
      const rows=votes.get(known.segment)??new Map<number,number>();
      const candidate=known.row-Math.floor(slot/COLUMNS);
      rows.set(candidate,(rows.get(candidate)??0)+1);votes.set(known.segment,rows);
    });
    let segment:number,row:number;
    if(votes.size){
      const perChain=[...votes].map(([chain,rows])=>{
        const sorted=[...rows].sort((x,y)=>y[1]-x[1]);
        conflicts+=sorted.slice(1).reduce((total,item)=>total+item[1],0);
        return {chain,row:sorted[0][0],count:sorted[0][1]};
      }).sort((x,y)=>y.count-x.count);
      segment=perChain[0].chain;row=perChain[0].row;
      for(const other of perChain.slice(1)){
        // The same frame top is `row` in the winning chain and `other.row` in this one.
        const delta=row-other.row;
        for(const item of place.values())if(item.segment===other.chain){item.segment=segment;item.row+=delta;}
        for(let earlier=0;earlier<index;earlier++)if(segmentOf[earlier]===other.chain){segmentOf[earlier]=segment;top[earlier]=top[earlier]!+delta;}
        merged++;
      }
    }else if(frame.slots.some(code=>code>=0)){
      // Nothing shared with what was seen before: a new chain, placed far from the others.
      segment=created++;row=nextBase;nextBase+=1000;
    }else{top[index]=null;segmentOf[index]=-1;return;}
    top[index]=row;segmentOf[index]=segment;
    frame.slots.forEach((code,slot)=>{
      if(code<0)return;
      const here={row:row+Math.floor(slot/COLUMNS),column:slot%COLUMNS,segment};
      const known=place.get(code);
      if(!known)place.set(code,here);
      else if(known.row!==here.row||known.column!==here.column)conflicts++;
    });
  });
  const segments=created-merged;
  // --- 2. Scrollbar against the chains. Each chain is placed in the list by the scrollbar with
  // one constant offset, taken from frames whose thumb had not moved for a while (the thumb
  // moves before the cards do), and the scrollbar is then judged on every frame.
  const SETTLED_MS=300;
  let lastChange=-Infinity,previousPosition:number|null=null;
  const sinceChange=frames.map(frame=>{
    if(frame.position===null)return null;
    if(previousPosition===null||Math.abs(frame.position-previousPosition)>1e-6){lastChange=frame.time;previousPosition=frame.position;}
    return (frame.time-lastChange)*1000;
  });
  const readings=frames.map((frame,index)=>top[index]!==null&&frame.position!==null&&frame.pageSpan!==null&&frame.pageSpan>0?
    {index,segment:segmentOf[index],row:top[index]!,position:frame.position,span:frame.pageSpan,settledMs:sinceChange[index]!}:null).filter(item=>item!==null);
  const rowsFromThumb=readings.length?median(readings.map(item=>GRID_ROWS+GRID_ROWS/item.span)):null;
  const travel=listRows!==undefined?listRows-GRID_ROWS:rowsFromThumb===null?0:Math.round(rowsFromThumb)-GRID_ROWS;
  const offsets=new Map<number,number>();
  for(const segment of new Set(readings.map(item=>item.segment))){
    const own=readings.filter(item=>item.segment===segment),settled=own.filter(item=>item.settledMs>=SETTLED_MS);
    offsets.set(segment,median((settled.length?settled:own).map(item=>item.row-Math.round(item.position*travel))));
  }
  const listTop=(index:number)=>{
    const offset=top[index]===null?undefined:offsets.get(segmentOf[index]);
    return offset===undefined?null:top[index]!-offset;
  };
  let exact=0,withinOne=0,maxError=0,betweenRows=0;
  // Thumb row minus the row the cards show (positive: the thumb is further down the list),
  // and how often they agree by the time since the thumb last moved.
  const lead=new Map<number,number>();
  const bySettle=[50,100,200,400,Infinity].map(untilMs=>({untilMs:Number.isFinite(untilMs)?untilMs:null as number|null,frames:0,exact:0}));
  for(const item of readings){
    const raw=item.position*travel,difference=Math.round(raw)-(item.row-offsets.get(item.segment)!),error=Math.abs(difference);
    if(error===0)exact++;if(error<=1)withinOne++;maxError=Math.max(maxError,error);
    if(Math.abs(raw-Math.round(raw))>.25)betweenRows++;
    lead.set(difference,(lead.get(difference)??0)+1);
    const bucket=bySettle.find(entry=>entry.untilMs===null||item.settledMs<entry.untilMs)!;
    bucket.frames++;if(error===0)bucket.exact++;
  }
  // Cards the chains place at different list positions: the scrollbar disagreed across a jump.
  const listPlace=new Map<number,{row:number;column:number}>();
  let crossConflicts=0;
  frames.forEach((frame,index)=>{
    const row=listTop(index);if(row===null)return;
    frame.slots.forEach((code,slot)=>{
      if(code<0)return;
      const here={row:row+Math.floor(slot/COLUMNS),column:slot%COLUMNS},known=listPlace.get(code);
      if(!known)listPlace.set(code,here);
      else if(known.row!==here.row||known.column!==here.column)crossConflicts++;
    });
  });
  const placed=frames.filter((_,index)=>listTop(index)!==null).length;
  const firstRow=Math.min(0,...[...listPlace.values()].map(item=>item.row));
  const lastRow=Math.max(-1,...[...listPlace.values()].map(item=>item.row));

  // --- 3. How often each list row was shown cleanly and at rest.
  const rows=Array.from({length:lastRow-firstRow+1},(_,index)=>({row:index+firstRow,shown:0,clean:0,rest:0,firstCleanTime:null as number|null,cards:0}));
  for(const item of listPlace.values())rows[item.row-firstRow].cards++;
  const looks=new Map<number,number>();
  frames.forEach((frame,index)=>{
    const row=listTop(index);
    frame.slots.forEach(code=>{if(code>=0)looks.set(code,(looks.get(code)??0)+1);});
    if(row===null)return;
    const previous=index>0&&listTop(index-1)===row?frames[index-1]:undefined;
    for(let grid=0;grid<GRID_ROWS;grid++){
      const entry=rows[row+grid-firstRow];if(!entry)continue;
      const slots=frame.slots.slice(grid*COLUMNS,(grid+1)*COLUMNS);
      entry.shown++;
      if(slots.some(code=>code===UNUSABLE))continue;
      entry.clean++;entry.firstCleanTime??=frame.time;
      const keys=frame.keys.slice(grid*COLUMNS,(grid+1)*COLUMNS);
      if(previous&&keys.every((key,column)=>key===previous.keys[grid*COLUMNS+column]))entry.rest++;
    }
  });
  const cleanCounts=rows.map(row=>row.clean);
  return {
    frames:frames.length,placedFrames:placed,segments,conflicts,crossConflicts,listRows:rows.length,cards:listPlace.size,
    scrollbar:{frames:readings.length,rowsFromThumb:rowsFromThumb===null?null:Math.round(rowsFromThumb*100)/100,
      exact:readings.length?exact/readings.length:0,withinOne:readings.length?withinOne/readings.length:0,maxError,betweenRows,
      lead:[...lead].sort((x,y)=>x[0]-y[0]).map(([rows,count])=>({rows,frames:count})),bySettle},
    rows,
    rowSummary:{neverClean:rows.filter(row=>!row.clean).map(row=>row.row),neverRest:rows.filter(row=>!row.rest).map(row=>row.row),
      cleanOnce:rows.filter(row=>row.clean===1).map(row=>row.row),medianClean:median(cleanCounts),minClean:cleanCounts.length?Math.min(...cleanCounts):0},
    cardLooks:[...listPlace].map(([id,item])=>({id,row:item.row,column:item.column,looks:looks.get(id)??0}))
      .sort((a,b)=>a.row-b.row||a.column-b.column),
  };
}
