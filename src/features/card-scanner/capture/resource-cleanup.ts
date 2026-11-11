/** Start every independent cleanup, including after a synchronous failure,
 * and keep their ownership until every attempt settles. Call only after the
 * resource's active work has joined (or where cancellation owns termination). */
export async function settleDisposals(actions:readonly (()=>unknown|PromiseLike<unknown>)[]):Promise<unknown[]> {
  const results=await Promise.allSettled(actions.map(async action=>action()));
  return results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
}

/** All paths releasing the same owned object join one termination attempt. */
export function onceDisposer<T extends object>(dispose:(value:T)=>unknown|PromiseLike<unknown>):(value:T)=>Promise<void> {
  const pending=new WeakMap<T,Promise<void>>();
  return value=>{
    const existing=pending.get(value);if(existing)return existing;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    const result=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    pending.set(value,result);
    try{Promise.resolve(dispose(value)).then(()=>resolve(),reject);}catch(error){reject(error);}
    return result;
  };
}

/** Setup failure still owns the allocated resource. Release it before
 * propagating that original failure; a late initialization cannot escape a
 * closed owner. Cleanup failures are reported separately without masking it. */
export async function initializeOwnedResource<T>(create:()=>Promise<T>,setup:(value:T)=>unknown|PromiseLike<unknown>,
  dispose:(value:T)=>unknown|PromiseLike<unknown>,options:{isClosed:()=>boolean;closedError?:()=>unknown;onCleanupError?:(error:unknown)=>void}):Promise<T> {
  const value=await create();
  try{
    const check=()=>{if(options.isClosed())throw options.closedError?.()??new Error('Resource owner closed');};
    check();await setup(value);check();return value;
  }catch(error){
    try{await dispose(value);}catch(cleanupError){try{options.onCleanupError?.(cleanupError);}catch{/* Secondary reporting cannot replace setup failure. */}}
    throw error;
  }
}
