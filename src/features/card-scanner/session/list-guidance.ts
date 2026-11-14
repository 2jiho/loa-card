import type {ListTableSnapshot} from './list-table';

/** What to show the list again for, worked out from the list table (docs/scanner-pipeline.md,
 * sections 4 and 7).
 *
 * The row-centred scan's guidance and progress-window map. It is a pure function of the table's
 * snapshot and of which cards are still unconfirmed, so a live scan and a replay give the same
 * guidance.
 *
 * It only reports what the table knows. A row number is given only for rows the table has
 * anchored (a frame whose scrollbar thumb had rested); rows of an island without an anchor are
 * counted, never numbered, and while such rows exist the rows missing from the anchored part are
 * not claimed to be unseen (they may be those rows). It names no card and fills no value: a cell
 * that was never read stays "not read", whatever its neighbours are. */
export interface ListGuidance {
  /** Runs of list rows (0 = top, inclusive) with no anchored cell. */
  readonly missingRows:readonly {readonly from:number;readonly to:number}[];
  /** Whether `missingRows` are known to be unseen: no rows are waiting for an anchor. */
  readonly missingRowsUnseen:boolean;
  /** Rows placed in the table (seen), in runs. */
  readonly seenRows?:readonly {readonly from:number;readonly to:number}[];
  /** Rows of islands without an anchor, at their likely place (moving-thumb majority), in runs.
   * A hint for the map only: never where a card is. */
  readonly likelyRows?:readonly {readonly from:number;readonly to:number}[];
  /** The first anchored row that showed an empty slot (a slot with no owned card), or null. Rows
   * after it were seen to start holding no cards; whether the rest of the list is empty too is
   * not known from the table. */
  readonly emptyFromRow:number|null;
  /** Disagreements the table counted (shared cards placing a frame at two rows, two positions for
   * one piece, a cell showing another card than first recorded). The table keeps what it recorded
   * first, so a row number given here may be off when this is not 0. */
  readonly conflicts:number;
  /** Separate pieces the list was read in: runs of anchored rows next to each other, plus islands
   * without an anchor. More than one means there are places where continuity was not seen. */
  readonly pieces:number;
  /** Rows seen but not placed in the list yet (the thumb never rested on them), and what they hold. */
  readonly unplaced:{readonly islands:number;readonly rows:number;readonly cards:number;
    /** Cells in those rows that were seen but could not be named, or never usable beside seen cells. */
    readonly unidentified:number;readonly unread:number};
  /** Anchored cells to show again: seen but not named, or never usable in a row that was seen. */
  readonly cells:readonly {readonly row:number;readonly column:number;readonly kind:'unidentified'|'unread'}[];
  /** Cards whose values are not confirmed, with their place when the table has anchored it. */
  readonly cards:readonly {readonly code:number;readonly name:string;readonly reasons:readonly string[];
    readonly row:number|null;readonly column:number|null}[];
  /** From the header, when read: rows holding cards, and rows holding slots (the rest are locked). */
  readonly cardRows?:number;readonly slotRows?:number;
}

