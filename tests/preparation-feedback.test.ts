import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationFeedback } from '../src/features/card-scanner/preparation-feedback';

test('short stages stay hidden and completion cancels pending feedback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen: string[] = [];
  const feedback = createPreparationFeedback(message => seen.push(message));
  feedback.update('화면 검출 모듈 준비 중');
  t.mock.timers.tick(300);
  feedback.update('이름 모델 불러오는 중');
  t.mock.timers.tick(300);
  feedback.dispose();
  t.mock.timers.tick(2000);
  feedback.update('늦게 도착한 상태');
  assert.deepEqual(seen.filter(Boolean), []);
});

test('byte updates do not postpone a slow stage and old details are cleared', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen: string[] = [];
  const feedback = createPreparationFeedback(message => seen.push(message));
  feedback.update('1/4 · 이름 모델 불러오는 중');
  t.mock.timers.tick(250);
  feedback.update('1/4 · 이름 모델 불러오는 중 1.0 / 12.8 MB');
  t.mock.timers.tick(250);
  feedback.update('1/4 · 이름 모델 불러오는 중 2.0 / 12.8 MB');
  t.mock.timers.tick(200);
  assert.equal(seen.at(-1), '1/4 · 이름 모델 불러오는 중 2.0 / 12.8 MB');
  feedback.update('1/4 · 이름 모델 불러오는 중 3.0 / 12.8 MB');
  assert.equal(seen.at(-1), '1/4 · 이름 모델 불러오는 중 3.0 / 12.8 MB');
  feedback.update('1/4 · 이름 모델 인식 엔진 준비 중');
  assert.equal(seen.at(-1), '');
  t.mock.timers.tick(699);
  assert.equal(seen.at(-1), '');
  t.mock.timers.tick(1);
  assert.equal(seen.at(-1), '1/4 · 이름 모델 인식 엔진 준비 중');
  feedback.dispose();
});
