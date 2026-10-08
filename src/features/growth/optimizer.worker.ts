import { compareGrowthCandidates } from './optimizer';
import type { GrowthComparisonRequest } from './optimizer';
self.onmessage = (event: MessageEvent<GrowthComparisonRequest>) => {
  try { self.postMessage({ result: compareGrowthCandidates(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '성장 계산에 실패했습니다.' }); }
};
