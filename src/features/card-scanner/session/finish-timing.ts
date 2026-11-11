export interface FinishTiming {
  /** Name coverage only; does not attest unobscured/latest field input. */
  measurementBasis: 'first-identified-card-captures';
  sufficientInputVerified: false;
  expected: number;
  lastCardInputMs: number;
  namesReadyMs: number;
  /** Only present after this scanner has stopped the live share itself. */
  autoStoppedMs?: number;
  afterLastIdentifiedToAutoStopMs?: number;
  finishedMs?: number;
  afterLastCardMs?: number;
  /** Comparison for the name-coverage proxy, not the actual scan goal. */
  identifiedCaptureWithinTarget?: boolean;
  /** Input sufficiency is not measured by this timer. */
  goalWithinTarget: null;
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
    return { measurementBasis: 'first-identified-card-captures', sufficientInputVerified: false,
      expected, lastCardInputMs, namesReadyMs: now, targetMs: 10_000, goalWithinTarget: null };
  }
  stopSharing(timing: FinishTiming, now: number): FinishTiming {
    if (!Number.isFinite(now) || now < timing.namesReadyMs || now < timing.lastCardInputMs || timing.autoStoppedMs !== undefined)
      throw new RangeError('Invalid or duplicate auto-stop timestamp.');
    return { ...timing, autoStoppedMs: now, afterLastIdentifiedToAutoStopMs: now - timing.lastCardInputMs };
  }
  finish(timing: FinishTiming, now: number): FinishTiming {
    if (!Number.isFinite(now) || now < timing.namesReadyMs || now < timing.lastCardInputMs ||
        (timing.autoStoppedMs !== undefined && now < timing.autoStoppedMs))
      throw new RangeError('Finish timestamp precedes coverage or is not finite.');
    const afterLastCardMs = now - timing.lastCardInputMs;
    return { ...timing, finishedMs: now, afterLastCardMs, identifiedCaptureWithinTarget: afterLastCardMs <= timing.targetMs };
  }
}
