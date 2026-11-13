/** The card list as a table of rows and columns (docs/scanner-live-redesign.md, section 13).
 *
 * The row-centred scan places every card it reads here. It is a pure state machine, so a live
 * scan and a replay of recorded observations go through the same code.
 *
 * Each frame says what the visible grid slots showed and where the scrollbar thumb was. The
 * table works out which rows of the whole list those were:
 *
 * - Frames that share cards are joined into an ISLAND, a run of rows whose order is known.
 * - An island gets its place in the list (an ANCHOR) only from a frame whose thumb had not moved
 *   for `settleMs`: the thumb moves before the cards do, so a moving thumb is not a position.
 *   A shorter rest counts when the frame also says the grid's content had not changed
 *   (`stillMs`): content unchanged for `stillSettleMs` and the thumb unchanged for
 *   `stillThumbMs`. Still content alone is never a position: when scrolling starts again the
 *   thumb moves a frame or two before the cards do.
 * - A frame that overlaps two islands joins them.
 *
 * The table never names a card: a slot's card comes from the reader, the table only places it.
 * A reading that finishes after its frame was observed names that frame's cell late (nameCell).
 * It never drops what it cannot place: islands without an anchor stay, as "floating" rows.
 * Whatever does not fit (a card seen at two positions, two anchors for one island, a slot that
 * changes its card) is counted and left as it was first recorded, never overwritten. */
export const SLOT_UNUSABLE=-1,SLOT_UNIDENTIFIED=-2,SLOT_EMPTY=-3;

export interface ListFrame {
  /** Capture time in seconds. */
  readonly time:number;
  /** Row of the list the thumb points at (0 = top), or null when the thumb was not read. */
  readonly thumbRow:number|null;
  /** Milliseconds since the thumb last moved, or null when unknown. */
  readonly settledMs:number|null;
  /** Milliseconds the grid's content had not changed (`createStillClock`), or null/absent when unknown. */
  readonly stillMs?:number|null;
  /** One code per visible slot, row by row: a card code (>= 0) or one of the SLOT_ constants. */
  readonly slots:readonly number[];
}
export type CellState='card'|'unidentified'|'empty';
export interface ListCell {
  readonly state:CellState;
  /** The card code when state is 'card'. */
  readonly card:number|null;
  /** Frames that showed this cell usable, and the first and latest capture time. */
  readonly looks:number;readonly firstTime:number;readonly lastTime:number;
}
export interface ListTableOptions {
  readonly columns?:number;readonly gridRows?:number;
  /** A thumb unchanged for this long is taken as the position of the cards (measured: 100% at 200 ms). */
  readonly settleMs?:number;
  /** With content unchanged for `stillSettleMs`, a thumb unchanged for `stillThumbMs` is taken as
   * the position too (measured on six recordings: 296 of 296 frames agreed with the rows fixed by
   * `settleMs`, and no island got two positions; the thumb alone at 100 ms did give one). */
  readonly stillSettleMs?:number;readonly stillThumbMs?:number;
  /** Shared cards a frame needs with an island to join it. */
  readonly minOverlap?:number;
  /** Rows a moving thumb may be away from an anchored frame before it is counted as suspicious. */
  readonly maxLead?:number;
}
export interface FramePlacement {
  /** How the frame was placed: by a settled thumb, by cards shared with known rows, as the
   * start of a new island, or not at all (nothing usable to place). */
  readonly basis:'thumb'|'overlap'|'new'|'none';
  /** List row of the frame's top grid row, when its island is anchored. */
  readonly top:number|null;
}
export interface ListTableSnapshot {
  /** Anchored rows, by list row: `columns` cells each (null = never seen usable). */
  readonly rows:ReadonlyMap<number,readonly (ListCell|null)[]>;
  /** Islands without an anchor: their rows are in order, but where in the list is unknown. */
  readonly floating:readonly {readonly rows:number;readonly cards:number;readonly frames:number;
    /** Where the island probably is: the list row of its first row by the most common MOVING thumb
     * reading (a clear majority of at least three frames), else null. A hint for guidance only:
     * a moving thumb is ahead of the cards in about a quarter of the frames. */
    readonly likelyTop:number|null;readonly hintFrames:number;readonly hintTotal:number;
    /** The island's rows in order, `columns` cells each. */
    readonly cells:readonly (readonly (ListCell|null)[])[]}[];
  readonly counts:{
    readonly frames:number;readonly placedByThumb:number;readonly placedByOverlap:number;readonly started:number;readonly unplaced:number;
    readonly merges:number;
    /** A frame's shared cards disagreed about its row inside one island. */
    readonly overlapConflicts:number;
    /** A settled thumb disagreed with the anchor an island already had, or two anchored islands met out of place. */
    readonly anchorConflicts:number;
    /** A cell showed a different card (or a card where an empty slot was) than first recorded. */
    readonly cellConflicts:number;
    /** A moving thumb was further than `maxLead` rows from an anchored frame. */
    readonly leadViolations:number;
  };
}

