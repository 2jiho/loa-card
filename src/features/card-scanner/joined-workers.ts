/** A failed consumer stops new work, but all current consumers must finish
 * before their shared canvases and OCR sessions can be released. */
export async function runJoinedWorkers(
  workers: ((stopped: () => boolean) => Promise<void>)[],
) {
  let failed = false;
  let firstError: unknown;
  await Promise.all(workers.map(async worker => {
    try { await worker(() => failed); }
    catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }));
  if (failed) throw firstError;
}
