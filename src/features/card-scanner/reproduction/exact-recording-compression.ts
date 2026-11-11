import {compressBlock, decompressBlock} from 'lz4-lite';

/** Rebuild a frame from fixed 16 KiB delta blocks. This is the low-level
 * byte operation only; it does not know card identity or recording state. */
export function unpackPixels(delta: Uint8Array, target: Uint8Array, xor = false) {
  if (delta.length < 4) throw Error('잘린 픽셀 기록');
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  const count = view.getUint32(0, true);
  let offset = 4, end = 0;
  if (count > Math.ceil(target.length / 16_384)) throw Error('픽셀 블록 수 초과');
  for (let i = 0; i < count; i++) {
    if (offset + 8 > delta.length) throw Error('잘린 픽셀 블록');
    const from = view.getUint32(offset, true), length = view.getUint32(offset + 4, true);
    if (from < end || from % 16_384 || length !== Math.min(16_384, target.length - from) ||
        length <= 0 || from + length > target.length || offset + 8 + length > delta.length) {
      throw Error('잘못된 픽셀 블록');
    }
    if (xor) {
      for (let j = 0; j < length; j++) target[from + j] ^= delta[offset + 8 + j];
    } else {
      target.set(delta.subarray(offset + 8, offset + 8 + length), from);
    }
    end = from + length;
    offset += 8 + length;
  }
  if (offset !== delta.length) throw Error('불필요한 픽셀 데이터');
}

export async function deflate(data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await new Response(
    new Blob([data]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
}

export async function inflate(data: Blob, maximum: number) {
  const reader = data.stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > maximum) throw Error('압축 해제 용량 초과');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.length;
  }
  return output;
}

/** Speed-first, bounded LZ4 block; raw fallback for tiny/incompressible deltas. */
export function fastCompress(data: Uint8Array<ArrayBuffer>) {
  const output = compressBlock(data), size = output.length, compressed = size < data.length;
  const result = new Uint8Array(5 + (compressed ? size : data.length));
  result[0] = compressed ? 1 : 0;
  new DataView(result.buffer).setUint32(1, data.length, true);
  result.set(compressed ? output.subarray(0, size) : data, 5);
  return result;
}

export function fastInflate(input: Uint8Array, maximum: number) {
  if (input.length < 5 || input[0] > 1) throw Error('잘못된 LZ4 기록');
  const size = new DataView(input.buffer, input.byteOffset, input.length).getUint32(1, true);
  if (size > maximum) throw Error('압축 해제 용량 초과');
  const data = input.subarray(5);
  if (input[0] === 0) {
    if (data.length !== size) throw Error('원본 블록 길이 오류');
    return data;
  }
  // The library decoder trusts its input. Validate every token before allocating/copying.
  let i = 0, written = 0;
  const extended = (base: number) => {
    if (base !== 15) return base;
    let value;
    do {
      if (i >= data.length) throw Error('잘린 LZ4 길이');
      value = data[i++];
      base += value;
      if (base > maximum) throw Error('LZ4 길이 초과');
    } while (value === 255);
    return base;
  };
  while (i < data.length) {
    const token = data[i++], literal = extended(token >>> 4);
    if (i + literal > data.length || written + literal > size) throw Error('LZ4 리터럴 초과');
    i += literal;
    written += literal;
    if (i === data.length) break;
    if (i + 2 > data.length) throw Error('잘린 LZ4 오프셋');
    const offset = data[i] | data[i + 1] << 8;
    i += 2;
    if (!offset || offset > written) throw Error('잘못된 LZ4 오프셋');
    written += extended(token & 15) + 4;
    if (written > size) throw Error('LZ4 출력 초과');
  }
  if (written !== size) throw Error('LZ4 출력 길이 오류');
  return decompressBlock(data, size);
}