interface Cell {state:CellState;card:number|null;looks:number;firstTime:number;lastTime:number}
interface Island {id:number;anchor:number|null;frames:number;cells:Map<number,Cell>;
  /** Moving-thumb readings: (thumb row - island row of the frame top) -> frames. Not an anchor. */
  hints:Map<number,number>}

export function createListTable(options:ListTableOptions={}) {
  const columns=options.columns??10,gridRows=options.gridRows??4,settleMs=options.settleMs??200;
  const stillSettleMs=options.stillSettleMs??100,stillThumbMs=options.stillThumbMs??100;
  const minOverlap=options.minOverlap??3,maxLead=options.maxLead??2;
  if(![columns,gridRows].every(value=>Number.isSafeInteger(value)&&value>0))throw new RangeError('Invalid grid');
  const islands=new Map<number,Island>();
  /** Where each card code was first placed: island and island-relative row and column. */
  const place=new Map<number,{island:number;row:number;column:number}>();
  let nextIsland=0;
  const counts={frames:0,placedByThumb:0,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0};
  const key=(row:number,column:number)=>row*columns+column;

  /** Move every row of `from` into `into`; a row r of `from` is row r + delta of `into`. */
  function merge(into:Island,from:Island,delta:number):void {
    if(from.anchor!==null){
      // The same list row: from.anchor + r = into.anchor + r + delta.
      if(into.anchor===null)into.anchor=from.anchor-delta;
      else if(into.anchor+delta!==from.anchor)counts.anchorConflicts++;
    }
    for(const [index,cell] of from.cells){
      const row=Math.floor(index/columns)+delta,column=((index%columns)+columns)%columns;
      writeCell(into,row,column,cell);
    }
    for(const [offset,count] of from.hints)into.hints.set(offset-delta,(into.hints.get(offset-delta)??0)+count);
    for(const item of place.values())if(item.island===from.id){item.island=into.id;item.row+=delta;}
    into.frames+=from.frames;islands.delete(from.id);counts.merges++;
  }
  function writeCell(island:Island,row:number,column:number,seen:Cell):void {
    const index=key(row,column),known=island.cells.get(index);
    if(!known){island.cells.set(index,{...seen});return;}
    if(known.state!==seen.state||known.card!==seen.card){
      // An unidentified card may be named by a later frame; anything else is kept as first recorded.
      if(known.state==='unidentified'&&seen.state==='card'){known.state='card';known.card=seen.card;}
      else if(!(known.state==='card'&&seen.state==='unidentified'))counts.cellConflicts++;
    }
    known.looks+=seen.looks;known.firstTime=Math.min(known.firstTime,seen.firstTime);known.lastTime=Math.max(known.lastTime,seen.lastTime);
  }

  function observe(frame:ListFrame):FramePlacement {
    if(frame.slots.length!==columns*gridRows)throw new RangeError('A frame must have one code per grid slot');
    counts.frames++;
    // Votes of the cards already placed: island -> row this frame's top would have there -> cards.
    const votes=new Map<number,Map<number,number>>();
    frame.slots.forEach((code,slot)=>{
      const known=code>=0?place.get(code):undefined;
      if(!known||known.column!==slot%columns)return;
      const rows=votes.get(known.island)??new Map<number,number>();
      const candidate=known.row-Math.floor(slot/columns);
      rows.set(candidate,(rows.get(candidate)??0)+1);votes.set(known.island,rows);
    });
    const agreed:{island:Island;row:number;count:number}[]=[];
    for(const [id,rows] of votes){
      if(rows.size>1){counts.overlapConflicts++;continue;}          // the island's cards disagree: not a placement
      const [row,count]=[...rows][0];
      if(count>=minOverlap)agreed.push({island:islands.get(id)!,row,count});
    }
    agreed.sort((a,b)=>b.count-a.count);
    const usable=frame.slots.some(code=>code!==SLOT_UNUSABLE);
    const settled=frame.thumbRow!==null&&frame.settledMs!==null&&(frame.settledMs>=settleMs||
      (typeof frame.stillMs==='number'&&frame.stillMs>=stillSettleMs&&frame.settledMs>=stillThumbMs));
    let island:Island,top:number,basis:FramePlacement['basis'];
    if(agreed.length){
      island=agreed[0].island;top=agreed[0].row;basis='overlap';
      for(const other of agreed.slice(1))merge(island,other.island,top-other.row);
    }else if(usable&&(settled||frame.slots.some(code=>code>=0))){
      island={id:nextIsland++,anchor:null,frames:0,cells:new Map(),hints:new Map()};islands.set(island.id,island);
      top=0;basis='new';counts.started++;
    }else{counts.unplaced++;return {basis:'none',top:null};}
    if(settled){
      const anchor=frame.thumbRow!-top;
      if(island.anchor===null){
        // Another island may already sit at these list rows: they are the same rows.
        const same=[...islands.values()].find(other=>other!==island&&other.anchor!==null);
        island.anchor=anchor;
        if(same){
          const delta=anchor-same.anchor!;
          merge(same,island,delta);island=same;top+=delta;
        }
      }else if(island.anchor!==anchor)counts.anchorConflicts++;
      if(basis!=='overlap')basis='thumb';
    }else if(frame.thumbRow!==null){
      if(island.anchor!==null&&Math.abs(island.anchor+top-frame.thumbRow)>maxLead)counts.leadViolations++;
      island.hints.set(frame.thumbRow-top,(island.hints.get(frame.thumbRow-top)??0)+1);
    }
    if(basis==='thumb')counts.placedByThumb++;else if(basis==='overlap')counts.placedByOverlap++;
    island.frames++;
    frame.slots.forEach((code,slot)=>{
      if(code===SLOT_UNUSABLE)return;
      const row=top+Math.floor(slot/columns),column=slot%columns;
      const state:CellState=code>=0?'card':code===SLOT_EMPTY?'empty':'unidentified';
      if(code>=0){
        const known=place.get(code);
        if(!known)place.set(code,{island:island.id,row,column});
        // Too few shared cards to join that island yet: the cell is still recorded here, and the
        // two islands are compared cell by cell if a later frame joins them.
        else if(known.island===island.id&&(known.row!==row||known.column!==column)){counts.cellConflicts++;return;}
      }
      writeCell(island,row,column,{state,card:code>=0?code:null,looks:1,firstTime:frame.time,lastTime:frame.time});
    });
    return {basis,top:island.anchor===null?null:island.anchor+top};
  }

  function snapshot():ListTableSnapshot {
    const rows=new Map<number,(ListCell|null)[]>();
    const floating:ListTableSnapshot['floating'][number][]=[];
    for(const island of islands.values()){
      let anchor=island.anchor;
      if(anchor===null){
        // The most common moving-thumb reading, when it is a clear majority of at least three frames.
        const hints=[...island.hints].sort((a,b)=>b[1]-a[1]),total=hints.reduce((sum,item)=>sum+item[1],0);
        const guess=hints.length&&hints[0][1]>=3&&hints[0][1]*2>total?hints[0][0]:null;
        const islandRows=[...new Set([...island.cells.keys()].map(index=>Math.floor(index/columns)))].sort((a,b)=>a-b);
        floating.push({rows:islandRows.length,cards:[...island.cells.values()].filter(cell=>cell.state==='card').length,frames:island.frames,
          likelyTop:guess===null||!islandRows.length?null:guess+islandRows[0],hintFrames:hints[0]?.[1]??0,hintTotal:total,
          cells:islandRows.map(row=>Array.from({length:columns},(_,column)=>{const cell=island.cells.get(key(row,column));return cell?{...cell}:null;}))});
        continue;
      }
      for(const [index,cell] of island.cells){
        const row=Math.floor(index/columns)+anchor,column=((index%columns)+columns)%columns;
        let cells=rows.get(row);
        if(!cells){cells=Array<ListCell|null>(columns).fill(null);rows.set(row,cells);}
        cells[column]={...cell};
      }
    }
    return {rows:new Map([...rows].sort((a,b)=>a[0]-b[0])),floating,counts:{...counts}};
  }
  /** Where a card was placed: an island (its id changes when islands join) and the row and
   * column inside it. Null for a card not placed yet. */
  function locate(card:number):{readonly island:number;readonly row:number;readonly column:number}|null {
    const known=place.get(card);
    return known?{island:known.island,row:known.row,column:known.column}:null;
  }
  /** What a cell of an island held when last recorded; null when it was never seen usable. */
  function cellAt(island:number,row:number,column:number):ListCell|null {
    const cell=islands.get(island)?.cells.get(key(row,column));
    return cell?{...cell}:null;
  }
  /** Name a cell a frame recorded as unidentified, for a reader that named that frame's crop only
   * after the frame was observed (a slow reading beside the frame loop). The card still comes
   * from the reader and from that frame; the table only places it, late. Nothing else is ever
   * changed this way: a cell that is missing, empty or already a card stays as it is, and a card
   * the island already has somewhere else is counted as a conflict and not written. Returns
   * whether the cell was named. */
  function nameCell(island:number,row:number,column:number,card:number,time:number):boolean {
    if(!Number.isSafeInteger(card)||card<0)throw new RangeError('Invalid card code');
    const cell=islands.get(island)?.cells.get(key(row,column));
    if(!cell||cell.state!=='unidentified')return false;
    const known=place.get(card);
    if(known&&known.island===island&&(known.row!==row||known.column!==column)){counts.cellConflicts++;return false;}
    if(!known)place.set(card,{island,row,column});
    cell.state='card';cell.card=card;cell.lastTime=Math.max(cell.lastTime,time);
    return true;
  }
  return {observe,snapshot,locate,cellAt,nameCell};
}

