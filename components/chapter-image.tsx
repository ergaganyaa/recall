"use client";

import { useState } from "react";

/**
 * One illustration in the reader. It is never cropped or stretched (the image keeps its own
 * proportions and shrinks to fit the screen), and it never disappears silently: if the picture
 * is missing or fails to load, a visible placeholder says so.
 */
export function ChapterImage({
  src,
  alt,
  width,
  height,
  eager,
}: {
  src: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt || "Illustration unavailable"}
        className="mx-auto flex min-h-32 max-w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-center text-sm text-muted"
        style={width && height ? { aspectRatio: `${width} / ${height}`, maxHeight: "90vh" } : undefined}
      >
        <span>{src ? "This illustration couldn't be loaded." : "This illustration is missing from your library."}</span>
        {src ? (
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setAttempt((a) => a + 1);
            }}
            className="rounded-full border border-border px-3 py-1 text-xs text-foreground hover:bg-accent-soft"
          >
            Try again
          </button>
        ) : (
          <span className="text-xs">Re-import this volume to restore it.</span>
        )}
      </div>
    );
  }

  return (
    // Private, auth-checked route with its own size: next/image does not apply.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={attempt ? `${src}?retry=${attempt}` : src}
      alt={alt || "Illustration"}
      width={width ?? undefined}
      height={height ?? undefined}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
      className="mx-auto block h-auto w-auto max-h-[90vh] max-w-full rounded-lg object-contain"
      style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}
    />
  );
}
