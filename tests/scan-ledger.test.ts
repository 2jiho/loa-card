import { test } from "node:test";
import assert from "node:assert/strict";
import { ScanLedger } from "../src/features/card-scanner/scan-ledger";
const source = { frame: 1, time: 1.25, slot: 12, box: { x: 200, y: 300, width: 140, height: 210 }, phase: "input" as const };
test("every observation keeps its original crop and final pipeline outcome", () => {
  const ledger = new ScanLedger(); ledger.frame(true); ledger.frame(false);
  const a = ledger.acquire(source), b = ledger.acquire(source), c = ledger.acquire(source);
  ledger.finish(a, "deferred", { group: 7 });
  ledger.finish(a, "identified", { group: 7, cardId: "a", name: "카드" });
  ledger.finish(b, "duplicate", { group: 7 }); ledger.finish(c, "rejected", { reason: "잘림" });
  const summary = ledger.snapshot(true);
  assert.equal(summary.observations, 3); assert.equal(summary.groups, 1); assert.equal(summary.unlocatedFrames, 1);
  assert.equal(summary.unresolvedGroups, 0); assert.equal(summary.stages.deferred, 0);
  assert.equal(Object.values(summary.stages).reduce((a,b) => a+(b??0),0),3);
  assert.deepEqual(summary.traces[0].box, source.box);
  assert.equal(summary.traces[0].cardId, "a"); assert.equal(summary.traces[2].reason, "잘림");
});

test("name failures keep OCR evidence with source coordinates under an independent diagnostic memory cap", () => {
  const ledger = new ScanLedger();
  const attempt = { text: "흑한의 헬기이만", confidence: 67, engine: "paddle", variant: "원본",
    reason: "DB 조건 미달", candidates: [{ id: "1", name: "혹한의 헬가이아", score: .81 }] };
  for (let i = 0; i < 301; i++) {
    const id = ledger.acquire({ ...source, frame: i });
    ledger.finish(id, "unidentified", { group: i, nameAttempts: [attempt] });
  }
  const snapshot = ledger.snapshot(true);
  assert.equal(snapshot.nameDiagnosticsTruncated, 1);
  assert.equal(snapshot.traces[0].nameAttempts, undefined);
  assert.equal(snapshot.traces[300].nameAttempts?.[0].text, attempt.text);
  assert.equal(snapshot.traces[300].frame, 300);
  assert.equal(snapshot.traces.length, 301);
  assert.equal(snapshot.unresolvedGroups, 301);
});
test("unresolved group counts are complete even when detailed traces are capped", () => {
  const ledger = new ScanLedger(1); ledger.acquire(source); const id = ledger.acquire(source);
  ledger.finish(id, "deferred", { group: 8 }); ledger.finish(id, "unidentified", { group: 8 });
  const snapshot = ledger.snapshot(true);
  assert.equal(snapshot.truncated, true); assert.equal(snapshot.retained,1);
  assert.equal(snapshot.unresolvedGroups,1); assert.equal(snapshot.stages.deferred,0);
  assert.equal(Object.values(snapshot.stages).reduce((a,b) => a+(b??0),0),2);
});

test('read timings distinguish queue delay from OCR work and snapshots stay immutable',()=>{
 const ledger=new ScanLedger(1),id=ledger.acquire(source);
 const finish=ledger.beginRead(id,'visual',2);
 const before=ledger.snapshot(true);
 finish(2.1);finish(99);
 ledger.beginRead(id,'short',3)(3.5);
 ledger.beginRead(id,'full',4)(7);
 ledger.beginRead(id,'full',8)(9);
 const overflow=ledger.acquire(source);ledger.beginRead(overflow,'short',10)(11);
 assert.equal(before.traces[0].readings?.[0].endedAt,undefined);
 assert.deepEqual(ledger.snapshot(true).traces[0].readings,[
  {kind:'visual',startedAt:2,endedAt:2.1},{kind:'short',startedAt:3,endedAt:3.5},{kind:'full',startedAt:4,endedAt:7},
 ]);
 assert.equal(ledger.snapshot(true).traces.length,1);
});