export function listGuidance(snapshot:ListTableSnapshot,options:{
  /** Rows of the whole list (scroll steps + visible rows). */
  readonly totalRows:number;
  /** Cards (by the table's card code) whose values are not confirmed. */
  readonly unconfirmed:ReadonlyMap<number,{readonly name:string;readonly reasons:readonly string[]}>;
  /** Rows that can hold cards: the storage capacity over the columns (450 -> 45). The rows after
   * them are the game's locked storage bar ("보관함 슬롯 확장"): never missing, never asked for. */
  readonly slotRows?:number;
  /** Rows the displayed total of owned cards fills (398 -> 40). The rows after them up to
   * `slotRows` hold empty slots only, so they are not asked for either. Guidance only: this never
   * decides that a card is owned or not. */
  readonly cardRows?:number;
  /** Rows shown in a frame read, by that frame's scrollbar (moving or not). Map only. */
  readonly viewedRows?:ReadonlySet<number>;
}):ListGuidance {
  const totalRows=Math.max(0,Math.floor(options.totalRows));
  const cells:{row:number;column:number;kind:'unidentified'|'unread'}[]=[];
  const placed=new Map<number,{row:number;column:number}>();
  const anchored=new Set<number>();
  for(const [row,rowCells] of snapshot.rows){
    if(rowCells.some(cell=>cell!==null))anchored.add(row);
    rowCells.forEach((cell,column)=>{
      if(cell===null)cells.push({row,column,kind:'unread'});
      else if(cell.state==='unidentified')cells.push({row,column,kind:'unidentified'});
      else if(cell.state==='card'&&cell.card!==null&&!placed.has(cell.card))placed.set(cell.card,{row,column});
    });
  }
  let emptyFromRow:number|null=null;
  for(const [row,rowCells] of snapshot.rows)if(rowCells.some(cell=>cell?.state==='empty')&&(emptyFromRow===null||row<emptyFromRow))emptyFromRow=row;
  let runs=0,before:number|null=null;
  for(const row of [...anchored].sort((a,b)=>a-b)){if(before===null||row!==before+1)runs++;before=row;}
  const likely=new Set<number>();
  for(const row of options.viewedRows??[])if(row>=0&&row<totalRows&&!anchored.has(row))likely.add(row);
  // A row of a piece whose place is only likely counts as seen when every cell of it was read: a
  // cell covered there (a notice over the list) is asked for by showing that row again.
  for(const island of snapshot.floating)if(island.likelyTop!==null)
    for(let row=Math.max(0,island.likelyTop);row<Math.min(totalRows,island.likelyTop+island.rows);row++)
      if(!anchored.has(row)&&!(island.cells[row-island.likelyTop]??[]).some(cell=>cell===null||cell.state==='unidentified'))likely.add(row);
  const missingRows:{from:number;to:number}[]=[];
  const lockedFrom=typeof options.slotRows==='number'&&options.slotRows>0?Math.min(totalRows,Math.floor(options.slotRows)):totalRows;
  const cardsTo=typeof options.cardRows==='number'&&options.cardRows>0?Math.min(lockedFrom,Math.floor(options.cardRows)):lockedFrom;
  for(let row=0;row<cardsTo;row++){
    // A row shown in a frame read was seen, even when its place is not anchored.
    if(anchored.has(row)||likely.has(row))continue;
    const last=missingRows[missingRows.length-1];
    if(last&&last.to===row-1)last.to=row;else missingRows.push({from:row,to:row});
  }
  const seenRows:{from:number;to:number}[]=[];
  for(const row of [...anchored].filter(row=>row<totalRows).sort((a,b)=>a-b)){
    const last=seenRows[seenRows.length-1];
    if(last&&last.to===row-1)last.to=row;else seenRows.push({from:row,to:row});
  }
  const likelyRows:{from:number;to:number}[]=[];
  for(const row of [...likely].sort((a,b)=>a-b)){
    const last=likelyRows[likelyRows.length-1];
    if(last&&last.to===row-1)last.to=row;else likelyRows.push({from:row,to:row});
  }
  let rows=0,cards=0,unidentified=0,unread=0;
  for(const island of snapshot.floating){
    rows+=island.rows;cards+=island.cards;
    for(const rowCells of island.cells)for(const cell of rowCells){
      if(cell===null)unread++;else if(cell.state==='unidentified')unidentified++;
    }
  }
  const cardList=[...options.unconfirmed].map(([code,card])=>{
    const at=placed.get(code);
    return {code,name:card.name,reasons:[...card.reasons],row:at?.row??null,column:at?.column??null};
  }).sort((a,b)=>(a.row??Infinity)-(b.row??Infinity)||(a.column??0)-(b.column??0)||a.name.localeCompare(b.name,'ko'));
  const conflicts=snapshot.counts.overlapConflicts+snapshot.counts.anchorConflicts+snapshot.counts.cellConflicts;
  // With the header read, the rows holding cards are known: one cell taken for an empty slot does not
  // end the list there, and a cell in a row that cannot hold a card is not asked for.
  const headerRows=typeof options.cardRows==='number'&&options.cardRows>0;
  return {missingRows,missingRowsUnseen:rows===0,seenRows,likelyRows,emptyFromRow:headerRows?null:emptyFromRow,conflicts,pieces:runs+snapshot.floating.length,unplaced:{islands:snapshot.floating.length,rows,cards,unidentified,unread},
    cells:cells.filter(cell=>!headerRows||cell.row<cardsTo).sort((a,b)=>a.row-b.row||a.column-b.column),cards:cardList,
    ...(cardsTo<totalRows?{cardRows:cardsTo}:{}),...(lockedFrom<totalRows?{slotRows:lockedFrom}:{})};
}

