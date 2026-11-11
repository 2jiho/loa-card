/** A diagnostic task owns one cancellation/deadline scope. Invalidate before
 * replacing it so ignored cancellation and late browser IO cannot publish UI. */
export class CancellableOperation {
  readonly controller = new AbortController();
  private active = true;
  private timer: ReturnType<typeof setTimeout>;
  constructor(timeoutMs: number, message: string) {
    this.timer = setTimeout(() => this.cancel(new Error(message)), timeoutMs);
  }
  get signal() { return this.controller.signal; }
  get current() { return this.active; }
  cancel(reason: unknown = new DOMException('작업을 중지했습니다.', 'AbortError')) { this.controller.abort(reason); }
  dispose() { this.active = false; clearTimeout(this.timer); this.cancel(); }
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise((resolve,reject) => {
      let settled = false;
      const finish = (success: boolean,value: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(this.timer); this.signal.removeEventListener('abort',abort);
        if (success) resolve(value as T); else reject(value);
      };
      const abort = () => finish(false,this.signal.reason);
      this.signal.addEventListener('abort',abort,{once:true});
      if (this.signal.aborted) { abort(); return; }
      try { work(this.signal).then(value => finish(true,value),error => finish(false,error)); }
      catch (error) { finish(false,error); }
    });
  }
}
