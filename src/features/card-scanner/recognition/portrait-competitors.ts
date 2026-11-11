import competitorPins from '../portrait-competitor-pins.json';

/** Evidence registry for client-derived *competitors*, never identity references.
 * The expected hash is independent of the fetched feature body: a different
 * image or a mislabeled feature must not silently remove the ambiguity guard.
 * The mapping is corroborated by the local client DB/atlas and another
 * service's link to the official CDN; it is not an in-game positive capture. */
export const PORTRAIT_COMPETITOR_HASHES:Readonly<Record<string,string>>=Object.freeze(competitorPins);

/** Failure leaves the original missing-competitor guard in place. */
export async function validatedPortraitCompetitors(value:unknown):Promise<Record<string,string>> {
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const input=value as {version?:unknown;kind?:unknown;cards?:unknown};
  if(input.version!==1||input.kind!=='client-atlas-competitor-only'||!input.cards||
    typeof input.cards!=='object'||Array.isArray(input.cards)||!globalThis.crypto?.subtle)return {};
  const result:Record<string,string>={};
  for(const [id,raw] of Object.entries(input.cards)){
    const expected=PORTRAIT_COMPETITOR_HASHES[id];
    if(!expected||typeof raw!=='string')continue;
    try{
      const decoded=atob(raw),bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
      if(bytes.length!==200)continue;
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      if(Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('')===expected)result[id]=raw;
    }catch{/* Invalid feature is not evidence. */}
  }
  return result;
}

/** Optional data is bounded independently of the rest of initialization.
 * A stalled response body or digest cannot delay scanner readiness indefinitely.
 * Missing data retains the original ambiguous-name barrier. */
export function loadPortraitCompetitors(base:string,signal?:AbortSignal,timeoutMs=2000):Promise<Record<string,string>> {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>10_000)throw Error('Invalid competitor loading deadline');
  return new Promise((resolve,reject)=>{
    const controller=new AbortController();let settled=false;
    const finish=(value:Record<string,string>,error?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error!==undefined)reject(error);else resolve(value);
    };
    const abort=()=>{controller.abort();finish({},signal?.reason??new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{controller.abort();finish({});},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    void (async()=>{
      const response=await fetch(`${base}scanner/portrait-competitors.json`,{signal:controller.signal});
      return response.ok?validatedPortraitCompetitors(await response.json()):{};
    })().then(value=>finish(value),()=>finish({}));
  });
}
