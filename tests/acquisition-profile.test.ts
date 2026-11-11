import test from 'node:test';
import assert from 'node:assert/strict';
import {acquisitionProfile,addAcquisitionProfile} from '../src/features/card-scanner/acquisition/acquisition-profile';

test('acquisition profile rejects malformed counters and preserves missing measurements',()=>{
  assert.equal(addAcquisitionProfile(undefined,undefined),undefined);
  assert.equal(acquisitionProfile(null),undefined);assert.equal(acquisitionProfile({}),undefined);
  const valid={exact:0,moved:0,inspected:0,probeMs:0,shifted:0,moveCompared:0,moveMatched:0};
  for(const patch of [{exact:40,moved:1,moveCompared:1,moveMatched:1,shifted:1},
    {probeMs:NaN},{exact:-1},{moved:0.5},{shifted:2},{moveMatched:1},
    {moved:1,moveCompared:1}])assert.equal(acquisitionProfile({...valid,...patch}),undefined);
});

test('region-copy telemetry counts only measured samples and rejects impossible savings',()=>{
 const p={exact:10,moved:0,inspected:30,probeMs:1,shifted:0,moveCompared:0,moveMatched:0};
 assert.equal(acquisitionProfile({...p,exactRegionCopiesSaved:11}),undefined);
 const first=addAcquisitionProfile(undefined,p)!;
 assert.equal(first.exactRegionCopySamples,undefined);
 const second=addAcquisitionProfile(first,{...p,exactRegionCopiesSaved:7})!;
 assert.equal(second.exactRegionCopiesSaved,7);assert.equal(second.exactRegionCopySamples,1);
 const third=addAcquisitionProfile(second,p)!;
 assert.equal(third.exactRegionCopiesSaved,7);assert.equal(third.exactRegionCopySamples,1);
 const fourth=addAcquisitionProfile(third,{...p,exactRegionCopiesSaved:0})!;
 assert.equal(fourth.exactRegionCopiesSaved,7);assert.equal(fourth.exactRegionCopySamples,2);
});

test('acquisition profile sums measured frames without counting cached or missing analysis',()=>{
  const p={exact:10,moved:20,inspected:10,probeMs:3,shifted:1,moveCompared:30,moveMatched:20};
  const first=addAcquisitionProfile(undefined,p)!;
  p.exact=0;
  assert.equal(first.exact,10);
  assert.equal(addAcquisitionProfile(first,undefined),first);
  assert.deepEqual(addAcquisitionProfile(first,{exact:40,moved:0,inspected:0,probeMs:1,shifted:0,moveCompared:0,moveMatched:0}),
    {samples:2,exact:50,moved:20,inspected:10,probeMs:4,shifted:1,moveCompared:30,moveMatched:20});
});
