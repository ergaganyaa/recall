"use client";

import { useState } from "react";

const PALETTES: [string, string][] = [
  ["#4338ca", "#db2777"],
  ["#0f766e", "#65a30d"],
  ["#7c3aed", "#0ea5e9"],
  ["#0c4a6e", "#475569"],
  ["#e11d48", "#f59e0b"],
  ["#92400e", "#1e293b"],
];

function paletteFor(title: string) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

/** Real cover when available; a generated gradient cover otherwise (or if the image fails). */
export function BookCover({
  title,
  author,
  coverUrl,
  className = "",
}: {
  title: string;
  author?: string | null;
  coverUrl?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = `relative aspect-[2/3] overflow-hidden rounded-xl shadow-lg ${className}`;

  if (coverUrl && !failed) {
    return (
      <div className={base}>
        {/* Remote covers come from arbitrary hosts, so next/image is not used. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverUrl}
          alt={`Cover of ${title}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  const [a, b] = paletteFor(title);
  return (
    <div
      role="img"
      aria-label={`Cover of ${title}`}
      className={`${base} flex flex-col justify-between p-4 text-white`}
      style={{ backgroundImage: `linear-gradient(155deg, ${a}, ${b})` }}
    >
      <div className="absolute inset-y-0 left-0 w-2 bg-black/20" aria-hidden />
      <div className="absolute -right-8 -top-8 size-32 rounded-full bg-white/15 blur-2xl" aria-hidden />
      <span className="pl-2 text-[0.65rem] font-medium uppercase tracking-[0.2em] text-white/70">Novel</span>
      <div className="pl-2">
        <p className="text-balance text-lg font-bold leading-tight drop-shadow sm:text-xl">{title}</p>
        {author && <p className="mt-2 text-xs text-white/80">{author}</p>}
      </div>
    </div>
  );
}