/** The guidance for a person. `asks` are things to show again, most useful first; `notes` are what
 * the table cannot decide and says so. Rows and columns are counted from 1.
 *
 * No asks is not a statement that the scan is complete: the table knows neither the displayed
 * total nor whether values are the latest. Rows after the first empty slot are never asked for
 * (they are noted): the table saw the owned cards end there, not what follows. Rows without an
 * anchor are not asked to be anchored for their own sake; only a card or cell in them is asked for.
 * While such rows exist, a cell never seen whole in an anchored row is a note too. */
export function describeListGuidance(guidance:ListGuidance,options:{readonly totalRows:number}):{asks:string[];notes:string[]} {
  const asks:string[]=[],notes:string[]=[],total=Math.max(1,options.totalRows);
  const range=(from:number,to:number)=>from===to?`${from+1}번째 줄`:`${from+1}~${to+1}번째 줄`;
  const where=(row:number)=>`목록의 약 ${Math.round(row/Math.max(1,total-1)*100)}% 지점`;
  for(const card of guidance.cards){
    const place=card.row===null?'위치 미확인, 그 카드에서 스크롤을 잠깐 멈추면 위치를 알 수 있음':`${card.row+1}번째 줄 ${(card.column??0)+1}번째 칸, ${where(card.row)}`;
    asks.push(`${card.name}: 다시 보여 주세요 (${place})${card.reasons.length?` · ${card.reasons.join(' · ')}`:''}`);
  }
  const byRow=new Map<number,{unidentified:number[];unread:number[]}>();
  for(const cell of guidance.cells){
    const row=byRow.get(cell.row)??{unidentified:[],unread:[]};byRow.set(cell.row,row);
    row[cell.kind].push(cell.column+1);
  }
  // A cell never seen whole in an anchored row is asked for only when no rows wait for a place:
  // while they do, the same row may also be in one of those pieces, read there.
  const unreadKnown=guidance.unplaced.rows===0;
  let unreadElsewhere=0;const unreadRows:number[]=[];
  for(const [row,kinds] of byRow){
    const parts:string[]=[];
    if(kinds.unidentified.length)parts.push(`${kinds.unidentified.join(', ')}번째 칸은 이름을 읽지 못함`);
    if(kinds.unread.length){
      if(unreadKnown)parts.push(`${kinds.unread.join(', ')}번째 칸은 가려졌거나 온전히 보이지 않음`);
      else{unreadElsewhere+=kinds.unread.length;unreadRows.push(row+1);}
    }
    if(parts.length)asks.push(`${row+1}번째 줄(${where(row)}): ${parts.join(' · ')}`);
  }
  if(unreadElsewhere)notes.push(`위치가 확인된 줄에 온전히 보이지 않은 칸 ${unreadElsewhere}개(${unreadRows.join(', ')}번째 줄): 위치를 모르는 조각에서 읽혔을 수 있습니다`);
  if(guidance.unplaced.unidentified)
    asks.push(`위치를 모르는 줄에 이름을 읽지 못한 칸 ${guidance.unplaced.unidentified}개: 천천히 다시 넘기거나 그 부근에서 잠깐 멈춰 주세요`);
  const end=guidance.emptyFromRow;
  const before=guidance.missingRows.flatMap(run=>end===null||run.to<=end?[run]:run.from<=end?[{from:run.from,to:end}]:[]);
  const after=end===null?[]:guidance.missingRows.flatMap(run=>run.to>end?[{from:Math.max(run.from,end+1),to:run.to}]:[]);
  if(before.length){
    const text=before.map(run=>range(run.from,run.to)).join(', ');
    if(guidance.missingRowsUnseen)asks.push(`아직 보지 못한 줄: ${text}`);
    else notes.push(`위치가 확인된 줄에 없는 줄: ${text} (위치를 모르는 줄이 여기일 수 있음)`);
  }
  if(guidance.unplaced.rows)
    notes.push(`위치를 모르는 줄이 ${guidance.unplaced.islands}조각(카드 ${guidance.unplaced.cards}장, 조각끼리 겹칠 수 있음) 있습니다. 스크롤이 멈춘 적이 없는 구간입니다`);
  if(guidance.conflicts>0)
    notes.push(`목록 위치가 서로 맞지 않은 곳이 ${guidance.conflicts}건 있었습니다. 줄 번호가 한두 줄 어긋났을 수 있습니다`);
  if(guidance.pieces>1)
    notes.push(`목록이 ${guidance.pieces}조각으로 읽혔습니다. 조각 사이에 보지 못한 줄이 있는지는 알 수 없습니다`);
  if(after.length&&end!==null)
    notes.push(`${end+1}번째 줄에서 빈 칸이 보였습니다. 그 뒤 ${after.map(run=>range(run.from,run.to)).join(', ')}은 보지 않았습니다(카드가 더 있는지는 알 수 없음)`);
  return {asks,notes};
}

