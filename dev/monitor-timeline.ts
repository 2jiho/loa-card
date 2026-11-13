/** Development only (docs/dev-recording.md, "진행 창 자동 점검"). What the progress window showed
 * during a replay, one entry per published scan state: the same projection the app's progress
 * window draws (rowScannerState -> projectScanMonitorState -> monitorAction). Checked by
 * scripts/check-monitor-timeline.mjs and drawn by dev/monitor-timeline.html. */
import {rowScannerState} from '../src/features/card-scanner/orchestration/row-scanner-state';
import type {RowScanSnapshot} from '../src/features/card-scanner/orchestration/row-scan';
import {projectScanMonitorState} from '../src/features/card-scanner/ui/scan-monitor-store';
import type {ScanMonitorState} from '../src/features/card-scanner/ui/scan-monitor-store';
import {scanMonitorOutcome} from '../src/features/card-scanner/session/scan-monitor-outcome';
import {monitorAction} from '../src/features/card-scanner/ui/monitor-action';
import type {ListGuidanceMap} from '../src/features/card-scanner/session/list-guidance';

export interface MonitorTimelineEntry {
  /** Milliseconds since the first entry. */
  readonly t:number;
  readonly phase:RowScanSnapshot['phase'];
  readonly sharing:boolean;readonly busy:boolean;
  readonly header:string;readonly action:string;readonly ready:boolean;readonly detail:string|null;
  readonly read:number;readonly names:number;readonly expected:number|null;readonly review:number;readonly queued:number;
  readonly located:boolean|undefined;
  /** Cards that carry a picture from the screen (the card list shows it instead of the artwork). */
  readonly pictures:number;
  /** The progress window's list map, as drawn. */
  readonly map:ListGuidanceMap|null;
  /** The whole state the progress window draws (no pictures), for dev/monitor-timeline.html. */
  readonly monitor:ScanMonitorState;
}

export function createMonitorTimeline(limit=1500) {
  const entries:MonitorTimelineEntry[]=[];
  let began:number|null=null,dropped=0;
  return {
    entries,
    get dropped(){return dropped;},
    onSnapshot(snapshot:RowScanSnapshot){
      const now=performance.now();began??=now;
      if(entries.length>=limit){dropped++;return;}
      const state=rowScannerState(snapshot),sharing=snapshot.phase==='capture',busy=snapshot.phase!=='done';
      const monitor=projectScanMonitorState(state),outcome=scanMonitorOutcome(monitor,{busy,sharing});
      const action=monitorAction(outcome,sharing,monitor);
      entries.push({t:Math.round(now-began),phase:snapshot.phase,sharing,busy,header:outcome.header,action:action.message,ready:action.ready,
        detail:outcome.detail??null,read:monitor.currentRunRead??0,names:monitor.currentRunNames??0,expected:monitor.expected??null,
        review:monitor.review??0,queued:monitor.queued??0,located:monitor.located,pictures:snapshot.cards.filter(card=>!!card.image).length,map:monitor.map?JSON.parse(JSON.stringify(monitor.map)) as ListGuidanceMap:null,
        monitor:JSON.parse(JSON.stringify({...monitor,grid:undefined})) as ScanMonitorState});
    },
  };
}
