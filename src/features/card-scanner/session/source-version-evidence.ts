/** These are filesystem boundary snapshots, not proof of the browser's
 * actually loaded modules or the absence of transient, unwatched edits. */
interface LegacySourceVersionEvidence {
  version: 1;
  startDigest: string | null;
  endDigest: string | null;
  startBeforeScanner: boolean;
  hotUpdate: boolean;
  changed: boolean | null;
}
interface TimedSourceVersionEvidence {
  version: 2;
  startDigest:string|null;endDigest:string|null;startBeforeScanner:boolean;
  hotUpdateBeforeScanner:boolean;hotUpdateDuringScanner:boolean;hotUpdateAfterScanner:boolean;
  changed:boolean|null;
}
export type SourceVersionEvidence = LegacySourceVersionEvidence | TimedSourceVersionEvidence;

const digest = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

export function parseSourceVersionEvidence(value: unknown): SourceVersionEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('소스 확인 정보가 올바르지 않습니다.');
  const v = value as SourceVersionEvidence;
  if (![1,2].includes(v.version) || !(v.startDigest === null || digest(v.startDigest)) ||
      !(v.endDigest === null || digest(v.endDigest)) || typeof v.startBeforeScanner !== 'boolean' ||
      !(v.changed === null || typeof v.changed === 'boolean'))
    throw Error('소스 확인 정보가 올바르지 않습니다.');
  if(v.version===1){
    if(typeof v.hotUpdate!=='boolean')throw Error('소스 확인 정보가 올바르지 않습니다.');
    const expected = !v.startBeforeScanner || !v.startDigest ? null : v.hotUpdate ? true : v.endDigest ? v.startDigest !== v.endDigest : null;
    if (v.changed !== expected) throw Error('소스 확인 결과가 근거와 일치하지 않습니다.');
    return {version:1,startDigest:v.startDigest,endDigest:v.endDigest,startBeforeScanner:v.startBeforeScanner,hotUpdate:v.hotUpdate,changed:v.changed};
  }
  if(typeof v.hotUpdateBeforeScanner!=='boolean'||typeof v.hotUpdateDuringScanner!=='boolean'||typeof v.hotUpdateAfterScanner!=='boolean')
    throw Error('소스 확인 정보가 올바르지 않습니다.');
  const expected = v.hotUpdateDuringScanner ? true : !v.startBeforeScanner||!v.startDigest||v.hotUpdateBeforeScanner ? null :
    v.hotUpdateAfterScanner ? true : v.endDigest ? v.startDigest !== v.endDigest : null;
  if (v.changed !== expected) throw Error('소스 확인 결과가 근거와 일치하지 않습니다.');
  return {version:2,startDigest:v.startDigest,endDigest:v.endDigest,startBeforeScanner:v.startBeforeScanner,
    hotUpdateBeforeScanner:v.hotUpdateBeforeScanner,hotUpdateDuringScanner:v.hotUpdateDuringScanner,
    hotUpdateAfterScanner:v.hotUpdateAfterScanner,changed:v.changed};
}

/** Finalization must remain bounded even if an optional diagnostic fails. */
export async function resolveSourceVersionEvidence(read:()=>Promise<unknown>,timeoutMs=2500):Promise<SourceVersionEvidence> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return parseSourceVersionEvidence(await Promise.race([Promise.resolve().then(read),
      new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);})]));
  }catch{return {version:1,startDigest:null,endDigest:null,startBeforeScanner:false,hotUpdate:false,changed:null};}
  finally{clearTimeout(timer);}
}

/** Never waits on the capture path. If the initial snapshot has not finished
 * by scanner start, matching boundaries are deliberately not claimed. */
export function trackSourceVersion(snapshot: () => Promise<unknown>, subscribe: (invalidate: () => void) => () => void, timeoutMs=2000) {
  let startDigest:string|null=null,startFinished=false,startBeforeScanner=false,scannerStarted=false,scannerStopped=false,finished=false;
  let hotUpdateBeforeScanner=false,hotUpdateDuringScanner=false,hotUpdateAfterScanner=false;
  const unsubscribe = subscribe(() => {
    if(!scannerStarted)hotUpdateBeforeScanner=true;
    else if(!scannerStopped)hotUpdateDuringScanner=true;
    else hotUpdateAfterScanner=true;
  });
  const read = async () => {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([Promise.resolve().then(snapshot),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);})]);
      return digest((result as {sourceDigest?:unknown})?.sourceDigest);
    }catch{return null;}finally{clearTimeout(timer);}
  };
  const start = read().then(value => {startDigest=value;startFinished=true;});
  return {
    scannerStarted(){if(!scannerStarted){scannerStarted=true;startBeforeScanner=startFinished && startDigest!==null;}},
    scannerStopped(){scannerStopped=true;},
    async finish():Promise<SourceVersionEvidence> {
      if(finished) throw Error('소스 확인은 한 번만 종료할 수 있습니다.');
      finished=true;scannerStopped=true;
      try {
        const [,endDigest]=await Promise.all([start,read()]);
        const changed=hotUpdateDuringScanner?true:!startBeforeScanner||!startDigest||hotUpdateBeforeScanner?null:
          hotUpdateAfterScanner?true:endDigest?startDigest!==endDigest:null;
        return {version:2,startDigest,endDigest,startBeforeScanner,hotUpdateBeforeScanner,hotUpdateDuringScanner,hotUpdateAfterScanner,changed};
      } finally {unsubscribe();}
    },
  };
}
