import {MAX_FRAME_BYTES} from './recording-frame-integrity';

/** Fixed native storage recipe. This is signal R'G'B', not color-managed sRGB. */
export interface NativeYuvFrameMetadata {
  format: string | null;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  visibleRect: {x: number; y: number; width: number; height: number} | null;
  rotation: number;
  flip: boolean;
  colorSpace: {primaries: string | null; transfer: string | null; matrix: string | null; fullRange: boolean | null};
}
export interface NativeYuvPlaneLayout {readonly offset: number; readonly stride: number}
export interface NativeYuvRecipeManifest {
  readonly id: string;
  readonly version: 1;
  readonly profile: 'bt601-smpte170m-limited' | 'bt709-limited';
  readonly colorSpace: Readonly<NativeYuvFrameMetadata['colorSpace']>;
  readonly lumaWeights: Readonly<{red: number; green: number; blue: number; denominator: number}>;
  readonly inputBias: readonly [16, 128, 128];
  readonly inputScale: readonly [219, 224, 224];
  readonly integerMatrix: Readonly<{denominator: number; y: number; redV: number; blueU: number; greenU: number; greenV: number}>;
  readonly chroma: 'nearest-floor-x/2-y/2';
  readonly rounding: 'floor((numerator+denominator/2)/denominator)';
  readonly clipping: 'final-only-0-255';
  readonly transferConversion: 'none';
  readonly output: 'opaque-signal-RGBA8';
  readonly alpha: 255;
  readonly maximumAbsoluteRoundedNumerator: number;
  readonly sources: readonly string[];
}
export interface NativeYuvPlan {
  readonly format: 'I420' | 'NV12';
  readonly width: number;
  readonly height: number;
  readonly nativeByteLength: number;
  readonly rgbaByteLength: number;
  readonly layout: readonly NativeYuvPlaneLayout[];
  readonly recipe: NativeYuvRecipeManifest;
}
export class UnsupportedNativeYuvError extends Error {
  readonly reason: string;
  constructor(reason: string) {super(`Unsupported native YUV: ${reason}`); this.name = 'UnsupportedNativeYuvError'; this.reason = reason;}
}

const SOURCES = Object.freeze([
  'https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.601-7-201103-I!!PDF-E.pdf',
  'https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.709-6-201506-I!!PDF-E.pdf',
  'https://www.w3.org/TR/2026/WD-webcodecs-20261019/#video-color-space',
  'https://www.w3.org/TR/2026/WD-webcodecs-20261019/#pixel-format',
]);

function recipe(profile: NativeYuvRecipeManifest['profile'], name: 'bt709' | 'smpte170m',
  weights: NativeYuvRecipeManifest['lumaWeights'], matrix: NativeYuvRecipeManifest['integerMatrix'], bound: number): NativeYuvRecipeManifest {
  return Object.freeze({id: `native420-${profile}-signal-rgb-nearest-v1`, version: 1, profile,
    colorSpace: Object.freeze({primaries: name, transfer: name, matrix: name, fullRange: false}),
    lumaWeights: Object.freeze(weights), inputBias: Object.freeze([16, 128, 128] as const),
    inputScale: Object.freeze([219, 224, 224] as const), integerMatrix: Object.freeze(matrix),
    chroma: 'nearest-floor-x/2-y/2', rounding: 'floor((numerator+denominator/2)/denominator)',
    clipping: 'final-only-0-255', transferConversion: 'none', output: 'opaque-signal-RGBA8', alpha: 255,
    maximumAbsoluteRoundedNumerator: bound, sources: SOURCES});
}

/**
 * Invert ITU-R BT.601-7 section 2.5 / Annex 2 and BT.709-6 section 3.2-3.4:
 * y=(Y-16)/219, u=(U-128)/224, v=(V-128)/224;
 * r=y+2(1-Kr)v, b=y+2(1-Kb)u, g=(y-Kr*r-Kb*b)/(1-Kr-Kb).
 * The integer matrices below are the exact rational coefficients after multiplying
 * by 255. They are derived coefficients, not copied implementation code.
 * For all byte inputs |dy|<=239, |du|,|dv|<=128. Even the largest expression
 * including the half denominator is <=5,352,146,294,272 (<2^43<2^53), so every
 * product/addition is an exact Number integer. Division has |quotient|<1024;
 * noninteger quotients are >=1/9,745,792,000 from an integer (>2^-34), whereas
 * rounding error is <=2^-44. Thus floor cannot cross an integer boundary.
 * No nominal-range input clipping, transfer function, gamut or Canvas conversion.
 */
