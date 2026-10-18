import {CardReadTimeout,type CardReadBudget} from './card-read-budget';
export interface NeuralReading {
  text: string;
  confidence: number;
  candidates?: import("./ctc-lexicon").LexiconCandidate[];
  joined?: NeuralReading;
}
export interface NameLine { group: string; line: 0 | 1 }
export function createNeuralReader(model: "korean" | "digits" = "korean", lexicon?: import("./ctc-lexicon").LexiconEntry[], status?: (message: string) => void) {
  let worker:Worker;
  let readyPromise:Promise<NeuralReading|null>|undefined;
  let nextId = 0,
    disposed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: NeuralReading | null) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function fail(error: Error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }
  function startWorker(){
  worker = new Worker(new URL("./neural-ocr-worker.ts", import.meta.url),{type:'module'});
  worker.onerror = (event) => {
    worker.terminate();
    disposed = true;
    fail(new Error(event.message || "OCR Worker 오류"));
  };
  worker.onmessage = (event) => {
    if (typeof event.data.progress === 'string') { status?.(event.data.progress); return; }
    const { id, result, error } = event.data;
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    if (error) item.reject(new Error(error));
    else item.resolve(result);
  };
  }
  startWorker();
  function restart(){
    worker.onmessage=null;worker.onerror=null;worker.terminate();
    fail(new CardReadTimeout());readyPromise=undefined;
    if(!disposed)startWorker();
  }
  function ready(){return readyPromise??=request('ready');}
  function request(type: "ready" | "recognize", source?: HTMLCanvasElement, useLexicon = false, nameLine?: NameLine) {
    if (disposed) return Promise.reject(new Error("OCR 종료"));
    const id = ++nextId;
    return new Promise<NeuralReading | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        disposed = true;
        fail(new Error(type === "ready" ? "OCR 준비 시간이 초과됐습니다. 연결을 확인하고 다시 시작해 주세요." : "OCR 시간 초과"));
      }, type === "ready" ? 120000 : 30000);
      pending.set(id, { resolve, reject, timer });
      if (!source) worker.postMessage({ id, type, model, lexicon });
      else {
        const data = source
          .getContext("2d", { willReadFrequently: true })!
          .getImageData(0, 0, source.width, source.height).data;
        worker.postMessage(
          { id, type, model, data, width: source.width, height: source.height, useLexicon, nameLine },
          [data.buffer],
        );
      }
    });
  }
  return {
    async ready() {
      await ready();
    },
    async recognize(source: HTMLCanvasElement, useLexicon = false, nameLine?: NameLine, budget?:CardReadBudget) {
      const read=async()=>{await ready();budget?.check();return (await request("recognize", source, useLexicon, nameLine))!;};
      return budget ? budget.wait(read,restart) : read();
    },
    dispose() {
      disposed = true;
      worker.terminate();
      fail(new Error("OCR 종료"));
    },
  };
}
