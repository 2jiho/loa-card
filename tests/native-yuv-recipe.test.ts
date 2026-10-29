import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {convertNativeYuvToRgba, nativeYuvDescriptorJson, NATIVE_YUV_RECIPES, planNativeYuvFrame,
  UnsupportedNativeYuvError, type NativeYuvFrameMetadata, type NativeYuvPlaneLayout} from '../dev/native-yuv-recipe';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';

function metadata(name: 'bt709' | 'smpte170m' = 'bt709', format = 'I420', width = 2, height = 2): NativeYuvFrameMetadata {
  return {format, codedWidth: width, codedHeight: height, displayWidth: width, displayHeight: height,
    visibleRect: {x: 0, y: 0, width, height}, rotation: 0, flip: false,
    colorSpace: {primaries: name, transfer: name, matrix: name, fullRange: false}};
}
const frame = (y: number, u: number, v: number) => Uint8Array.from([y, y, y, y, u, v]);
const layout = (meta: NativeYuvFrameMetadata) => planNativeYuvFrame(meta).layout;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const invalid = (callback: () => unknown) => assert.throws(callback, UnsupportedNativeYuvError);

// Independent oracle: reconstruct the original ITU equations with exact BigInt
// rational arithmetic and Kr/Kb alone, never the implementation integer matrix.
type Q = readonly [bigint, bigint];
const q = (n: bigint, d = 1n): Q => [n, d];
const add = (a: Q, b: Q): Q => q(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const neg = (a: Q): Q => q(-a[0], a[1]);
const sub = (a: Q, b: Q) => add(a, neg(b));
const mul = (a: Q, b: Q): Q => q(a[0] * b[0], a[1] * b[1]);
const div = (a: Q, b: Q): Q => q(a[0] * b[1], a[1] * b[0]);
const floorDiv = (n: bigint, d: bigint) => n / d - (n < 0n && n % d !== 0n ? 1n : 0n);
function oracle(name: 'bt709' | 'smpte170m', Y: number, U: number, V: number): number[] {
  const kr = name === 'bt709' ? q(2126n, 10000n) : q(299n, 1000n);
  const kb = name === 'bt709' ? q(722n, 10000n) : q(114n, 1000n);
  const kg = sub(sub(q(1n), kr), kb), y = q(BigInt(Y - 16), 219n);
  const u = q(BigInt(U - 128), 224n), v = q(BigInt(V - 128), 224n);
  const r = add(y, mul(mul(q(2n), sub(q(1n), kr)), v));
  const b = add(y, mul(mul(q(2n), sub(q(1n), kb)), u));
  const g = div(sub(sub(y, mul(kr, r)), mul(kb, b)), kg);
  return [...[r, g, b].map(([n, d]) => Number(floorDiv(510n * n + d, 2n * d)))
    .map(value => Math.max(0, Math.min(255, value))), 255];
}

test('explicit BT709 and actual OS smpte170m metadata produce separate frozen recipes and tight plans', () => {
  for (const name of ['bt709', 'smpte170m'] as const) {
    const meta = metadata(name, 'I420', 2560, 1440), plan = planNativeYuvFrame(meta);
    assert.equal(plan.nativeByteLength, 5_529_600); assert.equal(plan.rgbaByteLength, 14_745_600);
    assert.deepEqual(plan.layout, [{offset: 0, stride: 2560}, {offset: 3_686_400, stride: 1280}, {offset: 4_608_000, stride: 1280}]);
    assert.equal(plan.recipe, NATIVE_YUV_RECIPES[name]);
    assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.layout)); assert.ok(plan.layout.every(Object.isFrozen));
    assert.ok(Object.isFrozen(plan.recipe)); assert.ok(Object.isFrozen(plan.recipe.integerMatrix));
    meta.colorSpace.matrix = 'pq'; meta.visibleRect!.width = 4;
    assert.equal(plan.width, 2560); assert.equal(plan.recipe.colorSpace.matrix, name);
    assert.equal(plan.recipe.transferConversion, 'none'); assert.equal(plan.recipe.output, 'opaque-signal-RGBA8');
  }
  assert.notEqual(NATIVE_YUV_RECIPES.bt709.id, NATIVE_YUV_RECIPES.smpte170m.id);
});

