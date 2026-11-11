"use client";

import { useState } from "react";

/** A block of text with a Copy button (used for connector URLs, commands and example prompts). */
export function CopyText({ text, label = "Copy", mono = true }: { text: string; label?: string; mono?: boolean }) {
  const [status, setStatus] = useState<"ready" | "copied" | "error">("ready");
  return (
    <div className="bg-paper-deep/60 p-3 text-sm">
      <div className="flex items-start gap-3">
        <p className={`min-w-0 flex-1 whitespace-pre-wrap ${mono ? "break-all font-mono text-xs leading-relaxed sm:text-sm" : "break-words leading-relaxed"}`}>{text}</p>
        <button
          type="button"
          onClick={async () => {
            setStatus("ready");
            try {
              if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(text);
              setStatus("copied");
            } catch {
              setStatus("error");
            }
          }}
          className="shrink-0 border border-ink px-3 py-1 text-xs tracking-wide transition hover:bg-ink hover:text-paper"
          aria-label={`${label}: ${text.slice(0, 40)}`}
        >
          {status === "copied" ? "Copied" : label}
        </button>
      </div>
      <p role="status" className="text-xs leading-relaxed text-muted">
        {status === "error" ? "Couldn’t copy—select the text manually." : status === "copied" ? "Copied to clipboard." : ""}
      </p>
    </div>
  );
}