export const NATIVE_YUV_RECIPES = Object.freeze({
  smpte170m: recipe('bt601-smpte170m-limited', 'smpte170m', {red: 299, green: 587, blue: 114, denominator: 1000},
    {denominator: 959_862_400, y: 1_117_648_000, redV: 1_531_966_101, blueU: 1_936_265_286,
      greenU: 376_037_892, greenV: 780_337_077}, 515_439_759_808),
  bt709: recipe('bt709-limited', 'bt709', {red: 2126, green: 7152, blue: 722, denominator: 10000},
    {denominator: 9_745_792_000, y: 11_347_840_000, redV: 17_471_681_592, blueU: 20_587_028_424,
      greenU: 2_078_276_639, greenV: 5_193_623_471}, 5_352_146_294_272),
});

function unsupported(reason: string): never {throw new UnsupportedNativeYuvError(reason);}
function dimension(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;}

/** Call before copying or admitting a frame. Unknown metadata requests raw fallback. */
export function planNativeYuvFrame(metadata: NativeYuvFrameMetadata): NativeYuvPlan {
  if (!metadata || typeof metadata !== 'object') unsupported('missing-metadata');
  const {format, codedWidth: width, codedHeight: height, visibleRect: rect, colorSpace: color} = metadata;
  if (format !== 'I420' && format !== 'NV12') unsupported('pixel-format');
  if (!dimension(width) || !dimension(height) || width % 2 || height % 2) unsupported('even-coded-size');
  const pixels = width * height, rgbaByteLength = pixels * 4;
  if (!Number.isSafeInteger(rgbaByteLength) || rgbaByteLength > MAX_FRAME_BYTES) unsupported('frame-byte-limit');
  if (metadata.displayWidth !== width || metadata.displayHeight !== height) unsupported('display-size-or-aspect');
  if (!rect || rect.x !== 0 || rect.y !== 0 || rect.width !== width || rect.height !== height) unsupported('visible-rectangle');
  if (metadata.rotation !== 0 || metadata.flip !== false) unsupported('orientation');
  if (!color || color.fullRange !== false) unsupported('limited-range-required');
  const name = color.matrix;
  if ((name !== 'bt709' && name !== 'smpte170m') || color.primaries !== name || color.transfer !== name)
    unsupported('explicit-color-profile-required');
  const layout = format === 'I420'
    ? [{offset: 0, stride: width}, {offset: pixels, stride: width / 2}, {offset: pixels + pixels / 4, stride: width / 2}]
    : [{offset: 0, stride: width}, {offset: pixels, stride: width}];
  return Object.freeze({format, width, height, nativeByteLength: pixels * 3 / 2, rgbaByteLength,
    layout: Object.freeze(layout.map(plane => Object.freeze(plane))), recipe: NATIVE_YUV_RECIPES[name]});
}

function packedLayout(plan: NativeYuvPlan, layout: readonly NativeYuvPlaneLayout[]) {
  if (!Array.isArray(layout) || layout.length !== plan.layout.length) unsupported('packed-plane-count');
  for (let i = 0; i < plan.layout.length; i++) {
    const plane = layout[i], expected = plan.layout[i];
    if (!plane || !Number.isSafeInteger(plane.offset) || !Number.isSafeInteger(plane.stride)
      || plane.offset !== expected.offset || plane.stride !== expected.stride) unsupported('packed-plane-layout');
  }
}

function ownedByteView(value: Uint8Array, length: number, label: string) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength !== length
    || (value.buffer as ArrayBuffer & {resizable?: boolean}).resizable === true) unsupported(`${label}-buffer`);
  try {new Uint8Array(value.buffer, value.byteOffset, length);} catch {unsupported(`${label}-detached-buffer`);}
}

