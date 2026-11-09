"use client";

import { useState } from "react";

/** A block of text with a Copy button (used for connector URLs, commands and example prompts). */
export function CopyText({ text, label = "Copy", mono = true }: { text: string; label?: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-3 bg-paper-deep/60 p-3 text-sm">
      <p className={`min-w-0 flex-1 whitespace-pre-wrap ${mono ? "break-all font-mono text-xs leading-relaxed sm:text-sm" : "break-words leading-relaxed"}`}>{text}</p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1800);
            },
            () => {},
          );
        }}
        className="shrink-0 border border-ink px-3 py-1 text-xs tracking-wide transition hover:bg-ink hover:text-paper"
        aria-label={`${label}: ${text.slice(0, 40)}`}
      >
        {done ? "Copied" : label}
      </button>
    </div>
  );
}
