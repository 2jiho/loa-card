import type { FileHandle } from 'node:fs/promises';
export type CorpusKind = 'video' | 'images' | 'replay' | 'raw-session';
export interface CorpusInput {
  index: number; name: string; sha256: string; bytes: number; extension: string; path: string; object: string;
}
export interface CorpusManifest {
  version: 1; id: string; name: string; kind: CorpusKind; createdAt: string;
  source: { capturedAt: null; completeness: 'unknown' }; inputs: CorpusInput[]; baseline: null; expected: null;
}
export interface CorpusSummary extends Omit<CorpusManifest, 'version' | 'inputs'> { inputs: number; bytes: number }
export const DEFAULT_CORPUS_ROOT: string;
export const MAX_CORPUS_RUN_BYTES: number;
export type CorpusWriterLockStatus = { state:'absent'|'unknown' } | { state:'owned'; owner:{ version:1; action:'add'|'run'; pid:number; host:string; createdAt:string; token:string }; processState:'present'|'absent'|'unknown' };
export function inspectCorpusWriterLock(options?: { root?: string }): Promise<CorpusWriterLockStatus>;
export function corpusCaseId(kind: CorpusKind, orderedHashes: readonly string[]): string;
export function readCorpusBytes(path: string, maxBytes?: number): Promise<Uint8Array>;
export function readCorpusJson(path: string, maxBytes?: number): Promise<unknown>;
export interface CorpusInputSelection {id:string;selectedAt:string|null;registrationStartedAt:string;lastModifiedMs:readonly (number|null)[]}
export interface CorpusSelectionReceipt {id:string;sha256:string}
export function validateCorpusInputSelection(value:unknown, count:number):CorpusInputSelection;
export function addCorpusCase(files: string[], options?: { root?: string; name?: string; kind?: CorpusKind; signal?: AbortSignal; expectedInputs?: readonly {sha256:string;bytes:number}[]; selection?: CorpusInputSelection }): Promise<{ created: boolean; manifest: CorpusManifest; selection?:CorpusSelectionReceipt }>;
export function listCorpusCases(options?: { root?: string }): Promise<CorpusSummary[]>;
export function readCorpusCase(options: { root?: string; id: string }): Promise<CorpusManifest>;
export function readCorpusInputSelection(options:{root?:string;id:string;selectionId:string;signal?:AbortSignal}):Promise<{
  record:{version:1;caseId:string;kind:CorpusKind;selection:CorpusInputSelection;inputs:readonly {index:number;extension:string;bytes:number;sha256:string}[];captureTime:null};
  sha256:string;scope:'client-reported-selection-and-ordered-case-identity-only';
}>;
export type CorpusRunClassification = 'completed' | 'partial' | 'cancelled' | 'failed' | 'interrupted' | 'source-changed' | 'source-unverified' | 'unknown';
export interface CorpusRunSummary {
  classification: CorpusRunClassification; reportedOutcome: CorpusRunClassification;
  sourceChanged: boolean | null; verification: 'unverified'; cards: number; expected: number | null; read: number; unidentified: number;
}
export interface StoredCorpusRun { created: boolean; id: string; sha256: string; file: string; summary: CorpusRunSummary }
export class CorpusRunError extends Error {
  readonly code: 'CORPUS_RUN_TOO_LARGE' | 'CORPUS_RUN_INVALID' | 'CORPUS_CASE_NOT_FOUND' | 'CORPUS_BUSY' | 'CORPUS_RUN_STORAGE';
  constructor(code: CorpusRunError['code'], message: string);
}
export function storeCorpusRun(bytes: Uint8Array, options: { id: string; root?: string }): Promise<StoredCorpusRun>;
export function openCorpusInput(options: { root?: string; id: string; index: number }): Promise<{ handle: FileHandle; input: CorpusInput }>;
export function verifyCorpus(options?: { root?: string; id?: string; signal?: AbortSignal }): Promise<{ verified: true; cases: number; inputs: number; objects: number; bytes: number }>;
