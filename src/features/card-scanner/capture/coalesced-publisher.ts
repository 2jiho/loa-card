/** Leading + trailing publication: a quiet final update must not wait for the
 * next input frame. At most one timer is retained regardless of event volume. */
export function createCoalescedPublisher(publish:()=>void,interval=100,now=()=>performance.now()) {
 let last=-Infinity,timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
 const cancel=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
 const flush=()=>{cancel();if(disposed)return;last=now();publish();};
 return {
  request(force=false){
   if(disposed)return;
   const remaining=interval-(now()-last);
   if(force||remaining<=0){flush();return;}
   timer??=setTimeout(flush,remaining);
  },
  cancel,
  dispose(){disposed=true;cancel();},
 };
}
