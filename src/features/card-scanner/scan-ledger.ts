import type { Box } from "./detector";

export type ObservationStage = "acquired" | "selected" | "rejected" | "filtered" | "duplicate" | "queued" | "superseded" | "deferred" | "identified" | "unidentified" | "dropped";
export interface ObservationTrace {
  id: number; frame: number; time: number; slot: number; box: Box;
  phase: "input" | "recording"; stage: ObservationStage;
  reason?: string; group?: number; cardId?: string; name?: string;
  nameAttempts?: import("./name-diagnostics").NameAttempt[];
  readings?: { kind: 'visual'|'short'|'full'; startedAt: number; endedAt?: number; priorityGroup?: number; priorReads?: number; priorOcrAttempts?: number }[];
}
export interface LedgerSnapshot {
  observations: number; groups: number; frames: number; unlocatedFrames: number;
  stages: Partial<Record<ObservationStage, number>>; unresolvedGroups: number;
  retained: number; truncated: boolean; traces: ObservationTrace[];
  nameDiagnosticsTruncated: number;
}
/** Metadata only: no pixel buffers. Every crop retains its source and final disposition. */
export class ScanLedger {
  private traces: ObservationTrace[] = [];
  private groups = new Map<number, { identified: boolean; unresolved: boolean }>();
  private observations = 0;
  private frames = 0;
  private unlocatedFrames = 0;
  private stages: Partial<Record<ObservationStage, number>> = {};
  private limit: number;
  private overflow = new Map<number, ObservationStage>();
  private diagnosticIds: number[] = [];
  private nameDiagnosticsTruncated = 0;
  constructor(limit = 100_000) { this.limit = limit; }
  frame(located: boolean) { this.frames++; if (!located) this.unlocatedFrames++; }
  beginRead(id:number,kind:'visual'|'short'|'full',startedAt:number,scheduling?:{priorityGroup:number;priorReads:number;priorOcrAttempts?:number}) {
    const trace=this.traces[id-1];
    if(!trace)return (_endedAt:number)=>{};
    const readings=trace.readings??=[];
    if(readings.length>=3)return (_endedAt:number)=>{};
    const reading:NonNullable<ObservationTrace['readings']>[number]={kind,startedAt,...scheduling};
    readings.push(reading);
    return (endedAt:number)=>{reading.endedAt??=endedAt;};
  }
  acquire(input: Omit<ObservationTrace, "id" | "stage">) {
    const id = ++this.observations;
    this.stages.acquired = (this.stages.acquired ?? 0) + 1;
    if (id <= this.limit) this.traces.push({ ...input, box: { ...input.box }, id, stage: "acquired" });
    return id;
  }
  finish(id: number, stage: ObservationStage, details: Partial<Pick<ObservationTrace, "reason" | "group" | "cardId" | "name" | "nameAttempts">> = {}) {
    const trace = this.traces[id - 1];
    const previous = trace?.stage ?? this.overflow.get(id) ?? "acquired";
    this.stages[previous] = Math.max(0, (this.stages[previous] ?? 1) - 1);
    if (trace) {
      Object.assign(trace, details, { stage });
      if (details.nameAttempts?.length && !this.diagnosticIds.includes(id)) {
        this.diagnosticIds.push(id);
        if (this.diagnosticIds.length > 300) {
          const oldest = this.diagnosticIds.shift()!;
          delete this.traces[oldest - 1].nameAttempts;
          this.nameDiagnosticsTruncated++;
        }
      }
    } else if (["acquired", "queued", "deferred"].includes(stage)) this.overflow.set(id, stage);
    else this.overflow.delete(id);
    this.stages[stage] = (this.stages[stage] ?? 0) + 1;
    const group = details.group ?? trace?.group;
    if (group !== undefined) {
      const state = this.groups.get(group) ?? { identified: false, unresolved: false };
      if (stage === "identified") { state.identified = true; state.unresolved = false; }
      if (!state.identified && ["deferred", "unidentified", "dropped"].includes(stage)) state.unresolved = true;
      this.groups.set(group, state);
    }
  }
  snapshot(includeTraces = false): LedgerSnapshot {
    return { observations: this.observations, frames: this.frames, unlocatedFrames: this.unlocatedFrames,
      groups: this.groups.size, stages: { ...this.stages }, unresolvedGroups: [...this.groups.values()].filter(g => g.unresolved).length,
      retained: this.traces.length, truncated: this.observations > this.limit,
      nameDiagnosticsTruncated: this.nameDiagnosticsTruncated,
      traces: includeTraces ? this.traces.map(t => ({ ...t, box: { ...t.box },...(t.readings?{readings:t.readings.map(r=>({...r}))}:{}) })) : [] };
  }
}
