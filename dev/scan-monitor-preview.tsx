import {useLayoutEffect,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {ScanMonitorPanel} from '../src/features/card-scanner/ScanMonitor';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import type {ScanMonitorState,ScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import styles from '../src/features/card-scanner/scan-monitor.css?inline';
import {createMonitorLatencyProbe} from './monitor-latency';
import type {MonitorLatencyProbe} from './monitor-latency';
import type {ScannerFeedback} from '../src/features/card-scanner/scanner-feedback';

type MonitorStatus={busy:boolean;sharing:boolean};

// oxlint-disable-next-line react/only-export-components -- this dev adapter owns its root outside React Fast Refresh
function Preview({store,latency,busy,sharing,onStop}:{store:ScanMonitorStore;latency:MonitorLatencyProbe<ScanMonitorState>;onStop:()=>void}&MonitorStatus) {
  const state=useSyncExternalStore(store.subscribe,store.getSnapshot);
  useLayoutEffect(()=>{latency.commit(state);},[latency,state]);
  return <><style>{styles}</style><ScanMonitorPanel state={state} busy={busy} sharing={sharing} onStop={onStop} feedback={store.getFeedback()}/></>;
}

/** Dev-only view of the production monitor. clear() clears display data only;
 * the caller owns busy/sharing status and scanner cancellation. */
export function createMonitorPreview(host:HTMLElement,onStop:()=>void) {
  const root=createRoot(host),store=createScanMonitorStore();
  const latency=createMonitorLatencyProbe<ScanMonitorState>();
  // Stable subscription: mark the store's canonical snapshot immediately before
  // notifying React. Telemetry never publishes state or requests another render.
  const measuredStore:ScanMonitorStore={...store,subscribe:listener=>store.subscribe(()=>{
    latency.notify(store.getSnapshot());listener();
  })};
  let status:MonitorStatus={busy:false,sharing:false},disposed=false;
  const render=()=>root.render(<Preview store={measuredStore} latency={latency} {...status} onStop={onStop}/>);
  render();
  return {
    publish(state:ScanMonitorState){if(!disposed)store.publish(state);},
    setFeedback(feedback:ScannerFeedback|undefined){if(!disposed)store.setFeedback(feedback);},
    feedbackStats:()=>store.getFeedback()?.stats()??null,
    setStatus(next:MonitorStatus){
      if(disposed||status.busy===next.busy&&status.sharing===next.sharing)return;
      status={busy:next.busy,sharing:next.sharing};render();
    },
    clear(){if(!disposed){store.clear();latency.reset();}},
    stats:latency.stats,
    dispose(){if(disposed)return;disposed=true;root.unmount();store.clear();},
  };
}
