import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run fixture:prepare -- "path/to/video.mp4"');
  process.exit(1);
}
await mkdir("fixtures/local", { recursive: true });
await copyFile(resolve(input), resolve("fixtures/local/card-catalog.mp4"));
if (process.argv[3])
  await copyFile(
    resolve(process.argv[3]),
    resolve("fixtures/local/card-catalog-2.mp4"),
  );
console.log("Local fixture prepared (excluded from Git and production build).");
if (process.argv[4])
  await copyFile(resolve(process.argv[4]), resolve("fixtures/local/card-catalog-3.mp4"));
if (process.argv[5])
  await copyFile(resolve(process.argv[5]), resolve("fixtures/local/card-catalog-4.mp4"));
if (process.argv[6])
  await copyFile(resolve(process.argv[6]), resolve("fixtures/local/card-catalog-5.mp4"));
