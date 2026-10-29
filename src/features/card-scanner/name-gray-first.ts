export const NAME_GRAY_FIRST_RECIPE = 'gray-first-line-v1' as const;

/** Copy the observed first name line without masking, gain or new evidence.
 * The caller retains the initial 128x36 RGBA; the returned 128x18 owns its bytes.
 */
export function createGrayNameFirstLine(rgba:Uint8ClampedArray):Uint8ClampedArray<ArrayBuffer> {
  if (!(rgba instanceof Uint8ClampedArray) || rgba.byteLength !== 128*36*4)
    throw new Error('Gray name fallback requires initial 128x36 RGBA.');
  const output = new Uint8ClampedArray(128*18*4);
  for (let offset=0;offset<output.length;offset+=4) {
    const value = Math.round(.299*rgba[offset]+.587*rgba[offset+1]+.114*rgba[offset+2]);
    output[offset]=output[offset+1]=output[offset+2]=value;
    output[offset+3]=rgba[offset+3];
  }
  return output;
}
