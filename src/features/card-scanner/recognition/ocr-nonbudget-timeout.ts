import {CardReadTimeout} from './card-read-budget';
/** An interrupted operation retains its owned resource until it actually settles. */
export async function awaitNonBudgetOcr<T>(request:()=>Promise<T>,invalidate:()=>Promise<unknown>,milliseconds=10000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(request),new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>{reject(new CardReadTimeout());try{void invalidate().catch(()=>{});}catch{/* invalidation is best effort */}},milliseconds);
 })]);}finally{if(timer)clearTimeout(timer);}
}
