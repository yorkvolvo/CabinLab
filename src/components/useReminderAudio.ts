import { useEffect, useRef } from 'react';
import type { RunSnapshot } from '../domain/runtime';

export function useReminderAudio(snapshot: RunSnapshot | null) {
  const audio = useRef<AudioContext | null>(null);
  const played = useRef('');

  useEffect(
    () => () => {
      const context = audio.current;
      audio.current = null;
      if (context) void context.close().catch(() => {});
    },
    [],
  );

  useEffect(() => {
    const event = snapshot?.events.filter((item) => item.kind === 'reminder').at(-1);
    if (!snapshot || !event) return;
    const marker = `${snapshot.runId}:${event.index}`;
    if (played.current === marker) return;
    played.current = marker;
    const context = audio.current;
    if (context?.state !== 'running') return;
    for (const [index, frequency] of [660, 880].entries()) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime + index * 0.22;
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.12, startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.18);
      tone.connect(gain).connect(context.destination);
      tone.start(startAt);
      tone.stop(startAt + 0.18);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
    }
  }, [snapshot]);

  function enable() {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume().catch(() => {});
    } catch {
      /* 视觉提醒仍可使用。 */
    }
  }

  function silence(next: RunSnapshot) {
    const event = next.events.filter((item) => item.kind === 'reminder').at(-1);
    if (event) played.current = `${next.runId}:${event.index}`;
  }

  return { enable, silence };
}
