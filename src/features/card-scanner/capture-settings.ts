/** Screen text needs more bits as resolution/frame rate rise. This is an
 * encoder request, not a guarantee about the browser or source frame rate. */
export function recordingBitrate(settings: Pick<MediaTrackSettings, "width" | "height" | "frameRate">) {
  const finite = (value: number | undefined, fallback: number) => value && Number.isFinite(value) && value > 0 ? value : fallback;
  const pixels = finite(settings.width, 1920) * finite(settings.height, 1080);
  const fps = Math.min(60, finite(settings.frameRate, 30));
  return Math.round(Math.max(12_000_000, Math.min(64_000_000, pixels * fps * .15)));
}