/** Where the rows to show again are, against the rows on screen now, for a picture of the list. */
export interface ListGuidanceMap {
  readonly totalRows:number;
  /** Rows the screen shows at once. */
  readonly visibleRows:number;
  /** The list row at the top of the screen now (from the scrollbar), or null when not known. */
  readonly currentRow:number|null;
  /** Rows to show again (0 = top), each once, in order: a card or cell to read again there, or a
   * row not seen yet. The same rows `describeListGuidance` asks for; rows without a place are not
   * in it (they cannot be drawn). */
  readonly targets:readonly {readonly row:number;readonly kind:'card'|'cell'|'unseen'}[];
  /** Which way the nearest target is from the rows on screen. */
  readonly direction:{readonly kind:'here'|'up'|'down';readonly rows:number;readonly row:number}|null;
  /** From the header: the first row of empty slots only, and the first locked row (when known). */
  readonly emptyFrom?:number;readonly lockedFrom?:number;
  /** Rows seen with nothing left to show again there, in runs (card rows only when known). */
  readonly done?:readonly {readonly from:number;readonly to:number}[];
}

export function listGuidanceMap(guidance:ListGuidance,options:{readonly totalRows:number;readonly visibleRows:number;readonly currentRow:number|null}):ListGuidanceMap {
  const totalRows=Math.max(0,Math.floor(options.totalRows)),visibleRows=Math.max(1,Math.floor(options.visibleRows));
  const kinds=new Map<number,'card'|'cell'|'unseen'>();
  const put=(row:number,kind:'card'|'cell'|'unseen')=>{if(row<0||row>=totalRows)return;const was=kinds.get(row);
    // A card to read again says most; an unseen row least.
    if(!was||(was==='unseen'&&kind!=='unseen')||(was==='cell'&&kind==='card'))kinds.set(row,kind);};
  for(const card of guidance.cards)if(card.row!==null)put(card.row,'card');
  // Unread cells are drawn also while pieces without a place wait (drawing them only when no piece
  // waits made them blink as pieces came and joined); showing the row again reads or places them.
  for(const cell of guidance.cells)put(cell.row,'cell');
  // Rows holding cards that no frame read showed are drawn as rows to look at, also while pieces
  // without a place wait (they may be those rows: showing the rows again places them). Never
  // after the first empty slot.
  {
    const end=guidance.emptyFromRow;
    for(const run of guidance.missingRows)for(let row=run.from;row<=run.to&&(end===null||row<=end);row++)put(row,'unseen');
  }
  const targets=[...kinds].sort((a,b)=>a[0]-b[0]).map(([row,kind])=>({row,kind}));
  const current=options.currentRow===null||!Number.isFinite(options.currentRow)?null:
    Math.max(0,Math.min(Math.max(0,totalRows-visibleRows),Math.round(options.currentRow)));
  let direction:ListGuidanceMap['direction']=null;
  if(current!==null&&targets.length){
    const last=current+visibleRows-1;
    const here=targets.find(target=>target.row>=current&&target.row<=last);
    if(here)direction={kind:'here',rows:0,row:here.row};
    else{
      const above=[...targets].reverse().find(target=>target.row<current),below=targets.find(target=>target.row>last);
      const up=above?current-above.row:Infinity,down=below?below.row-last:Infinity;
      direction=up<=down?{kind:'up',rows:up,row:above!.row}:{kind:'down',rows:down,row:below!.row};
    }
  }
  const doneTo=Math.min(totalRows,guidance.cardRows??guidance.slotRows??totalRows),done:{from:number;to:number}[]=[];
  // Rows read in pieces whose place is only likely are shown as read too: the map shows progress.
  for(const run of [...guidance.seenRows??[],...guidance.likelyRows??[]].sort((a,b)=>a.from-b.from))for(let row=run.from;row<=Math.min(run.to,doneTo-1);row++){
    if(kinds.has(row))continue;
    const last=done[done.length-1];
    if(last&&last.to===row-1)last.to=row;else done.push({from:row,to:row});
  }
  return {totalRows,visibleRows,currentRow:current,targets,direction,done,
    ...(guidance.cardRows!==undefined?{emptyFrom:guidance.cardRows}:{}),...(guidance.slotRows!==undefined?{lockedFrom:guidance.slotRows}:{})};
}

