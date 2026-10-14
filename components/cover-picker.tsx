"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedImage } from "@/lib/epub";
import { ALLOWED_IMAGE_TYPES, sniffImage } from "@/lib/image-sniff";
import { makeCoverThumbnail } from "@/lib/pdf-browser";

export type CoverChoice = { type: "candidate"; ref: string } | { type: "custom" } | { type: "none" };

/** Preview the detected cover, pick another candidate, upload your own, or use none. */
export function CoverPicker({
  candidates,
  images,
  choice,
  onChoice,
  custom,
  onCustom,
  disabled,
}: {
  candidates: { ref: string; label: string }[];
  images: Map<string, ParsedImage>;
  choice: CoverChoice;
  onChoice: (c: CoverChoice) => void;
  custom: ParsedImage | null;
  onCustom: (img: ParsedImage | null) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const list: { key: string; label: string; choice: CoverChoice; image: ParsedImage }[] = [];
    for (const c of candidates) {
      const image = images.get(c.ref);
      if (image) list.push({ key: c.ref, label: c.label, choice: { type: "candidate", ref: c.ref }, image });
    }
    if (custom) list.push({ key: "custom", label: "Your image", choice: { type: "custom" }, image: custom });
    return list;
  }, [candidates, images, custom]);

  const urls = useMemo(
    () => options.map((o) => URL.createObjectURL(new Blob([o.image.bytes as BlobPart], { type: o.image.mime }))),
    [options],
  );
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("That image is over 15 MB.");
      const raw = new Uint8Array(await file.arrayBuffer());
      const info = sniffImage(raw);
      if (!info) throw new Error(`Use a ${ALLOWED_IMAGE_TYPES.map((t) => t.replace("image/", "").toUpperCase()).join(", ")} image.`);
      const thumb = await makeCoverThumbnail(file);
      onCustom({ ref: "custom-cover", bytes: thumb.bytes, mime: "image/jpeg", width: thumb.width, height: thumb.height });
      onChoice({ type: "custom" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't use that image.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const isChosen = (c: CoverChoice) =>
    c.type === choice.type && (c.type !== "candidate" || (choice.type === "candidate" && c.ref === choice.ref));

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium">Volume cover</legend>
      <p className="text-xs text-muted">
        Used in the volume browser, and as the book&apos;s cover while this is your most recently imported volume. It is separate
        from the pictures inside the chapters.
      </p>
      <div className="flex flex-wrap gap-3">
        {options.map((o, i) => (
          <button
            type="button"
            key={o.key}
            aria-pressed={isChosen(o.choice)}
            onClick={() => onChoice(o.choice)}
            className={`w-24 rounded-xl border p-1 text-left transition ${isChosen(o.choice) ? "border-accent ring-2 ring-accent" : "border-border hover:border-accent"}`}
          >
            {/* Local object URL of an in-memory image: next/image does not apply. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={urls[i]} alt={o.label} className="aspect-[2/3] w-full rounded-lg bg-accent-soft object-cover" />
            <span className="mt-1 block truncate px-1 text-[0.65rem] text-muted">{o.label}</span>
          </button>
        ))}
        <button
          type="button"
          aria-pressed={choice.type === "none"}
          onClick={() => onChoice({ type: "none" })}
          className={`grid h-[8.6rem] w-24 place-items-center rounded-xl border border-dashed p-1 text-center text-xs text-muted ${choice.type === "none" ? "border-accent text-accent ring-2 ring-accent" : "border-border hover:border-accent"}`}
        >
          No cover
        </button>
      </div>
      {options.length === 0 && <p className="text-xs text-muted">No suitable cover was found in the file. You can upload one.</p>}
      <div>
        <label className="text-xs font-medium">
          Use your own image
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="mt-1 block w-full text-xs file:mr-3 file:rounded-full file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-medium"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </fieldset>
  );
}
