import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCompletion } from "../src/features/card-scanner/completion";

test("input completion distinguishes missing, excess, unreadable quantity and field review", () => {
  assert.match(scanCompletion(null, 40, 0), /수량 확인 필요/);
  assert.match(scanCompletion(385, 384, 2), /1종 추가 수집 필요/);
  assert.match(scanCompletion(384, 385, 0), /1종 많음/);
  assert.match(scanCompletion(384, 384, 2), /2종 판독 확인 필요/);
  assert.equal(scanCompletion(384, 384, 0), "입력 처리 완료 · 표시 수량 일치");
  assert.equal(scanCompletion(0, 0, 0), "입력 처리 완료 · 표시 수량 일치");
});
