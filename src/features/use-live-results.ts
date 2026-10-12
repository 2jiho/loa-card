import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScannedCard } from './card-scanner/recognizer';
import { resultCardsKey } from './live-results';

/** Sample, rather than debounce, so a continuous stream cannot postpone updates forever. */
export function useLiveResults(cards: ScannedCard[], xp: number | undefined, busy: boolean) {
  const key = resultCardsKey(cards);
  // Only calculation fields affect these views. Keep references stable on scanner status updates.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- key includes every field consumed by result calculations
  const input = useMemo(() => ({ cards, xp }), [key, xp]);
  const latest = useRef(input);
  useEffect(() => { latest.current = input; }, [input]);
  const [snapshot, setSnapshot] = useState(input);
  useEffect(() => {
    if (!busy) return;
    setSnapshot(latest.current);
    const timer = setInterval(() => setSnapshot(latest.current), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  // Empty/reset and final results must never wait for the sampling timer.
  return busy && cards.length ? snapshot : input;
}
