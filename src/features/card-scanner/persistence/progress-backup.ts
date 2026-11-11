import type { ScannerState } from '../orchestration/scanner';
import { inventoryBackupState, isState } from './scan-backup';

const DB = 'loacard-scan-progress';
const STORE = 'progress';
const KEY = 'current';
const DEFAULT_TIMEOUT_MS = 5_000;
interface ProgressRecord { version: 1; savedAt: number; state: ScannerState }
export interface RestoredProgress { savedAt: number; state: ScannerState }

/** A bounded checkpoint for a scan that ended with the tab still open. It is a
 * display-only receipt: no images, no undo history, and never completion proof. */
export function progressSnapshotState(state: ScannerState): ScannerState {
  // Strip large image strings before the inventory projection clones the state.
  const stripped = {
    ...state,
    cards: state.cards.map(card => ({ ...card, image: '' })),
    unidentified: (state.unidentified ?? []).map(item => ({ ...item, image: '' })),
  };
  delete stripped.growthHistory;
  const snapshot = inventoryBackupState(stripped);
  snapshot.status = '스캔 중지';
  snapshot.interrupted = 'cancelled';
  return snapshot;
}

function openProgress(factory: () => IDBFactory, timeoutMs: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('진행 기록 저장소 응답 시간이 초과됐습니다.')), timeoutMs);
    try {
      const request = factory().open(DB, 1);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => fail(request.error ?? new Error('진행 기록 저장소를 열 수 없습니다.'));
      request.onblocked = () => fail(new Error('다른 탭이 진행 기록 저장소를 사용하고 있습니다.'));
    } catch (error) { fail(error); }
  });
}

export function createProgressBackup(factory: () => IDBFactory = () => indexedDB,
  timeoutMs = DEFAULT_TIMEOUT_MS) {
  let queue: Promise<unknown> = Promise.resolve();
  function access(mode: 'load' | 'save' | 'clear', state?: ScannerState) {
    const task = queue.then(async () => {
      const db = await openProgress(factory, timeoutMs);
      try {
        return await new Promise<RestoredProgress | undefined>((resolve, reject) => {
          const transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
          let result: RestoredProgress | undefined, settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(result);
          };
          const fail = (error: unknown) => {
            finish(error);
            try { transaction.abort(); } catch { /* Already finished. */ }
          };
          const timer = setTimeout(() => fail(new Error('진행 기록 저장 응답 시간이 초과됐습니다.')), timeoutMs);
          transaction.oncomplete = () => finish();
          transaction.onabort = transaction.onerror = () => finish(transaction.error ?? new Error('진행 기록 저장 실패'));
          if (mode === 'save') {
            const snapshot = progressSnapshotState(state!);
            store.put({ version: 1, savedAt: Date.now(), state: snapshot } satisfies ProgressRecord, KEY);
            return;
          }
          if (mode === 'clear') { store.delete(KEY); return; }
          const request = store.get(KEY);
          request.onsuccess = () => {
            if (settled || request.result === undefined) return;
            const stored = request.result as ProgressRecord;
            if (!stored || stored.version !== 1 || !Number.isFinite(stored.savedAt) || !isState(stored.state)) {
              fail(new Error('저장된 진행 기록을 읽을 수 없습니다.'));
              return;
            }
            try {
              result = { savedAt: stored.savedAt, state: progressSnapshotState(stored.state) };
            } catch {
              fail(new Error('저장된 진행 기록을 읽을 수 없습니다.'));
            }
          };
        });
      } finally { db.close(); }
    });
    queue = task.catch(() => {});
    return task;
  }
  return {
    load: () => access('load'),
    save: (state: ScannerState) => {
      if (!isState(state)) return Promise.reject(new Error('저장할 진행 기록 형식이 올바르지 않습니다.'));
      return access('save', state).then(() => undefined);
    },
    clear: () => access('clear').then(() => undefined),
  };
}

const progress = createProgressBackup();
export const loadScanProgress = progress.load;
export const saveScanProgress = progress.save;
export const clearScanProgress = progress.clear;