/** The number of scroll steps of the list, read from thumb positions (0..1): the smallest count
 * for which every position lands on a whole step. Null when the positions do not decide it
 * (too few distinct ones, or none fits). The list then has `steps + visible rows` rows. */
export function estimateScrollSteps(positions:readonly number[],options:{min?:number;max?:number;tolerance?:number;minDistinct?:number}={}):number|null {
  const min=options.min??4,max=options.max??400,tolerance=options.tolerance??.2,minDistinct=options.minDistinct??6;
  const distinct=[...new Set(positions.filter(value=>Number.isFinite(value)&&value>=0&&value<=1).map(value=>Math.round(value*1e4)/1e4))].sort((a,b)=>a-b);
  if(distinct.length<minDistinct)return null;
  // Readings of one resting place differ by a pixel; a count fits when every reading is near a
  // whole step and the readings cover at least `minDistinct` different steps.
  for(let steps=min;steps<=max;steps++){
    if(!distinct.every(value=>Math.abs(value*steps-Math.round(value*steps))<=tolerance))continue;
    if(new Set(distinct.map(value=>Math.round(value*steps))).size>=minDistinct)return steps;
  }
  return null;
}

/** How long the grid's content has not changed, fed one frame at a time.
 *
 * Each frame gives one key per visible slot (undefined for a slot that was not usable): equal keys
 * mean the same pixels (the acquisition's field revision). A frame continues a still run when at
 * least `minSlots` slots were usable and `share` of them have the key the same slot had in the
 * frame before; the run's length is capture time since the frame before the run's first frame.
 * A frame that does not continue it gives 0. */
export function createStillClock(options:{minSlots?:number;share?:number}={}) {
  const minSlots=options.minSlots??10,share=options.share??.8;
  let previous:readonly (string|undefined)[]|null=null,previousTime=0,since:number|null=null;
  return (time:number,keys:readonly (string|undefined)[]):number=>{
    let usable=0,same=0;
    if(previous)keys.forEach((key,slot)=>{if(key===undefined)return;usable++;if(previous![slot]===key)same++;});
    if(usable>=minSlots&&same>=usable*share)since??=previousTime;else since=null;
    previous=[...keys];previousTime=time;
    return since===null?0:Math.max(0,Math.round((time-since)*1000));
  };
}
