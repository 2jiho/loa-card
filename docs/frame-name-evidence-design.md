# Frame/name diagnostic evidence (experimental)

`FrameNameEvidence` is a disconnected, bounded diagnostic reducer. It records
the processing frame and source frame separately, stores at most 40 exact
`sessionId/frameId/observationId/captureOrder/captureTime/phase/slot` bindings
with their actual capture group, and associates a confirmed name only when
the entire source matches. It never infers an identity for another group, a
different frame or another slot. It cannot settle freshness debt, certify a
scan, or change card results. Sort/filter epoch is explicitly `unknown`.

The current scanner does not feed this reducer or record new events for it. Importing
an event directly into the reducer validates structure, not that the inventory
producer accepted it. A successful checksum covers only its bounded projection;
it does not authenticate an input recording or source producer.

The opt-in local command `node --import tsx scripts/analyze-frame-name-trace.mjs
<private-run.json>` analyzes an existing detailed development state trace. It
joins each `grid-command` group to its acquisition receipt by exact session,
frame, observation, time and slot, replays the inventory events through the
common inventory reducer, and checks its captured checkpoint. It adds no live
recording data and cannot alter the scanner, identify cards or end a share.
The command accepts only its supported state trace/run-report format; it is not
an arbitrary scan-recording importer. Its trace reader validates the version 2
envelope, chunk totals, event totals and final sequence before analysis. Version
1 lacks independent tail totals and is therefore never reported complete.

`inputStatus: complete` means the input trace reports no loss or sequence gaps,
all processed input frames have 40 acquisition receipts, group receipts join,
each name has a preceding same-source identity acceptance, the inventory
checkpoint matches, and no bounded projection entry or unmatched name was
lost. Recovery receipts and inventory events are counted but not analyzed;
when present, overall `status` is `partial` and `recoveryCoverage` is
`not-analyzed`. Neither status means the original capture or recognition was accurate.
Older traces without acquisition receipts report `unsupported`; dropped,
missing, evicted, unjoined or checkpoint-less evidence reports `partial`.
Source conflicts, duplicate cells and malformed event order fail analysis.
The generated projection hash is reproducible but has no corresponding live
frame/name checkpoint: `matchesCapturedState` is therefore always `null`.

To examine two input observations in a validated detailed run, use
`node --import tsx scripts/analyze-observation-pair.mjs <private-run.json> <first-observation-id> <second-observation-id>`.
The report separates source-bound names from visual-group reuse and reports
neighbouring placements, intervening grid resets and field evidence. Sort and
filter continuity is unknown; neither the neighbour count nor the resulting
report establishes that the targets are the same card. The tool does not
change scanner state or provide an automatic-completion proof.

Before connecting the channel, all of these are required:

1. Reuse the existing acquisition receipt and `grid-command` events to derive
   the 40-slot group/source list, with absent groups represented as `null`.
   Key it by processing frame and retain the source frame ID separately.
2. Offline, replay the same `name-confirmed` event emitted after `InventoryEvidence.apply`
   accepts it, with a source bound to the matching capture. Capture and reader
   events can arrive in either order. Recovery sources require an explicit
   policy rather than silently becoming live input.
3. The existing state trace already carries these events; no extra 40-slot JSON
   recording is necessary. Bound pending observations and frames; expose
   eviction explicitly and do not claim a complete history after a bound.
4. If a live frame/name checkpoint is added later, record it and compare it
   during replay. Exact-recording codec integration is not implemented.
5. Measure serialization, recording queue pressure, UI latency and capture
   throughput on real screen sharing, including long scans. A local Node.js
   metadata microbenchmark does not measure any of those end-to-end costs.

There is no trusted sort/filter epoch or independent target matching fact yet.
Even after this diagnostic channel is integrated, those missing facts and
their provenance must be designed and tested before using any cross-frame
relationship for card association or automatic share termination.

`retry-receipt-state.ts` is a separate experimental admission ledger for one
retry after a timeout. It is not connected to the scanner. The reducer checks
the event structure, ordering, queue transitions and explicit resource limits,
but its `sourceFrame` and `origin` fields are caller assertions. Integration
must independently verify the physical input receipt, keep identical pixels
from becoming a second consensus vote, record/replay the same admission facts,
and measure runtime and memory cost. A skipped or missing physical receipt
cannot authorize a retry; a replayed source is not a new live observation.

For a local, private trace with `observations` and `inventory` arrays, run
`node --import tsx scripts/bench-frame-name-evidence.mjs <private-trace.json>`.
The command reads locally and prints only aggregate sizes and timings. The trace
must contain one session and unique source-frame/slot pairs; it cannot recover
a processing-frame identity that the source trace did not retain.

One local Node.js run on the retained private trace `live-coverage-diagnosis`
used 9 frames, 354 usable source observations and 357 input name events. Across
100 repeated reductions, the mean was 1.41 ms per trace; frame insertion was
0.018 ms p50 and 0.039 ms p95. Uncompressed frame-event JSON totalled 68,559
bytes, about 7,618 bytes per frame. A second reduction had the same diagnostic
projection hash. These figures do not include JSON serialization timing,
browser event delivery, recording I/O, capture, OCR or real screen sharing;
they are not a latency or memory guarantee. The sample is small and reconstructs
processing-frame IDs only because source frame/slot pairs happen to be unique.
