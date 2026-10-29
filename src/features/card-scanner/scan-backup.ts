import type { ScannerState } from './scanner';
import {boundedUnresolvedFieldChanges} from './current-scan-fields';

const SLOT = 'current';
interface Backup { version: 1; revision: string; savedAt: number; state: ScannerState | null }
export class BackupConflict extends Error {
  constructor() { super('다른 탭에서 저장한 목록이 있습니다. 현재 목록은 CSV로 보관하고 저장된 목록을 다시 불러오세요.'); }
}
export class LegacyBackupChoice extends Error {
  readonly choices: { key: string; count: number; names: string; xp?: number }[];
  constructor(choices: LegacyBackupChoice['choices']) {
    super('이전 백업이 여러 개입니다. 복원할 목록을 선택해 주세요.');
    this.choices = choices;
  }
}
function isState(value: unknown): value is ScannerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ScannerState;
  if (boundedUnresolvedFieldChanges(state).unresolvedFieldChangesUnavailable) return false;
  if (typeof state.status !== 'string' || !Array.isArray(state.cards)) return false;
  const ids = new Set<string>();
  const integerOrNull = (n: unknown, max: number) => n === null ||
    (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max);
  for (const card of state.cards) {
    if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !card.id || ids.has(card.id) ||
      typeof card.name !== 'string' || !card.name || !Array.isArray(card.review) || !card.review.every(reason => typeof reason === 'string') ||
      !integerOrNull(card.awakening, 5) || !integerOrNull(card.extraCopies, 15) ||
      typeof card.image !== 'string' || !Number.isFinite(card.confidence) || !Number.isFinite(card.time) ||
      !Number.isInteger(card.observations) || card.observations < 0) return false;
    ids.add(card.id);
  }
  return state.growthPoints == null || (Number.isFinite(state.growthPoints.current) &&
    state.growthPoints.current >= 0 && (state.growthPoints.maximum === null ||
    (Number.isFinite(state.growthPoints.maximum) && state.growthPoints.maximum >= state.growthPoints.current)));
}
/** Persist inventory and its proof, never capture queues, raw diagnostics or the
 * live grid. Keep null values and card evidence unchanged; they decide whether a
 * restored field may be used by calculations. Legacy full states use the same
 * projection when loaded so obsolete diagnostics are not restored into React. */
export function inventoryBackupState(state: ScannerState): ScannerState {
  if (boundedUnresolvedFieldChanges(state).unresolvedFieldChangesUnavailable) throw new Error('저장할 최신 필드 상태가 올바르지 않습니다.');
  const keys = ['status','percent','sampled','stable','expected','capacity','cards','seededCards',
    'growthPoints','growthPointsEstimated','growthHistory','sort','located','unreadable','unidentified',
    'currentRunNames','currentRunRead','unattributedFieldReviews','unresolvedFieldChanges','autoStopped','interrupted','droppedFrames','liveMissedFrames',
    'captureWarning','processingWarning','scrollGaps','recoverySkipped'] as const;
  const inventory: Partial<ScannerState> = {};
  for (const key of keys) if (Object.hasOwn(state,key)) Object.assign(inventory,{[key]:state[key]});
  if (Object.hasOwn(state,'queued')) inventory.queued = 0;
  return structuredClone(inventory) as ScannerState;
}

function openBackup(factory: () => IDBFactory, timeoutMs: number) {
  return new Promise<IDBDatabase>((resolve,reject) => {
    let done = false;
    const fail = (error: unknown) => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error('브라우저 저장소 응답 시간이 초과됐습니다. 다시 시도해 주세요.')),timeoutMs);
    try {
      const request = factory().open('loacard-scan-backups',1);
      request.onupgradeneeded = () => { if (done) { request.transaction?.abort(); return; } request.result.createObjectStore('scans'); };
      request.onsuccess = () => {
        if (done) { request.result.close(); return; }
        done = true; clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => fail(request.error ?? new Error('브라우저 저장소를 열 수 없습니다.'));
      request.onblocked = () => fail(new Error('다른 탭이 저장소 변경을 기다리고 있습니다. 다른 LoaCard 탭을 닫고 다시 시도해 주세요.'));
    } catch (error) { fail(error); }
  });
}

/** Shared per origin; atomic revisions prevent stale tabs from overwriting a
 * newer scan or resurrecting a cleared inventory. */
