/** Shared physical-frame bounds and byte integrity, independent of storage kind. */
export const MAX_FRAME_BYTES=64*1024*1024;
export async function pixelHash(data:Uint8Array<ArrayBuffer>):Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))]
    .map(value=>value.toString(16).padStart(2,'0')).join('');
}
