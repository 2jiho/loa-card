import {isLockedInventorySlot} from '../session/scan-grid';
import type {ScanGridCell,ScanGridSnapshot} from '../session/scan-grid';

/** Display-only guesses belonging to one captured frame. They never modify the
 * authoritative inventory, stored position facts, completion or count. */
export function estimatedMonitorCell(grid:ScanGridSnapshot|undefined,index:number,capacity:number|null|undefined,expected:number|null|undefined):ScanGridCell|undefined {
  if(!grid?.liveTracking||!Number.isInteger(index)||index<0||index>=550)return;
  const frame=grid.recentFrame,top=frame?.capturedTop;
  if(!frame||!Number.isInteger(top)||top!<1||top!>52||grid.liveTop!==top||frame.cells.length!==40)return;
  const slot=index-(top!-1)*10;
  if(slot<0||slot>=40||isLockedInventorySlot(index,capacity,expected))return;
  const cell=frame.cells[slot];
  if(!cell||!['waiting','reading','read','review'].includes(cell.status))return;
  return cell;
}

/** Keep anchored status and an estimated current work status separately. */
export function projectMonitorCell(grid:ScanGridSnapshot|undefined,index:number,capacity:number|null|undefined,expected:number|null|undefined,sharing:boolean) {
  const anchored=grid?.inventory?.[index];
  if(isLockedInventorySlot(index,capacity,expected))return {cell:{status:'empty' as const},estimate:undefined,estimatedPrimary:false};
  const guess=sharing?estimatedMonitorCell(grid,index,capacity,expected):undefined;
  if(anchored&&(anchored.status!=='unknown'||anchored.row!==undefined))
    return {cell:anchored,estimate:guess,estimatedPrimary:false};
  return {cell:guess??anchored??{status:'unknown' as const},estimate:undefined,estimatedPrimary:!!guess};
}
