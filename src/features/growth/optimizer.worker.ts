import { compareGrowthCandidates } from './optimizer';
import type { GrowthComparisonRequest } from './optimizer';
self.onmessage = (event: MessageEvent<GrowthComparisonRequest>) => {
  try { self.postMessage({ result: compareGrowthCandidates(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '성장 순서를 계산하지 못했어요.' }); }
};
