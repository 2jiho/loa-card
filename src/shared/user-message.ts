/** The text to show a person for an error: the app's own messages are written in Korean for them; a
 * browser's or library's message (English, technical) is replaced by `fallback`. */
export function userMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /[가-힣]/.test(message) ? message : fallback;
}
