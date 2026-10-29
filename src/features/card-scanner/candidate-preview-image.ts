/** Runs only in the preview worker. Pixel compression and base64 construction
 * never compete with React rendering or HTMLCanvasElement.toBlob's idle work. */
export async function encodeCandidatePreviewImage(bitmap: ImageBitmap,
  makeCanvas = (width: number, height: number) => new OffscreenCanvas(width, height)): Promise<string> {
  let canvas: OffscreenCanvas | undefined, closed = false;
  try {
    canvas = makeCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Preview canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close(); closed = true;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
  } finally {
    if (!closed) bitmap.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
}
