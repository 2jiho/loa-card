import { runScanner } from '../src/features/card-scanner/scanner';
import type { ScannerState } from '../src/features/card-scanner/scanner';
import { decodeImageSources } from '../src/features/card-scanner/input-source';

const form = document.querySelector('form')!;
const filesInput = document.querySelector<HTMLInputElement>('#files')!;
const captureOnly = document.querySelector<HTMLInputElement>('#capture-only')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const video = document.querySelector('video')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const result = document.querySelector<HTMLPreElement>('#result')!;
let controller: AbortController | undefined;
let latest: ScannerState | undefined;
let inputDescription: { name: string; bytes: number; type: string }[] = [];
let ended = false;
let runCaptureOnly = false;
const currentState = (): ScannerState | undefined => latest;

function update(state: ScannerState) {
  latest = state;
  message.textContent = state.status;
  result.textContent = JSON.stringify({
    status: state.status, percent: state.percent, sampled: state.sampled,
    expected: state.expected, identified: state.cards.length,
    currentRunRead: state.currentRunRead ?? 0,
    review: state.cards.filter(card => card.review.length).length,
    unreadable: state.unreadable, queued: state.queued, growthPoints: state.growthPoints,
    acquisition: state.captureDiagnostics && {
      acquired: state.captureDiagnostics.acquired, rejected: state.captureDiagnostics.rejected,
      duplicates: state.captureDiagnostics.duplicates, reasons: state.captureDiagnostics.reasons,
    },
  }, null, 2);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (controller) return;
  const files = [...filesInput.files ?? []].sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  const images = files.length > 0 && files.every(file => file.type.startsWith('image/'));
  if (!images && !(files.length === 1 && files[0].type.startsWith('video/'))) {
    message.textContent = '영상 하나 또는 이미지 파일만 선택하세요.';
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  const urls = files.map(file => URL.createObjectURL(file));
  inputDescription = files.map(file => ({ name: file.name, bytes: file.size, type: file.type }));
  latest = undefined;
  ended = false;
  runCaptureOnly = captureOnly.checked;
  start.disabled = filesInput.disabled = captureOnly.disabled = true;
  stop.disabled = false;
  save.disabled = true;
  result.textContent = '';
  message.textContent = '입력을 준비하고 있습니다.';
  try {
    let stillImages: HTMLImageElement[] | undefined;
    if (images) stillImages = await decodeImageSources(urls);
    else {
      video.src = urls[0];
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('영상을 열 수 없습니다.')); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
        signal.addEventListener('abort', aborted, { once: true });
        video.load();
      });
    }
    signal.throwIfAborted();
    await runScanner(video, 'video', signal, update, [], undefined, 'all', stillImages, runCaptureOnly);
    ended = true;
    message.textContent = runCaptureOnly
      ? `획득 검사 완료 · ${currentState()?.captureDiagnostics?.acquired ?? 0}크롭 · OCR 미실행`
      : `입력 처리 완료 · ${currentState()?.cards.length ?? 0}종 (수량·필드 정확도는 별도 확인)`;
  } catch (error) {
    message.textContent = signal.aborted ? '검사를 중지했습니다. 저장 시 부분 결과로 표시합니다.' : String(error);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    urls.forEach(url => URL.revokeObjectURL(url));
    controller = undefined;
    start.disabled = filesInput.disabled = captureOnly.disabled = false;
    stop.disabled = true;
    save.disabled = !latest;
  }
});

stop.addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => controller?.abort());
save.addEventListener('click', () => {
  if (!latest || controller) return;
  const blob = new Blob([JSON.stringify({ ...latest, validation: {
    mode: 'offline', input: inputDescription, captureOnly: runCaptureOnly,
    completed: ended, startedWithCards: 0, browser: navigator.userAgent,
  } }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `loacard-validation-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
