import type { GrowthComparison, GrowthComparisonRequest } from './optimizer';

export const GROWTH_CALCULATION_TIMEOUT_MS=30_000;
type CalculationWorker=Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;
type Result={result?:GrowthComparison;error?:string};

/** One terminal result and one termination, even if a worker never replies. */
export function runGrowthWorker(worker:CalculationWorker,request:GrowthComparisonRequest,finish:(result:Result)=>void,timeout=GROWTH_CALCULATION_TIMEOUT_MS) {
  let done=false;
  const stop=()=>{if(done)return false;done=true;clearTimeout(timer);worker.terminate();return true;};
  const complete=(result:Result)=>{if(stop())finish(result);};
  const timer=setTimeout(()=>complete({error:'계산이 너무 오래 걸려 멈췄어요. 다시 계산해 주세요.'}),timeout);
  worker.onmessage=message=>complete(message.data?.result?{result:message.data.result}:{error:message.data?.error??'성장 순서를 계산하지 못했어요.'});
  worker.onerror=()=>complete({error:'계산을 끝내지 못했어요. 다시 계산해 주세요.'});
  worker.onmessageerror=()=>complete({error:'계산 결과를 읽지 못했어요. 다시 계산해 주세요.'});
  try{worker.postMessage(request);}catch(e){complete({error:e instanceof Error?e.message:'계산을 시작하지 못했어요.'});}
  return ()=>{stop();};
}
