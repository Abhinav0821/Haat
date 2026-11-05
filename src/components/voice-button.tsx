"use client";

import { useEffect, useRef, useState } from "react";

/** Minimal play/pause control for the maker's own voice note. */
export function VoiceButton({ src, label, className = "" }: { src: string; label: string; className?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => () => audio.current?.pause(), []);

  function toggle() {
    if (!audio.current) {
      audio.current = new Audio(src);
      audio.current.onended = () => setPlaying(false);
      audio.current.onpause = () => setPlaying(false);
      audio.current.onplay = () => setPlaying(true);
    }
    if (playing) audio.current.pause();
    else void audio.current.play();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={playing}
      className={`group inline-flex items-center gap-3 text-sm text-ink ${className}`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-ink/70 transition group-hover:bg-ink group-hover:text-paper">
        {playing ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
            <rect x="2" y="1.5" width="2.6" height="9" />
            <rect x="7.4" y="1.5" width="2.6" height="9" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" className="ml-0.5 h-3 w-3" fill="currentColor" aria-hidden>
            <path d="M3 1.5v9l7.5-4.5z" />
          </svg>
        )}
      </span>
      <span className="underline-offset-4 group-hover:underline">{playing ? "Pause" : label}</span>
    </button>
  );
}
