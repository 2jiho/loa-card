# Asset-aware recognition experiment

Local experiment only; no production imports or shipped reference assets.

Build composed references with `scripts/build-composed-card-templates.py`. The
experimental bundle contains font-independent masked artwork and UI provenance.
Compare an empty-inventory run against the same inputs and record final fields,
unresolved fields, and timings separately. Do not infer hidden counters or combine
awakening/count values from different captures. Shared artwork must remain ambiguous.

## Run

```sh
python scripts/build-client-card-art.py --assets work/client-assets --experimental-all --output work/client-card-references
python scripts/build-composed-card-templates.py --assets work/client-assets --output work/composed-card-templates
npx vite --config dev/recognition-experiment/vite.config.ts
```

The builder requires Pillow, NumPy and OpenCV. `LOACARD_COMPOSED_DIR` can select
another generated directory below `work/`. `LOACARD_CATALOG_DIR` selects the
all-client catalog directory (default `work/client-card-references`). Both are
required, so the experiment cannot silently mix production coarse features with
experimental composed references. No asset originals are bundled.
The experiment config refuses builds. Standard dev/build remains unchanged.

## Behavior

- Preserve the validated normal/equipped portrait path first (`legacy-portrait.ts`
  is the prior local matcher snapshot). Only failures enter 48x64 refinement.
- Derive a fixed, guarded artwork mask from the union of all frame alpha masks,
  excluding the name, banner rectangle and lower variable fields. Refinement is
  independent of banner text rendering. Legacy matching is intentionally retained
  until full replacement has independent accuracy and performance evidence.
- Rank every identity; label/border rarity colors affect work order only. A
  mathematical upper bound skips translations that cannot alter acceptance.
  A four-pixel orthogonal projection and residual-energy bound further prune
  comparisons; an exhaustive option exists for differential tests.
  The winner still needs independent upper/lower/left/right agreement and a
  margin over the other identities. Never remove ambiguous competitors.
- Refine scale by a bounded 1.25% only after inconclusive border alignment, and
  only if all four sides become continuous with a meaningful score improvement.
- A complete crop with a visible label and upper three-sided perimeter may
  contribute identity alone when the bottom is occluded. Counters/jewels are
  always null for this observation; no retries attempt to read the hidden fields.
  Existing consensus later uses a confirmed same-capture awakening/count pair.
- Project identity-only deduplication onto the complete name band and upper
  portrait, excluding tooltip/counter animation. Its observation-group namespace
  is separate from complete cards. A changed lower field still creates normal
  full-card work. Partial identity jobs get at most the short OCR retry; hidden
  fields never enter repeated-count evidence as known values.
- Run recovery acquisition through the existing Worker and overlap it with
  independent visual/short-OCR readers. One frame is acquired at a time; at
  120 queued crops the decoder waits for readers instead of dropping frames.
  A source canvas is copied before advancing its decoder pool. All readers
  settle before cleanup after cancellation or failure. Full OCR retries retain
  the existing final drain and evidence rules.
- Queue changes wake waiting recovery readers directly; idle readers do not
  poll on 1ms timers. On hosts with at least eight logical CPUs, post-share
  recovery gives each existing reader a visual worker. Readers take visual
  work when available, while OCR-designated lanes keep short retries as their
  first priority. Idle OCR capacity helps visuals without delaying occluded cards.
  Extra visual workers are created only for recovery and disposed with the scan;
  no additional OCR model sessions or looser recognition thresholds are used.
  On hosts with at least twelve logical CPUs, use six image lanes. Surplus
  image lanes cannot take OCR retries, including when their queue empties;
  each OCR session keeps one owner. Failed extra-worker startup falls back to
  the already prepared workers. `debug.recoveryVisualWorkers` overrides the
  local experiment's image concurrency (capped at eight) for paired benchmarks.
- `debug.recoveryPipeline: false` is a local comparison switch restoring the
  prior main-thread acquisition and per-frame reader barrier. It is not exposed
  in the user interface. Identical input frames and final fields must be compared;
  independently recorded live runs alone cannot isolate this optimization.

`plugin.ts` applies explicit, fail-closed dev transformations to the scanner and
workers. This keeps acquisition, OCR and production completion policies intact
outside this opt-in experiment. Geometry is based on edge continuity; it is not
a full atlas-template detector. Independent live screen-share validation is still
required before promoting this path into production.

## Validation

`tests/recognition-experiment.test.ts` covers masked pixels, false rarity hints,
shared artwork, blank/noisy inputs, partial-field merging, identity-only duplicate
groups, geometry guards, malformed masks, and exhaustive/pruned matcher parity.
Synthetic fixtures do not establish accuracy for the whole live game catalog.

Keep native screenshots/videos and generated references in ignored directories.
Record exact input hashes, initial inventory size, source (offline vs real track),
sharing-end inventory, final values, timing and unresolved cards. A recovery test
seeded with a previous inventory must be reported separately from an empty run.
Compare recognition and end-to-end time separately: a more expensive fallback can
reduce OCR attempts without reducing overall scan duration.
