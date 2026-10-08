import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const target = "public/ocr";
await mkdir(target, { recursive: true });
// Keep the large npm runtime out of Git; serve the exact audited package bytes.
const opencv = await readFile("node_modules/@techstark/opencv-js/dist/opencv.js");
const supplemental = JSON.parse(await readFile("licenses/third-party/manifest.json", "utf8"));
if (createHash("sha256").update(opencv).digest("hex") !== supplemental.opencvSha256)
  throw new Error("OpenCV runtime checksum mismatch; review embedded notices");
await writeFile(`${target}/opencv.js`, opencv);
await rm(`${target}/tesseract-core-relaxedsimd-lstm.wasm.js`, { force: true });
await mkdir("work/ocr", { recursive: true });
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js",
  `${target}/worker.min.js`,
);
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt",
  `${target}/worker.min.js.LICENSE.txt`,
);
for (const variant of ["lstm", "simd-lstm"])
  await copyFile(
    `node_modules/tesseract.js-core/tesseract-core-${variant}.wasm.js`,
    `${target}/tesseract-core-${variant}.wasm.js`,
  );
const cached = "work/ocr/kor.traineddata";
try {
  await access(cached);
} catch {
  const response = await fetch(
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/4.1.0/kor.traineddata",
  );
  if (!response.ok) throw new Error(`Korean OCR model: ${response.status}`);
  await writeFile(cached, Buffer.from(await response.arrayBuffer()));
}
const model = await readFile(cached);
const sha256 = createHash("sha256").update(model).digest("hex");
if (
  sha256 !== "f888d4038348a0c3d25151e7f452bda0d74ca275b18cab146798bcbb94084fff"
)
  throw new Error("Korean OCR model checksum mismatch");
await copyFile(
  "node_modules/tesseract.js/LICENSE.md",
  `${target}/LICENSE-Tesseract-js.txt`,
);
await copyFile(
  "node_modules/tesseract.js-core/LICENSE",
  `${target}/LICENSE-Tesseract-core.txt`,
);
await writeFile(
  `${target}/NOTICE.txt`,
  "Korean LSTM model: tesseract-ocr/tessdata_best, tag 4.1.0, Apache-2.0. Source: https://github.com/tesseract-ocr/tessdata_best/tree/4.1.0\nTesseract.js 6 is used to avoid the float-model relaxed SIMD regression in version 7 (naptha/tesseract.js#1080).\n",
);
await writeFile(`${target}/kor.traineddata.gz`, gzipSync(model));
await writeFile(
  `${target}/model.json`,
  JSON.stringify({
    source: "tesseract-ocr/tessdata_best",
    version: "4.1.0",
    sha256,
  }),
);
console.log(`Local Korean OCR assets ready (${sha256.slice(0, 12)}).`);
const englishCache = "work/ocr/eng.traineddata";
try {
  await access(englishCache);
} catch {
  const response = await fetch(
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata",
  );
  if (!response.ok) throw new Error(`Numeric OCR model: ${response.status}`);
  await writeFile(englishCache, Buffer.from(await response.arrayBuffer()));
}
const english = await readFile(englishCache);
const englishSha = createHash("sha256").update(english).digest("hex");
if (
  englishSha !==
  "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
)
  throw new Error("Numeric OCR model checksum mismatch");
await writeFile(`${target}/eng.traineddata.gz`, gzipSync(english));
await writeFile(
  `${target}/NOTICE-numeric.txt`,
  "Numeric LSTM model: tesseract-ocr/tessdata_fast, tag 4.1.0, Apache-2.0. Source: https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0\n",
);
const neuralCache = "work/paddle/inference.onnx";
await mkdir("work/paddle", { recursive: true });
try {
  await access(neuralCache);
} catch {
  const response = await fetch(
    "https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/5c6f574b8e2230adf4287b33e736d71b9fabd28e/inference.onnx",
  );
  if (!response.ok)
    throw new Error(`Korean neural OCR model: ${response.status}`);
  await writeFile(neuralCache, Buffer.from(await response.arrayBuffer()));
}
const neural = await readFile(neuralCache);
const neuralSha = createHash("sha256").update(neural).digest("hex");
if (
  neuralSha !==
  "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08"
)
  throw new Error("Neural OCR model checksum mismatch");
await writeFile(`${target}/korean-v5-92f0b778.onnx`, neural);
for (const suffix of ["mjs", "wasm"])
  await copyFile(
    `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.${suffix}`,
    `${target}/ort-wasm-simd-threaded.${suffix}`,
  );
await writeFile(
  `${target}/NOTICE-Paddle.txt`,
  "korean_PP-OCRv5_mobile_rec_onnx, PaddlePaddle, Apache-2.0.\nRevision: 5c6f574b8e2230adf4287b33e736d71b9fabd28e\nSource: https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx\nSHA-256: " +
    neuralSha +
    "\nCTC vocabulary derives from inference.yml in that revision, with blank and space labels.\nONNX Runtime Web 1.30.0: MIT. License texts are included under scanner/.\n",
);
console.log(`Local neural OCR assets ready (${neuralSha.slice(0, 12)}).`);

const digitsCache = "work/paddle-v6/inference.onnx";
await mkdir("work/paddle-v6", { recursive: true });
try {
  await access(digitsCache);
} catch {
  const response = await fetch(
    "https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/2612ab37152ae0a677521bae4e1e3d4fb4cf7c30/inference.onnx",
  );
  if (!response.ok)
    throw new Error(`Numeric neural OCR model: ${response.status}`);
  await writeFile(digitsCache, Buffer.from(await response.arrayBuffer()));
}
const digits = await readFile(digitsCache);
const digitsSha = createHash("sha256").update(digits).digest("hex");
if (
  digitsSha !==
  "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6"
)
  throw new Error("Numeric neural OCR model checksum mismatch");
await writeFile(`${target}/digits-v6-9ef676d6.onnx`, digits);
for (const [filename, expected] of [
  [
    "paddle-characters.json",
    "8695aae0e71d42a79229577c45b06decdcfa6b11b93bb238a2fbf0dc9df4a9fa",
  ],
  [
    "paddle-v6-characters.json",
    "fb8ae793546672bc8abd04b11d19e1c381b1ca2be4fe6ef070d7ace97b19ca7d",
  ],
]) {
  const actual = createHash("sha256")
    .update(await readFile(`public/scanner/${filename}`))
    .digest("hex");
  if (actual !== expected)
    throw new Error(`OCR vocabulary checksum mismatch: ${filename}`);
}
await writeFile(
  `${target}/NOTICE-Paddle-v6.txt`,
  "PP-OCRv6_tiny_rec_onnx, PaddlePaddle, Apache-2.0.\nRevision: 2612ab37152ae0a677521bae4e1e3d4fb4cf7c30\nSource: https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx\nSHA-256: " +
    digitsSha +
    "\nVocabulary derives from inference.yml in that revision. This model has no Korean glyphs and is used only for numeric fields.\n",
);
console.log(`Local PP-OCRv6 numeric assets ready (${digitsSha.slice(0, 12)}).`);