export function createScanBackup(factory: () => IDBFactory = () => indexedDB,
  legacyKey: () => string | null = () => { try { return sessionStorage.getItem('loacard-tab-backup'); } catch { return null; } },
  limits: {openTimeoutMs?: number; transactionTimeoutMs?: number} = {}) {
  let revision: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function access(mode: 'load' | 'save' | 'clear', state?: ScannerState, selectedLegacy?: string) {
    const task = queue.then(async () => {
      const db = await openBackup(factory, limits.openTimeoutMs ?? 5_000);
      try {
        return await new Promise<ScannerState | undefined>((resolve, reject) => {
          const transaction = db.transaction('scans', 'readwrite'), store = transaction.objectStore('scans');
          let result: ScannerState | undefined, nextRevision: string | undefined, settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) reject(error); else { revision = nextRevision; resolve(result); }
          };
          const fail = (error: unknown) => { finish(error); try { transaction.abort(); } catch { /* Already finished. */ } };
          const timer = setTimeout(() => fail(new Error('목록 저장 응답 시간이 초과됐습니다. 다시 시도해 주세요.')),limits.transactionTimeoutMs ?? 8_000);
          transaction.oncomplete = () => finish();
          transaction.onabort = transaction.onerror = () => finish(transaction.error ?? new Error('브라우저 저장 실패'));
          const request = store.get(SLOT);
          request.onsuccess = () => {
            if (settled) return;
            const stored = request.result as Backup | undefined;
            if (stored && (stored.version !== 1 || typeof stored.revision !== 'string' || (stored.state !== null && !isState(stored.state)))) {
              fail(new Error('저장된 목록 형식을 읽을 수 없습니다. 브라우저 데이터를 지우기 전에 CSV 백업을 확인해 주세요.')); return;
            }
            nextRevision = stored?.revision ?? '';
            if (mode !== 'load') {
              if (revision === undefined || revision !== nextRevision) { fail(new BackupConflict()); return; }
              if (mode === 'save' && !isState(state)) { fail(new Error('저장할 목록 형식이 올바르지 않습니다.')); return; }
              nextRevision = crypto.randomUUID();
              // Keep ambiguous legacy backups until the user can export them.
              if (mode === 'clear') store.clear();
              else if (legacyKey()) store.delete(legacyKey()!);
              store.put({ version: 1, revision: nextRevision!, savedAt: Date.now(), state: mode === 'clear' ? null : state! } satisfies Backup, SLOT);
              return;
            }
            if (stored) {
              if (selectedLegacy !== undefined) { fail(new Error('다른 탭에서 저장 목록이 변경됐습니다. 저장 목록을 다시 확인해 주세요.')); return; }
              result = stored.state ? inventoryBackupState(stored.state) : undefined; return;
            }
            const all = store.getAll(), keys = store.getAllKeys();
            keys.onsuccess = () => {
              if (settled) return;
              const index = keys.result.indexOf(selectedLegacy ?? legacyKey() ?? '');
              if (selectedLegacy !== undefined && index < 0) { fail(new Error('선택한 이전 백업이 없습니다. 저장 목록을 다시 확인해 주세요.')); return; }
              const candidate = index >= 0 ? all.result[index] : all.result.length === 1 ? all.result[0] : undefined;
              if (candidate && !isState(candidate)) { fail(new Error('이전 백업을 읽을 수 없습니다.')); return; }
              if (candidate) {
                result = inventoryBackupState(candidate);
                nextRevision = crypto.randomUUID();
                store.delete(keys.result[index >= 0 ? index : 0]);
                store.put({ version: 1, revision: nextRevision, savedAt: Date.now(), state: result } satisfies Backup, SLOT);
              } else if (all.result.length) {
                fail(new LegacyBackupChoice(all.result.flatMap((saved, i) => isState(saved) && typeof keys.result[i] === 'string'
                  ? [{ key: keys.result[i] as string, count: saved.cards.length, names: saved.cards.slice(0, 3).map(card => card.name).join(', '), xp: saved.growthPoints?.current }]
                  : [])));
              }
            };
          };
        });
      } finally { db.close(); }
    });
    queue = task.catch(() => {});
    return task;
  }
  return { load: (selectedLegacy?: string) => access('load', undefined, selectedLegacy), save: (state: ScannerState) => {
    // Validate before projection so malformed entries cannot be hidden by it.
    if (!isState(state)) return Promise.reject(new Error('저장할 목록 형식이 올바르지 않습니다.'));
    return access('save',inventoryBackupState(state));
  }, clear: () => access('clear') };
}
const backup = createScanBackup();
export const loadScanBackup = backup.load;
export const saveScanBackup = backup.save;
export const clearScanBackup = backup.clear;
