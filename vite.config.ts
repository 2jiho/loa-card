import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {execFileSync} from 'node:child_process';
let revision='local';
try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())revision+='-dirty';}catch{/* Source archives can build without Git. */}
// Bind source, data, dependencies and pinned model hashes; computed once at build/server start.
const replayHash=createHash('sha256');
function hashTree(path:string){for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,item.name);if(item.isDirectory())hashTree(file);else{replayHash.update(file.replaceAll('\\','/'));replayHash.update(readFileSync(file));}}}
hashTree('src');hashTree('public/scanner');
for(const file of ['package-lock.json','scripts/prepare-ocr-assets.mjs','licenses/third-party/manifest.json'])replayHash.update(readFileSync(file));
const replaySignature=replayHash.digest('hex');
export default defineConfig({
  define:{'import.meta.env.VITE_BUILD_REVISION':JSON.stringify(revision),'import.meta.env.VITE_REPLAY_SIGNATURE':JSON.stringify(replaySignature)},
  base: process.env.PAGES_BASE_PATH || "/",
  worker: { format: "es" },
  // The OCR worker is loaded on first scan; prebundle now so dev does not
  // reload the page and discard the selected input during model startup.
  optimizeDeps: { include: ["onnxruntime-web/wasm", "lz4-lite"] },
  plugins: [
    react(),
    {
      name: "local-video-fixture",
      configureServer(server) {
        server.middlewares.use("/__fixtures", (request, response, next) => {
          const name = request.url?.split("?")[0];
          if (!/^(?:\/card-catalog(?:-[234])?\.mp4|\/screenshots-[12](?:\.json|\/\d{2}\.png))$/.test(name ?? "")) {
            next();
            return;
          }
          const file = fileURLToPath(
            new URL(`./fixtures/local${name}`, import.meta.url),
          );
          if (!existsSync(file)) {
            response.statusCode = 404;
            response.end("Prepare the local fixture first.");
            return;
          }
          const size = statSync(file).size;
          response.setHeader("Content-Type", name?.endsWith(".png") ? "image/png" : name?.endsWith(".json") ? "application/json" : "video/mp4");
          response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Cache-Control", "no-store");
          let start = 0;
          let end = size - 1;
          if (request.headers.range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
            if (!match) {
              response.statusCode = 416;
              response.setHeader("Content-Range", `bytes */${size}`);
              response.end();
              return;
            }
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
            if (start > end || start >= size) {
              response.statusCode = 416;
              response.setHeader("Content-Range", `bytes */${size}`);
              response.end();
              return;
            }
            response.statusCode = 206;
            response.setHeader(
              "Content-Range",
              `bytes ${start}-${end}/${size}`,
            );
          }
          response.setHeader("Content-Length", end - start + 1);
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(file, { start, end });
          stream.on("error", () => response.destroy());
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        });
      },
    },
  ],
  server: { host: "127.0.0.1" },
});
