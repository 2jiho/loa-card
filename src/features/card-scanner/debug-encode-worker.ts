import type { DebugFrame } from "./debug-capture";

interface Metadata { id: number; width: number; height: number; time: number; elapsed: number }
type Request = Metadata & ({ pixels: Uint8ClampedArray<ArrayBuffer> } | { bitmap: ImageBitmap });
type Stored = Metadata & { blob: Blob };
const recordingId = crypto.randomUUID();
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("loacard-debug-raw", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("frames");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
void database.catch(() => {});
async function access(id: number, operation: "put" | "get" | "delete", value?: Stored) {
  const db = await database;
  return new Promise<Stored | undefined>((resolve, reject) => {
    const transaction = db.transaction("frames", operation === "get" ? "readonly" : "readwrite");
    const store = transaction.objectStore("frames"), key = `${recordingId}:${id}`;
    const request = operation === "put" ? store.put(value, key) : operation === "delete" ? store.delete(key) : store.get(key);
    transaction.oncomplete = () => resolve(operation === "get" ? request.result : undefined);
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
let pending = Promise.resolve(), lastId = 0, failed = false;
async function flush() {
  try {
    for (let id = 1; id <= lastId; id++) {
      const frame = await access(id, "get");
      if (!frame) throw new Error("임시 기록 프레임 누락");
      const canvas = new OffscreenCanvas(frame.width, frame.height);
      try {
        const pixels = new Uint8ClampedArray(await frame.blob.arrayBuffer());
        canvas.getContext("2d")!.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        const result: DebugFrame = { image: `data:image/png;base64,${btoa(binary)}`, time: frame.time, elapsed: frame.elapsed };
        self.postMessage({ id, frame: result });
        await access(id, "delete");
      } finally { canvas.width = canvas.height = 0; }
    }
    self.postMessage({ done: true });
  } finally { (await database).close(); }
}
self.onmessage = (event: MessageEvent<Request | { finish: true } | { discard:true } | { read: number }>) => {
  const request = event.data;
  pending = pending.then(async () => {
    if (failed) return;
    if ("discard" in request) {
      const db=await database;
      try {
        // Only this worker's temporary raw frames; other scans stay intact.
        await new Promise<void>((resolve,reject)=>{
          const transaction=db.transaction('frames','readwrite');
          transaction.objectStore('frames').delete(IDBKeyRange.bound(`${recordingId}:`,`${recordingId}:\uffff`));
          transaction.oncomplete=()=>resolve();
          transaction.onabort=transaction.onerror=()=>reject(transaction.error);
        });
        self.postMessage({done:true});
      } finally {db.close();}
      return;
    }
    if ("finish" in request) { await flush(); return; }
    if ("read" in request) {
      const frame = await access(request.read, "get");
      if (!frame) throw new Error("임시 기록 프레임 누락");
      const pixels = new Uint8ClampedArray(await frame.blob.arrayBuffer());
      await access(request.read, "delete");
      self.postMessage({ id: request.read, raw: { width: frame.width, height: frame.height, time: frame.time, pixels } }, { transfer: [pixels.buffer] });
      return;
    }
    const { id, width, height, time, elapsed } = request;
    const metadata = { id, width, height, time, elapsed };
    let pixels: Uint8ClampedArray<ArrayBuffer>;
    if ("bitmap" in request) {
      const canvas = new OffscreenCanvas(width, height);
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(request.bitmap, 0, 0);
        pixels = context.getImageData(0, 0, width, height).data;
      } finally { request.bitmap.close(); canvas.width = canvas.height = 0; }
    } else pixels = request.pixels;
    await access(request.id, "put", { ...metadata, blob: new Blob([pixels.buffer]) });
    lastId = request.id;
    self.postMessage({ id: request.id, stored: true });
  }).catch(error => {
    failed = true;
    self.postMessage({ error: error instanceof Error ? error.message : "임시 기록 또는 PNG 압축 실패" });
  });
};
