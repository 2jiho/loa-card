/** DEV comparison sequencing. A failed/unreleased reader must never overlap
 * the next supposedly fresh mode. Partial rows remain available for diagnosis. */
export function cardCropProofRowSettled(row:Record<string,unknown>):boolean {
  const disposal=row.disposal;
  return row.error===null&&typeof disposal==='object'&&disposal!==null
    &&'completed' in disposal&&disposal.completed===true;
}

export async function runCardCropProofSequence<Input,Mode,Row extends Record<string,unknown>>(options:{
  inputs:readonly Input[];modes:readonly Mode[];signal:AbortSignal;
  run:(input:Input,mode:Mode)=>Promise<Row>;
  onRow:(input:Input,mode:Mode,row:Row)=>void;
}):Promise<void> {
  for(const input of options.inputs)for(const mode of options.modes){
    options.signal.throwIfAborted();
    const row=await options.run(input,mode);
    options.onRow(input,mode,row);
    options.signal.throwIfAborted();
    if(!cardCropProofRowSettled(row))return;
  }
}

/** Evaluate only after the final asynchronous source check. An abort during
 * that check must not leave completed:true beside cancelled:true. */
export function cardCropProofCompleted(options:{rows:readonly Record<string,unknown>[];expectedRows:number;
  sourceChanged:boolean|null;cancelled:boolean;error:string|null}):boolean {
  return !options.cancelled&&options.error===null&&options.sourceChanged===false
    &&Number.isSafeInteger(options.expectedRows)&&options.expectedRows>0
    &&options.rows.length===options.expectedRows&&options.rows.every(cardCropProofRowSettled);
}
