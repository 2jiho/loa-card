import { encodeCandidatePreviewImage } from './candidate-preview-image';

self.onmessage = (event: MessageEvent<{ id: number; bitmap: ImageBitmap }>) => {
  const { id, bitmap } = event.data;
  void encodeCandidatePreviewImage(bitmap).then(
    image => self.postMessage({ id, image }),
    error => self.postMessage({ id, error: error instanceof Error ? error.message : 'Preview encoding failed' }),
  );
};
