import {CardReadTimeout,type CardReadBudget} from './card-read-budget';
export interface NeuralReading {
  text: string;
  confidence: number;
  candidates?: import("./ctc-lexicon").LexiconCandidate[];
  joined?: NeuralReading;
}
export interface NameLine { group: string; line: 0 | 1 }
export function createNeuralReader(model: "korean" | "digits" = "korean", lexicon?: import("./ctc-lexicon").LexiconEntry[], status?: (message: string) => void,
  onInitializationCleanupError?:(error:unknown)=>void) {
  let worker:Worker;
  let readyPromise:Promise<NeuralReading|null>|undefined;
  let terminalFailure:Error|undefined;
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
  const reportCleanupError=(error:unknown)=>{
    try{void Promise.resolve(onInitializationCleanupError?.(error)).catch(()=>{});}catch{/* Optional observer has no authority. */}
  };
  const stopAndFail=(error:Error)=>{
    if(disposed)return;
    // A failing native termination must not leave the public OCR requests
    // pending. Preserve their original error and report cleanup separately.
    disposed=true;
    try{worker.terminate();}catch(cleanupError){reportCleanupError(cleanupError);}
    finally{fail(error);}
  };
  function startWorker(){
  let fresh:Worker|undefined;
  try{
  fresh = new Worker(new URL("./neural-ocr-worker.ts", import.meta.url),{type:'module'});
  fresh.onerror = (event) => {
    if(worker!==fresh||disposed)return;
    stopAndFail(new Error(event.message || "OCR Worker 오류"));
  };
  fresh.onmessage = (event) => {
    if(worker!==fresh||disposed)return;
    if (typeof event.data.progress === 'string') { status?.(event.data.progress); return; }
    const { id, result, error } = event.data;
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    if (error) item.reject(new Error(error));
    else item.resolve(result);
  };
  worker=fresh;
  }catch(error){
    if(fresh)try{fresh.terminate();}catch(cleanupError){reportCleanupError(cleanupError);}
    throw error;
  }
  }
  startWorker();
  let timeoutRestarts=0;
  function restart(){
    try{worker.onmessage=null;worker.onerror=null;worker.terminate();}
    catch(cleanupError){disposed=true;reportCleanupError(cleanupError);fail(new CardReadTimeout());throw cleanupError;}
    fail(new CardReadTimeout());readyPromise=undefined;
    if(!disposed)try{startWorker();}catch(error){
      // The previous worker is already terminated. A failed replacement is
      // a terminal creation error, not permission to reuse the old worker.
      disposed=true;terminalFailure=error instanceof Error?error:new Error(String(error));fail(terminalFailure);
    }
  }
  function ready(){return readyPromise??=request('ready');}
  function request(type: "ready" | "recognize", source?: HTMLCanvasElement, useLexicon = false, nameLine?: NameLine) {
    if (disposed) return Promise.reject(terminalFailure??new Error("OCR 종료"));
    const id = ++nextId;
    return new Promise<NeuralReading | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // One reading that hangs ends that reading, not the reader: a fresh worker takes the next ones
        // (a few times at most; then the reader stops, as before).
        if (type === "recognize" && timeoutRestarts < 3) {
          timeoutRestarts++;
          try { restart(); return; } catch { /* Fall through: the reader stops. */ }
        }
        stopAndFail(new Error(type === "ready" ? "OCR 준비 시간이 초과됐습니다. 연결을 확인하고 다시 시작해 주세요." : "OCR 시간 초과"));
      }, type === "ready" ? 120000 : 30000);
      pending.set(id, { resolve, reject, timer });
      try{
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
      }catch(error){
        // The Promise constructor rejects on a synchronous throw but does not
        // clean this request's timer/map entry or protect other live requests.
        clearTimeout(timer);pending.delete(id);reject(error);
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
      try{worker.terminate();}finally{fail(new Error("OCR 종료"));}
    },
  };
}
