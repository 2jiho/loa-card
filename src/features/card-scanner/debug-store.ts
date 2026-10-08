import type { DebugCapture } from "./debug-capture";

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("loacard-debug-parts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("parts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function access(id: string, part: number, value?: DebugCapture) {
  const db = await database();
  try {
    return await new Promise<DebugCapture | undefined>((resolve, reject) => {
      const transaction = db.transaction("parts", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("parts"), key = `${id}:${part}`;
      const request = value ? store.put(value, key) : store.get(key);
      transaction.oncomplete = () => resolve(value ? undefined : request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export const saveDebugPart = (session: DebugCapture) => access(session.recordingId!, session.part!, session).then(() => {});
export const loadDebugPart = (id: string, part: number) => access(id, part);

/** Remove only a temporary scan's own archived part after it was consumed. */
export async function deleteDebugPart(id: string, part: number) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("parts", "readwrite");
      transaction.objectStore("parts").delete(`${id}:${part}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
