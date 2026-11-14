import type {ListCell} from './list-table';

/** Which slots of one visible grid row need reading (docs/scanner-pipeline.md, section 4).
 *
 * Two PROBE slots of the row are read first. When both are cards the list table already has,
 * side by side in one row of one island, at the columns they are seen in now, the grid row is
 * that list row, and only its slots that still lack a result are read. Anything less certain
 * reads the whole row: a probe that is unusable or not identified, a card not placed yet, or
 * probes that point at different rows.
 *
 * The plan only saves work. It never supplies a card or a value: a slot that is not read
 * contributes nothing to this frame. */
export interface ProbeReading {
  readonly column:number;
  /** Card code read from the probe slot, or null when it was unusable or not identified. */
  readonly card:number|null;
  /** Where the list table has that card, or null. */
  readonly place:{readonly island:number;readonly row:number;readonly column:number}|null;
}
export interface RowPlan {
  /** The list row this grid row was recognised as, or null when the whole row is read. */
  readonly known:{readonly island:number;readonly row:number}|null;
  /** Columns to read in addition to the probes. */
  readonly read:readonly number[];
}

export function planRow(input:{
  readonly columns:number;
  readonly probes:readonly ProbeReading[];
  /** Columns of this grid row whose crop is usable now. */
  readonly usable:ReadonlySet<number>;
  /** The table's cell of the recognised row. */
  readonly cellAt:(island:number,row:number,column:number)=>ListCell|null;
  /** Whether a card already has every value this reader can give. */
  readonly complete:(card:number)=>boolean;
  /** Whether a slot whose card this reader could not name has been handed to another reader
   * (the name reading); it is then not read again here. Default: never. */
  readonly handedOver?:(cell:ListCell)=>boolean;
}):RowPlan {
  const {columns,probes,usable}=input;
  const probed=new Set(probes.map(probe=>probe.column));
  const rest=()=>Array.from({length:columns},(_,column)=>column).filter(column=>usable.has(column)&&!probed.has(column));
  const first=probes[0]?.place;
  const agreed=probes.length>=2&&!!first&&probes.every(probe=>probe.card!==null&&probe.place!==null&&
    probe.place.island===first.island&&probe.place.row===first.row&&probe.place.column===probe.column);
  if(!agreed)return {known:null,read:rest()};
  const read=rest().filter(column=>{
    const cell=input.cellAt(first.island,first.row,column);
    // Never seen, or a card still without a name: read it. An empty slot stays empty within a scan.
    if(!cell)return true;
    if(cell.state==='unidentified')return !input.handedOver?.(cell);
    return cell.state==='card'&&cell.card!==null&&!input.complete(cell.card);
  });
  return {known:{island:first.island,row:first.row},read};
}
