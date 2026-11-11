import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseReplayComparisonOptions,selectReplayComparison} from '../dev/replay-comparison-options';
import {devReplayRecognitionOptions} from '../src/features/card-scanner/reproduction/reproduction-input';

const standard={version:1 as const,rawResultPolicy:'resample' as const};

test('stored-input comparison needs one explicit and isolated mode',()=>{
 assert.equal(parseReplayComparisonOptions(''),null);
 assert.equal(parseReplayComparisonOptions('?fractional=1'),null,'unrelated normal paths keep their prior behavior');
 assert.equal(parseReplayComparisonOptions('?replayCompare=baseline'),'baseline');
 assert.equal(parseReplayComparisonOptions('?replayCompare=fractional'),'fractional');
 for(const query of ['?replayCompare=', '?replayCompare=unknown', '?replayCompare=baseline&replayCompare=fractional',
  '?replayCompare=baseline&fractional=1','?replayCompare=fractional&gray=0','?replayCompare=baseline&unknown=1'])
  assert.throws(()=>parseReplayComparisonOptions(query));
});

test('A/B fixes the same name configuration but records unknown original options separately',()=>{
 const baseline=selectReplayComparison('baseline',standard,false,undefined);
 const fractional=selectReplayComparison('fractional',standard,false,undefined);
 assert.equal(baseline.recordedNameConfiguration,null);assert.equal(baseline.recordedDevRecognition,null);
 assert.deepEqual(baseline.appliedNameConfiguration,standard);assert.deepEqual(fractional.appliedNameConfiguration,standard);
 assert.deepEqual(baseline.applied,{fractionalPortrait:false,grayNameFallback:false});
 assert.deepEqual(fractional.applied,{fractionalPortrait:true,grayNameFallback:false});
 assert.equal(fractional.scope,'stored-input-counterfactual-recognition');
 const recorded={version:1 as const,fractionalPortrait:false,grayNameFallback:false};
 const explicit=selectReplayComparison('fractional',standard,true,recorded);
 assert.deepEqual(explicit.recordedNameConfiguration,standard);assert.deepEqual(explicit.recordedDevRecognition,recorded);
 assert.deepEqual(devReplayRecognitionOptions(standard,recorded).applied,{fractionalPortrait:false,grayNameFallback:false},
  'ordinary replay keeps its recorded policy');
});

test('comparison refuses incompatible or invalid recorded experiments',()=>{
 for(const name of [{version:1 as const,rawResultPolicy:'continue' as const},
  {version:1 as const,rawResultPolicy:'resample' as const,contrastNameFallback:true}])
  assert.throws(()=>selectReplayComparison('fractional',name,true,undefined));
 for(const recorded of [{version:1 as const,fractionalPortrait:true,grayNameFallback:false},
  {version:1 as const,fractionalPortrait:false,grayNameFallback:true}])
  assert.throws(()=>selectReplayComparison('baseline',standard,true,recorded));
 assert.throws(()=>selectReplayComparison('other' as never,standard,true,undefined));
 assert.throws(()=>selectReplayComparison('fractional',{...standard,unknown:true} as never,true,undefined));
});
