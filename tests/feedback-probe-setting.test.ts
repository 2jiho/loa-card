import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {feedbackProbeEnabled} from '../src/features/card-scanner/ui/feedback-probe-setting';

test('display feedback measurement requires an explicit development-only opt-in',()=>{
  assert.equal(feedbackProbeEnabled(true,''),false);
  assert.equal(feedbackProbeEnabled(true,'?feedbackProbe=1'),true);
  assert.equal(feedbackProbeEnabled(true,'?feedbackProbe=0'),false);
  assert.equal(feedbackProbeEnabled(true,'?feedbackProbe=1&feedbackProbe=1'),false);
  assert.equal(feedbackProbeEnabled(false,'?feedbackProbe=1'),false);
});
