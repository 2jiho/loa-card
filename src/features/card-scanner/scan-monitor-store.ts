import type {ScannerState} from './scanner';

export type ScanMonitorState=Pick<ScannerState,'grid'|'currentRunRead'|'expected'|'capacity'|'interrupted'>;

/** The small progress window publishes independently of the card-list transition.
 * Retains no card crops, recording pixels, or recognition evidence. */
export function createScanMonitorStore() {
  let value:ScanMonitorState|null=null;
  const listeners=new Set<()=>void>();
  const notify=()=>listeners.forEach(listener=>listener());
  return {
    getSnapshot:()=>value,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    publish(next:ScanMonitorState) {
      if(value&&value.grid===next.grid&&value.currentRunRead===next.currentRunRead&&value.expected===next.expected&&
        value.capacity===next.capacity&&value.interrupted===next.interrupted)return;
      value={grid:next.grid,currentRunRead:next.currentRunRead,expected:next.expected,capacity:next.capacity,interrupted:next.interrupted};
      notify();
    },
    clear(){if(value){value=null;notify();}},
  };
}
export type ScanMonitorStore=ReturnType<typeof createScanMonitorStore>;
