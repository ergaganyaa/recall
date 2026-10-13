"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { addChaptersFromOutline } from "@/app/actions/library";
import { analyzeOutline, describeOutline, MAX_OUTLINE_CHAPTERS } from "@/lib/outline";

/** Bulk-add chapter titles (and volumes) to an existing book from a plain list. */
export function AddChaptersForm({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const analysis = useMemo(() => analyzeOutline(text), [text]);
  const tooMany = analysis.chapterCount > MAX_OUTLINE_CHAPTERS;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await addChaptersFromOutline(bookId, text);
        if (res.ok) {
          const { added, volumes, warnings } = res.data;
          setMsg({
            tone: "ok",
            text: `Added ${added} ${added === 1 ? "chapter" : "chapters"}${volumes ? ` in ${volumes} new ${volumes === 1 ? "volume" : "volumes"}` : ""}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
          });
          setText("");
          router.refresh();
        } else {
          setMsg({ tone: "err", text: res.error });
        }
      } catch {
        setMsg({ tone: "err", text: "Couldn't add the chapters. Please try again." });
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-muted">
        One chapter title per line, added after your last chapter. Start a line with <code className="font-mono">#</code>{" "}
        (or write <code className="font-mono">Volume 2: Title</code>) to begin a new volume. Chapters before the first
        heading continue the current volume.
      </p>
      <label className="block text-xs font-medium">
        Chapter list
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"# Volume 2: Tides of Brass\nThe Harbor That Never Moved\nA Contract With Smoke\n# Volume 3\nCount the Hours"}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
      </label>

      {text.trim() && (
        <p
          aria-live="polite"
          className={`rounded-xl px-3 py-2 text-xs ${analysis.warnings.length ? "bg-danger/10 text-danger" : "bg-accent-soft"}`}
        >
          {describeOutline(analysis)}
          {analysis.warnings.map((w) => (
            <span key={w} className="mt-1 block">
              {w}
            </span>
          ))}
        </p>
      )}
      {msg && (
        <p role={msg.tone === "err" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-xs ${msg.tone === "err" ? "bg-danger/10 text-danger" : "bg-accent-soft"}`}>
          {msg.text}
        </p>
      )}
      <button
        disabled={pending || analysis.chapterCount === 0 || tooMany}
        className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Adding…" : analysis.chapterCount ? `Add ${analysis.chapterCount} ${analysis.chapterCount === 1 ? "chapter" : "chapters"}` : "Add chapters"}
      </button>
    </form>
  );
}
