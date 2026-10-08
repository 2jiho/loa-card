import { test } from "node:test";
import assert from "node:assert/strict";
import { decodedFrames } from "../src/features/card-scanner/decoded-frames";

test("canceled input never opens or decodes a source", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(decodedFrames(new Blob(["not a video"]), abort.signal).next(), { name: "AbortError" });
});

test("invalid input reports an error rather than a successful empty scan", async () => {
  await assert.rejects(decodedFrames(new Blob(["not a video"]), new AbortController().signal).next());
});
