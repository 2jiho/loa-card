/** Local validation only; never raises the production storage budget. */
export function recordingBudget(raw:string|null):{bytes:number;database:string} {
  if(raw===null)return {bytes:512*1024*1024,database:'loacard-reproduction-dev'};
  if(!/^[1-9]\d*$/.test(raw))throw Error('recordingBudgetMiB는 32~512의 정수여야 합니다.');
  const mib=Number(raw);
  if(!Number.isSafeInteger(mib)||mib<32||mib>512)throw Error('recordingBudgetMiB는 32~512의 정수여야 합니다.');
  return {bytes:mib*1024*1024,database:`loacard-reproduction-dev-budget-${mib}`};
}
