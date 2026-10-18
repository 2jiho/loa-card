export interface FinishTiming {
  expected: number;
  lastCardInputMs: number;
  namesReadyMs: number;
  finishedMs?: number;
  afterLastCardMs?: number;
  withinTarget?: boolean;
  targetMs: number;
}

/** Capture-clock timestamps, not OCR completion times. No completion decisions. */
export class FinishTimer {
  private firstInputs = new Map<string, number>();
  record(id: string, captureMs: number) {
    if (!Number.isFinite(captureMs) || captureMs < 0) return;
    this.firstInputs.set(id, Math.min(captureMs, this.firstInputs.get(id) ?? Infinity));
  }
  coverage(ids: readonly string[], expected: number | null, now: number): FinishTiming | undefined {
    if (expected === null || expected <= 0 || ids.length !== expected || new Set(ids).size !== expected ||
        ids.some(id => !this.firstInputs.has(id))) return;
    const lastCardInputMs = Math.max(...ids.map(id => this.firstInputs.get(id)!));
    if (!Number.isFinite(now) || now < lastCardInputMs) return;
    return { expected, lastCardInputMs, namesReadyMs: now, targetMs: 10_000 };
  }
  finish(timing: FinishTiming, now: number): FinishTiming {
    const afterLastCardMs = Math.max(0, now - timing.lastCardInputMs);
    return { ...timing, finishedMs: now, afterLastCardMs, withinTarget: afterLastCardMs <= timing.targetMs };
  }
}
