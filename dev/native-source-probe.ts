import { createNativeSourceProbe, formatProbeReport } from './native-source-profile';
import type { ProbePlatform, ProbeState, ProbeTrack } from './native-source-profile';

interface TrackProcessor { readable: ReadableStream<VideoFrame> }
type TrackProcessorConstructor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => TrackProcessor;
const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const status = document.querySelector<HTMLElement>('#status')!;
const result = document.querySelector<HTMLElement>('#result')!;
let reportText: string | null = null;
const urls = new Set<string>();

const messages: Record<ProbeState['status'], string> = {
  idle: '시작 버튼을 누르면 공유할 창을 직접 선택합니다.',
  selecting: '공유할 창을 선택해 주세요. 창 이름은 기록하지 않습니다.',
  waiting: '첫 네이티브 프레임을 기다립니다. 5초 안에 없으면 자동 중지합니다.',
  completed: '메타데이터 확인 완료 · 화면 공유를 종료했습니다.',
  cancelled: '중지 또는 선택 취소됨. 선택 창이 남아 있으면 직접 취소해 주세요.',
  timeout: '첫 프레임 대기 5초 초과 · 화면 공유를 종료했습니다.',
  unsupported: '이 probe의 현재 실행 경로에서 직접 트랙 프레임 검사를 지원하지 않습니다.',
  error: '검사를 완료하지 못했습니다. 공유를 종료하고 결과에 실패 상태를 남겼습니다.',
};
function update(state: ProbeState) {
  const busy = state.status === 'selecting' || state.status === 'waiting';
  run.disabled = busy; stop.disabled = !busy;
  status.textContent = messages[state.status];
  reportText = state.report ? formatProbeReport(state.report) : null;
  result.textContent = reportText ?? '';
  save.disabled = !reportText;
}
const platform: ProbePlatform = {
  captureSupported: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
  processorSupported: typeof Processor === 'function',
  requestCapture: options => navigator.mediaDevices.getDisplayMedia(options),
  createReader: (track: ProbeTrack) => new Processor!({ track: track as MediaStreamTrack, maxBufferSize: 1 }).readable.getReader(),
};
const controller = createNativeSourceProbe(platform, update);
const startProbe = () => { void controller.start(); };
const stopProbe = () => controller.stop();
function saveReport() {
  if (!reportText) return;
  // Save only the bounded allowlisted metadata, never a stream/frame object.
  const url = URL.createObjectURL(new Blob([reportText], { type: 'application/json;charset=utf-8' }));
  urls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = 'loa-card-native-source-profile.json';
  link.hidden = true; document.body.append(link); link.click(); link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 0);
}
function clearDownloadUrls() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}
function onPageHide() {
  // BFCache may restore this same document. Stop capture (including a late
  // picker grant), but retain the controller and buttons for the next click.
  controller.stop();
  clearDownloadUrls();
}
function cleanup() {
  controller.dispose();
  run.removeEventListener('click', startProbe); stop.removeEventListener('click', stopProbe); save.removeEventListener('click', saveReport);
  window.removeEventListener('pagehide', onPageHide);
  clearDownloadUrls();
}
run.addEventListener('click', startProbe); stop.addEventListener('click', stopProbe); save.addEventListener('click', saveReport);
window.addEventListener('pagehide', onPageHide);
import.meta.hot?.dispose(cleanup);
update({ status: 'idle', report: null });
