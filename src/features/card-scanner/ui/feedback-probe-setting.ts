/** Detailed display receipts are opt-in; input recording is configured separately. */
export function feedbackProbeEnabled(development:boolean,search:string):boolean {
  if(!development)return false;
  const values=new URLSearchParams(search).getAll('feedbackProbe');
  return values.length===1&&values[0]==='1';
}
