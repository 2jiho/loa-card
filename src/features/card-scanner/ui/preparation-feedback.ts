/** Hide transient stages without delaying preparation or its terminal state. */
export function createPreparationFeedback(publish: (message: string) => void, delayMs = 700) {
  let stage = '', latest = '', visible = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    update(message: string) {
      if (closed) return;
      // Byte updates belong to the same load operation, not a new stage.
      const key = message.replace(/\s[\d.]+(?: \/ [\d.]+)? MB$/, '');
      latest = message;
      if (key !== stage) {
        stage = key;
        visible = false;
        clearTimeout(timer);
        publish('');
        timer = setTimeout(() => { visible = true; publish(latest); }, delayMs);
      } else if (visible) publish(latest);
    },
    dispose() { closed = true; clearTimeout(timer); },
  };
}