/** Until the scan is done, a highlight (values to check, or a cell not read) is drawn only once it
 * has lasted `holdMs`: a newer view of a confirmed card leaves it unconfirmed for a moment until
 * that view is read, a cell seen moving is read a frame later, and drawing those moments makes
 * the map blink. `since` (row -> first time seen) is kept by the
 * caller between calls. Display only: the card's state is unchanged. */
export function holdNewCardTargets(map:ListGuidanceMap,since:Map<number,number>,now:number,holdMs:number,
  /** Rows drawn read last time: a held row stays read only if it was. */readBefore:ReadonlySet<number>=new Set()):ListGuidanceMap {
  const rows=new Set(map.targets.filter(target=>target.kind!=='unseen').map(target=>target.row));
  for(const row of [...since.keys()])if(!rows.has(row))since.delete(row);
  for(const row of rows)if(!since.has(row))since.set(row,now);
  const held=map.targets.filter(target=>target.kind!=='unseen'&&now-since.get(target.row)!<holdMs).map(target=>target.row);
  if(!held.length)return map;
  const targets=map.targets.filter(target=>!held.includes(target.row));
  // A held row stays drawn as it was: read if it was read, else as before (not yet highlighted).
  const drawn=new Set<number>(held.filter(row=>readBefore.has(row)));for(const run of map.done??[])for(let row=run.from;row<=run.to;row++)drawn.add(row);
  const done:{from:number;to:number}[]=[];
  for(const row of [...drawn].sort((a,b)=>a-b)){const last=done[done.length-1];if(last&&last.to===row-1)last.to=row;else done.push({from:row,to:row});}
  return {...map,targets,done,direction:targets.length?map.direction:null};
}

/** Which rows of a frame read count as seen on the list map (`shown`: the grid row had a usable or
 * empty cell). A resting scrollbar is the position. A moving one can be a row ahead in the way it
 * moves, so the edge row on that side is left out (both edges when the way is not known); it is
 * marked when the scrollbar rests or the row comes into the middle. */
export function surelyShownRows(shown:readonly boolean[],resting:boolean,moving:'down'|'up'|null=null):boolean[] {
  const last=shown.length-1;
  return shown.map((on,row)=>on&&(resting||!((row===last&&moving!=='up')||(row===0&&moving!=='down'))));
}
