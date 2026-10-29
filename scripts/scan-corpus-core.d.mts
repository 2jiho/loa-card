import type { FileHandle } from 'node:fs/promises';
export type CorpusKind = 'video' | 'images' | 'replay';
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
export function corpusCaseId(kind: CorpusKind, orderedHashes: readonly string[]): string;
export function readCorpusBytes(path: string, maxBytes?: number): Promise<Uint8Array>;
export function readCorpusJson(path: string, maxBytes?: number): Promise<unknown>;
export function addCorpusCase(files: string[], options?: { root?: string; name?: string; kind?: CorpusKind }): Promise<{ created: boolean; manifest: CorpusManifest }>;
export function listCorpusCases(options?: { root?: string }): Promise<CorpusSummary[]>;
export function readCorpusCase(options: { root?: string; id: string }): Promise<CorpusManifest>;
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
export function verifyCorpus(options?: { root?: string; id?: string }): Promise<{ verified: true; cases: number; inputs: number; objects: number; bytes: number }>;
