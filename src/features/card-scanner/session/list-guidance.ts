import type {ListTableSnapshot} from './list-table';

/** What to show the list again for, worked out from the list table (docs/scanner-live-redesign.md,
 * section 13.6).
 *
 * Proposal stage: only the development prototype uses this. It is a pure function of the table's
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
}

export function listGuidance(snapshot:ListTableSnapshot,options:{
  /** Rows of the whole list (scroll steps + visible rows). */
  readonly totalRows:number;
  /** Cards (by the table's card code) whose values are not confirmed. */
  readonly unconfirmed:ReadonlyMap<number,{readonly name:string;readonly reasons:readonly string[]}>;
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
  const missingRows:{from:number;to:number}[]=[];
  for(let row=0;row<totalRows;row++){
    if(anchored.has(row))continue;
    const last=missingRows[missingRows.length-1];
    if(last&&last.to===row-1)last.to=row;else missingRows.push({from:row,to:row});
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
  return {missingRows,missingRowsUnseen:rows===0,emptyFromRow,conflicts,pieces:runs+snapshot.floating.length,unplaced:{islands:snapshot.floating.length,rows,cards,unidentified,unread},
    cells:cells.sort((a,b)=>a.row-b.row||a.column-b.column),cards:cardList};
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