test('nominal black/white and out-of-range signal samples match exact rational results', () => {
  for (const name of ['bt709', 'smpte170m'] as const) {
    const meta = metadata(name), planes = layout(meta);
    for (const [Y, U, V] of [[16, 128, 128], [235, 128, 128], [0, 0, 0], [255, 255, 255], [0, 128, 255], [255, 0, 128]]) {
      const {rgba} = convertNativeYuvToRgba(meta, frame(Y, U, V), planes);
      assert.deepEqual([...rgba], Array(4).fill(oracle(name, Y, U, V)).flat());
    }
    assert.deepEqual([...convertNativeYuvToRgba(meta, frame(16, 128, 128), planes).rgba.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...convertNativeYuvToRgba(meta, frame(235, 128, 128), planes).rgba.slice(0, 4)], [255, 255, 255, 255]);
  }
});

test('corners and threshold neighborhoods agree with an independent BigInt oracle', () => {
  const values = [0, 15, 16, 17, 127, 128, 129, 234, 235, 236, 240, 255];
  for (const name of ['bt709', 'smpte170m'] as const) {
    const meta = metadata(name), planes = layout(meta), target = new Uint8Array(16);
    for (const Y of values) for (const U of values) for (const V of values) {
      const result = convertNativeYuvToRgba(meta, frame(Y, U, V), planes, target);
      assert.equal(result.rgba, target);
      assert.deepEqual([...target.subarray(0, 4)], oracle(name, Y, U, V), `${name} ${Y},${U},${V}`);
    }
  }
});

test('seeded byte triples and nonuniform luma agree with the BigInt oracle', () => {
  let state = 0x71a53;
  const byte = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24;};
  for (const name of ['bt709', 'smpte170m'] as const) {
    const meta = metadata(name), planes = layout(meta);
    for (let i = 0; i < 2048; i++) {
      const data = Uint8Array.from({length: 6}, byte), {rgba} = convertNativeYuvToRgba(meta, data, planes);
      for (let pixel = 0; pixel < 4; pixel++) assert.deepEqual([...rgba.subarray(pixel * 4, pixel * 4 + 4)], oracle(name, data[pixel], data[4], data[5]));
    }
  }
});

