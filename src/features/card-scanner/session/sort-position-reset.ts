import type {CardSort} from '../recognition/capture-metadata';
import {metadataSortChanged} from './metadata-order';
import type {AcceptedMetadata} from './metadata-order';

/** A sort transition invalidates positional receipts, not card observations.
 * The same operation is used by the live scanner and its state tests. */
export function resetPositionsForSort(
  current:CardSort|null,
  next:AcceptedMetadata,
  targets:{
    grid:{resetPositions():void};
    inventory:{resetPositions():void};
    stationary:{reset():void};
    layout:{resetPositions():void};
    coverage:{reset():void};
    clearTransient():void;
  },
  force=false,
):boolean {
  if(!force&&!next.sortInvalidated&&!metadataSortChanged(current,next.sort))return false;
  targets.grid.resetPositions();
  targets.inventory.resetPositions();
  targets.stationary.reset();
  targets.layout.resetPositions();
  targets.coverage.reset();
  targets.clearTransient();
  return true;
}
