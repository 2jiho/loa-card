type UnknownCapture = {captureOrder?:number;group?:number;pending:boolean};

/** Failure proofs follow capture time too. Do not leave an older timestamp
 * attached to a newer failure or let a pending retry undo a final failure. */
export function updateUnknown<T extends UnknownCapture>(entries:T[],vectors:Uint8Array[],next:T,vector:Uint8Array,limit=128) {
  // Approximate image similarity can group scheduling work, but it cannot
  // certify identity or erase a separate unresolved observation group.
  const existing=entries.findIndex(old=>next.group!==undefined&&old.group===next.group);
  if(existing>=0) {
    const previous=entries[existing],order=next.captureOrder??-Infinity,oldOrder=previous.captureOrder??-Infinity;
    if(order<oldOrder||(order===oldOrder&&(!previous.pending||next.pending)))return false;
    entries[existing]=next;vectors[existing]=vector;return true;
  }
  if(entries.length>=limit)return false;
  entries.push(next);vectors.push(vector);return true;
}