test('actual packed converter exhaustively matches the previous scalar formula for both byte profiles in bounded chunks', () => {
  // Frozen pre-lookup implementation coefficients, independent of production
  // manifests/tables. The existing BigInt ITU oracle also verifies these exact
  // coefficients and difficult signal/rounding cases above and below.
  const previous = {
    bt709: {d: 9_745_792_000, y: 11_347_840_000, rv: 17_471_681_592, bu: 20_587_028_424, gu: 2_078_276_639, gv: 5_193_623_471},
    smpte170m: {d: 959_862_400, y: 1_117_648_000, rv: 1_531_966_101, bu: 1_936_265_286, gu: 376_037_892, gv: 780_337_077},
  };
  const width = 256, height = 256, pixels = width * height, chroma = pixels / 4;
  // One 96KiB native buffer and one 256KiB target are reused for all 512 calls.
  const input = new Uint8Array(pixels * 3 / 2), target = new Uint8Array(pixels * 4);
  for (let block = 0; block < chroma; block++) {
    const x = block % (width / 2) * 2, y = Math.floor(block / (width / 2)) * 2, Y = Math.floor(block / 256) * 4;
    input[y * width + x] = Y; input[y * width + x + 1] = Y + 1;
    input[(y + 1) * width + x] = Y + 2; input[(y + 1) * width + x + 1] = Y + 3;
  }
  let checked = 0;
  for (const name of ['bt709', 'smpte170m'] as const) {
    const m = previous[name];
    for (let U = 0; U < 256; U++) {
      // Every U/V/Y triple is tested once per profile. Alternating formats
      // makes every V and Y exercise both packed representations over U.
      const format = U % 2 ? 'NV12' : 'I420', meta = metadata(name, format, width, height);
      for (let block = 0; block < chroma; block++) {
        input[pixels + (format === 'I420' ? block : block * 2)] = U;
        input[format === 'I420' ? pixels + chroma + block : pixels + block * 2 + 1] = block % 256;
      }
      assert.equal(convertNativeYuvToRgba(meta, input, layout(meta), target).rgba, target);
      for (let pixel = 0; pixel < pixels; pixel++) {
        const Y = input[pixel], block = Math.floor(pixel / (width * 2)) * (width / 2) + Math.floor(pixel % width / 2), V = block % 256;
        const luma = m.y * (Y - 16), half = m.d / 2;
        const R = Math.max(0, Math.min(255, Math.floor((luma + m.rv * (V - 128) + half) / m.d)));
        const G = Math.max(0, Math.min(255, Math.floor((luma - m.gu * (U - 128) - m.gv * (V - 128) + half) / m.d)));
        const B = Math.max(0, Math.min(255, Math.floor((luma + m.bu * (U - 128) + half) / m.d)));
        const at = pixel * 4;
        if (target[at] !== R || target[at + 1] !== G || target[at + 2] !== B || target[at + 3] !== 255)
          assert.fail(`${name}/${format} Y=${Y} U=${U} V=${V}: expected ${R},${G},${B},255; got ${target.subarray(at, at + 4)}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 33_554_432);
});

test('profile lookups retain neither mutable input/target views nor another profile output', () => {
  const first = metadata('bt709'), second = metadata('smpte170m'), input = frame(90, 210, 33), target = new Uint8Array(16);
  const expected = oracle('bt709', 90, 210, 33);
  assert.deepEqual([...convertNativeYuvToRgba(first, input, layout(first), target).rgba], Array(4).fill(expected).flat());
  input.fill(0); target.fill(0);
  convertNativeYuvToRgba(second, frame(255, 0, 255), layout(second), target); target.fill(7);
  assert.deepEqual([...convertNativeYuvToRgba(first, frame(90, 210, 33), layout(first), target).rgba], Array(4).fill(expected).flat());
  assert.deepEqual(input, new Uint8Array(6));
});

test('manifest matrices are exact rational inverses and satisfy the safe integer proof', () => {
  for (const recipe of Object.values(NATIVE_YUV_RECIPES)) {
    const {integerMatrix: m, lumaWeights: w} = recipe;
    const D = BigInt(m.denominator), denominator = BigInt(w.denominator), R = BigInt(w.red), B = BigInt(w.blue), G = BigInt(w.green);
    assert.equal(BigInt(m.y) * 219n, D * 255n);
    assert.equal(BigInt(m.redV) * 224n * denominator, D * 255n * 2n * (denominator - R));
    assert.equal(BigInt(m.blueU) * 224n * denominator, D * 255n * 2n * (denominator - B));
    assert.equal(BigInt(m.greenU) * 224n * denominator * G, D * 255n * 2n * B * (denominator - B));
    assert.equal(BigInt(m.greenV) * 224n * denominator * G, D * 255n * 2n * R * (denominator - R));
    const bound = BigInt(m.y) * 239n + BigInt(Math.max(m.redV, m.blueU, m.greenU + m.greenV)) * 128n + D / 2n;
    assert.equal(bound, BigInt(recipe.maximumAbsoluteRoundedNumerator));
    assert.ok(bound < 2n ** 43n); assert.ok(bound < BigInt(Number.MAX_SAFE_INTEGER));
    assert.ok(bound < D * 1024n);
    assert.ok(D < 2n ** 34n, 'distance from a noninteger quotient to an integer exceeds 2^-34');
  }
});

test('I420 and NV12 with identical samples produce identical RGBA and preserve 2x2 nearest chroma blocks', () => {
  for (const name of ['bt709', 'smpte170m'] as const) {
    const i420 = metadata(name, 'I420', 4, 4), nv12 = metadata(name, 'NV12', 4, 4);
    const Y = [16, 100, 200, 235, 20, 40, 80, 160, 64, 96, 128, 192, 0, 255, 120, 170];
    const U = [0, 80, 160, 255], V = [255, 150, 100, 0];
    const planar = Uint8Array.from([...Y, ...U, ...V]), interleaved = Uint8Array.from([...Y, ...U.flatMap((u, i) => [u, V[i]])]);
    const before = planar.slice(), first = convertNativeYuvToRgba(i420, planar, layout(i420)).rgba;
    assert.deepEqual(first, convertNativeYuvToRgba(nv12, interleaved, layout(nv12)).rgba);
    assert.deepEqual(planar, before);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const block = Math.floor(y / 2) * 2 + Math.floor(x / 2), at = (y * 4 + x) * 4;
      assert.deepEqual([...first.subarray(at, at + 4)], oracle(name, Y[y * 4 + x], U[block], V[block]));
    }
  }
});

test('unknown/mixed/full-range/HDR color metadata never guesses a matrix from resolution', () => {
  const changes = [null, {}, {fullRange: true}, {fullRange: null}, {fullRange: undefined}, {fullRange: 0},
    {matrix: null}, {matrix: 'rgb'}, {matrix: 'bt2020-ncl'}, {matrix: 'bt470bg'}, {transfer: null}, {transfer: 'pq'},
    {transfer: 'hlg'}, {transfer: 'iec61966-2-1'}, {primaries: null}, {primaries: 'bt2020'}, {primaries: 'smpte170m'},
    {transfer: 'smpte170m'}, {matrix: 'smpte170m'}];
  for (const change of changes) {
    const meta = metadata(); meta.colorSpace = (change === null ? null : {...meta.colorSpace, ...change}) as never;
    // An empty patch retains valid values; use an entirely empty color object instead.
    if (change && Object.keys(change).length === 0) meta.colorSpace = {} as never;
    invalid(() => planNativeYuvFrame(meta));
  }
});

test('unsupported formats, missing metadata and noncanonical geometry request fallback before allocation', () => {
  invalid(() => planNativeYuvFrame(null as never)); invalid(() => planNativeYuvFrame(undefined as never));
  for (const format of [null, 'NV21', 'I420A', 'I420P10', 'P010', 'RGBA', 'RGBX', 'i420']) invalid(() => planNativeYuvFrame({...metadata(), format}));
  const changes: Partial<NativeYuvFrameMetadata>[] = [
    {codedWidth: 0}, {codedWidth: -2}, {codedWidth: 3}, {codedWidth: 2.5}, {codedWidth: NaN}, {codedWidth: Infinity},
    {codedHeight: 3}, {codedHeight: Number.MAX_SAFE_INTEGER}, {codedWidth: Number.MAX_SAFE_INTEGER - 1},
    {displayWidth: 4}, {displayHeight: 4}, {rotation: 90}, {rotation: NaN}, {rotation: undefined}, {flip: true}, {flip: undefined},
    {visibleRect: null}, {visibleRect: {x: 1, y: 0, width: 2, height: 2}}, {visibleRect: {x: 0, y: 1, width: 2, height: 2}},
    {visibleRect: {x: 0, y: 0, width: 1, height: 2}}, {visibleRect: {x: 0, y: 0, width: 2, height: 4}},
  ];
  for (const change of changes) invalid(() => planNativeYuvFrame({...metadata(), ...change}));
  assert.equal(planNativeYuvFrame(metadata('bt709', 'I420', 4096, 4096)).rgbaByteLength, MAX_FRAME_BYTES);
  invalid(() => planNativeYuvFrame(metadata('bt709', 'I420', 4098, 4096)));
});

test('every malformed or padded layout and payload is rejected before any output write', () => {
  const meta = metadata(), data = frame(80, 90, 100), target = new Uint8Array(16).fill(211);
  const badLayouts: unknown[] = [null, {}, [], [{offset: 0, stride: 2}], [...layout(meta), {offset: 6, stride: 1}],
    [{offset: 0, stride: 2}, {offset: 4, stride: 1}, {offset: 4, stride: 1}],
    [{offset: 1, stride: 2}, {offset: 4, stride: 1}, {offset: 5, stride: 1}],
    [{offset: 0, stride: 4}, {offset: 4, stride: 1}, {offset: 5, stride: 1}],
    [{offset: 0, stride: 2}, {offset: 5, stride: 1}, {offset: 4, stride: 1}],
    [{offset: 0, stride: 2}, {offset: 4, stride: NaN}, {offset: 5, stride: 1}],
    [{offset: 0, stride: 2}, {offset: 4, stride: 1}, {offset: 5.5, stride: 1}],
    [{offset: 0, stride: 2}, {offset: 4, stride: 1}, null]];
  for (const bad of badLayouts) {invalid(() => convertNativeYuvToRgba(meta, data, bad as NativeYuvPlaneLayout[], target)); assert.ok(target.every(v => v === 211));}
  for (const bad of [new Uint8Array(0), new Uint8Array(5), new Uint8Array(7), new Uint8ClampedArray(6), new Uint8Array(new SharedArrayBuffer(6))]) {
    invalid(() => convertNativeYuvToRgba(meta, bad as Uint8Array, layout(meta), target)); assert.ok(target.every(v => v === 211));
  }
  for (const bad of [new Uint8Array(15), new Uint8Array(17), new Uint8ClampedArray(16), new Uint8Array(new SharedArrayBuffer(16))])
    invalid(() => convertNativeYuvToRgba(meta, data, layout(meta), bad as Uint8Array));
  const detached = frame(10, 20, 30); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  invalid(() => convertNativeYuvToRgba(meta, detached, layout(meta), target)); assert.ok(target.every(v => v === 211));
  const resizable = new Uint8Array(new ArrayBuffer(6, {maxByteLength: 12}));
  invalid(() => convertNativeYuvToRgba(meta, resizable, layout(meta), target)); assert.ok(target.every(v => v === 211));
});

test('source/output aliases including disjoint views are rejected; exclusive offset views preserve their guards', () => {
  const meta = metadata(), planes = layout(meta), same = new Uint8Array(32).fill(201), before = same.slice();
  invalid(() => convertNativeYuvToRgba(meta, same.subarray(0, 6), planes, same.subarray(0, 16)));
  invalid(() => convertNativeYuvToRgba(meta, same.subarray(0, 6), planes, same.subarray(8, 24)));
  assert.deepEqual(same, before);
  const nativeStorage = new Uint8Array(10).fill(199); nativeStorage.set(frame(100, 200, 80), 2);
  const outStorage = new Uint8Array(24).fill(188), output = outStorage.subarray(4, 20), data = nativeStorage.subarray(2, 8);
  const {rgba} = convertNativeYuvToRgba(meta, data, planes, output);
  assert.equal(rgba, output); assert.deepEqual([...rgba], Array(4).fill(oracle('bt709', 100, 200, 80)).flat());
  assert.deepEqual([...outStorage.subarray(0, 4)], [188, 188, 188, 188]); assert.deepEqual([...outStorage.subarray(20)], [188, 188, 188, 188]);
  assert.deepEqual([...nativeStorage], [199, 199, 100, 100, 100, 100, 200, 80, 199, 199]);
});

test('descriptor identity binds format, profile, dimensions, packing and exact recipe independently of payload SHA', () => {
  const first = metadata(), second = metadata('smpte170m'), third = metadata('bt709', 'NV12');
  const neutral = frame(100, 128, 128), descriptor = nativeYuvDescriptorJson(first, layout(first));
  const parsed = JSON.parse(descriptor);
  assert.equal(parsed.schema, 'loa-card-native-yuv-descriptor-v1'); assert.deepEqual(parsed.recipe, NATIVE_YUV_RECIPES.bt709);
  assert.equal(descriptor, nativeYuvDescriptorJson({...first}, layout(first).map(p => ({stride: p.stride, offset: p.offset}))));
  assert.notEqual(hash(descriptor), hash(nativeYuvDescriptorJson(second, layout(second))));
  assert.notEqual(hash(descriptor), hash(nativeYuvDescriptorJson(third, layout(third))));
  assert.equal(hash(neutral), hash(neutral.slice()));
  assert.equal(hash(convertNativeYuvToRgba(first, neutral, layout(first)).rgba), hash(convertNativeYuvToRgba(third, neutral, layout(third)).rgba));
  assert.notEqual(descriptor, nativeYuvDescriptorJson(metadata('bt709', 'I420', 4, 2), layout(metadata('bt709', 'I420', 4, 2))));
  invalid(() => nativeYuvDescriptorJson(first, []));
});

test('lookup optimization preserves the exact pre-lookup descriptor and frozen recipe identity', () => {
  const expected = {
    bt709: {I420: '3426afe2fd10170cbdffc2f0022f538a4aeb7c5814ff90b8a333edcb9fbe33ff', NV12: '1ba3f33ed6ce9252dc62452701f9da8ff6a410dd3028cdca81a958fea5c75c5c'},
    smpte170m: {I420: 'c3a4c40d2e886aeafb6225aeb38a36d63ba1389c27816ebd942b2fe3843087f2', NV12: 'dc622e45fe1339fbe344b41ad00dcb709a6a61b97d6ab54c6f5a50e871e794a8'},
  };
  for (const name of ['bt709', 'smpte170m'] as const) for (const format of ['I420', 'NV12'] as const) {
    const meta = metadata(name, format);
    convertNativeYuvToRgba(meta, frame(123, 45, 67), layout(meta));
    assert.equal(hash(nativeYuvDescriptorJson(meta, layout(meta))), expected[name][format]);
    assert.deepEqual(Object.keys(NATIVE_YUV_RECIPES[name]).sort(), ['id', 'version', 'profile', 'colorSpace', 'lumaWeights', 'inputBias', 'inputScale',
      'integerMatrix', 'chroma', 'rounding', 'clipping', 'transferConversion', 'output', 'alpha', 'maximumAbsoluteRoundedNumerator', 'sources'].sort());
  }
});
