import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
await mkdir("work/frames", { recursive: true });
const result = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-y",
    "-i",
    process.argv[2] || "fixtures/local/card-catalog.mp4",
    "-an",
    "-vf",
    "fps=1/2",
    "work/frames/frame-%03d.png",
  ],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