function channel(numerator: number, denominator: number): number {
  return Math.max(0, Math.min(255, Math.floor((numerator + denominator / 2) / denominator)));
}

type ChannelTables = {red: Uint8Array; blue: Uint8Array};
// Only the two fixed recipes returned by planNativeYuvFrame can reach this
// private cache: 2 * 2 * 65,536 bytes, with no source or output raster retained.
const channelTables: Partial<Record<NativeYuvRecipeManifest['profile'], ChannelTables>> = {};
function tablesFor(recipe: NativeYuvRecipeManifest): ChannelTables {
  const existing = channelTables[recipe.profile];
  if (existing) return existing;
  const red = new Uint8Array(65_536), blue = new Uint8Array(65_536), m = recipe.integerMatrix;
  for (let y = 0; y < 256; y++) {
    const luma = m.y * (y - 16), at = y * 256;
    for (let chroma = 0; chroma < 256; chroma++) {
      red[at + chroma] = channel(luma + m.redV * (chroma - 128), m.denominator);
      blue[at + chroma] = channel(luma + m.blueU * (chroma - 128), m.denominator);
    }
  }
  return channelTables[recipe.profile] = {red, blue};
}

/**
 * Synchronous conversion. Native input is borrowed immutable for this call; output
 * must be exclusively owned. Any shared backing buffer, even disjoint views, is
 * rejected. Every check runs before allocating/writing output. The caller must
 * retain the generated bytes if these become acquisition input; original Canvas
 * pixels are not interchangeable fallback bytes after that point.
 */
export function convertNativeYuvToRgba(metadata: NativeYuvFrameMetadata, data: Uint8Array,
  layout: readonly NativeYuvPlaneLayout[], target?: Uint8Array): {rgba: Uint8Array<ArrayBuffer>; plan: NativeYuvPlan} {
  const plan = planNativeYuvFrame(metadata);
  packedLayout(plan, layout);
  ownedByteView(data, plan.nativeByteLength, 'native');
  if (target !== undefined) {
    ownedByteView(target, plan.rgbaByteLength, 'rgba');
    if (target.buffer === data.buffer) unsupported('source-output-alias');
  }
  const rgba = (target ?? new Uint8Array(plan.rgbaByteLength)) as Uint8Array<ArrayBuffer>;
  const {width, height, format, recipe: {integerMatrix: m}} = plan;
  const tables = tablesFor(plan.recipe);
  const pixels = width * height, chromaWidth = width / 2;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const chromaIndex = y / 2 * chromaWidth + x / 2;
      const u = data[pixels + (format === 'I420' ? chromaIndex : chromaIndex * 2)] - 128;
      const v = data[format === 'I420' ? pixels + pixels / 4 + chromaIndex : pixels + chromaIndex * 2 + 1] - 128;
      const green = -m.greenU * u - m.greenV * v;
      for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
        const source = (y + row) * width + x + column, at = source * 4, Y = data[source], luma = m.y * (Y - 16);
        rgba[at] = tables.red[Y * 256 + v + 128];
        rgba[at + 1] = channel(luma + green, m.denominator);
        rgba[at + 2] = tables.blue[Y * 256 + u + 128];
        rgba[at + 3] = 255;
      }
    }
  }
  return {rgba, plan};
}

/**
 * Canonical descriptor domain for a separate SHA-256. Hash the native payload
 * independently too: equal bytes under another format/profile are another input.
 * Timestamp, source ID and capture order remain separate provenance fields.
 */
export function nativeYuvDescriptorJson(metadata: NativeYuvFrameMetadata, layout: readonly NativeYuvPlaneLayout[]): string {
  const plan = planNativeYuvFrame(metadata); packedLayout(plan, layout);
  return JSON.stringify({schema: 'loa-card-native-yuv-descriptor-v1', format: plan.format, width: plan.width, height: plan.height,
    nativeByteLength: plan.nativeByteLength, rgbaByteLength: plan.rgbaByteLength, layout: plan.layout, recipe: plan.recipe});
}
