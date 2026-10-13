"use client";

import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { createBook, importNovelFromUrl, type CreateBookState } from "@/app/actions/library";
import { analyzeOutline, describeOutline } from "@/lib/outline";
import { BOOK_STATUSES, STATUS_LABELS } from "@/lib/types";

type Fields = {
  title: string;
  author: string;
  cover_url: string;
  description: string;
  source_url: string;
};
const EMPTY: Fields = { title: "", author: "", cover_url: "", description: "", source_url: "" };

const inputCls =
  "mt-1 w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-sm outline-none focus:border-accent";

export function AddNovelForm() {
  const [url, setUrl] = useState("");
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [status, setStatus] = useState<string>("reading");
  const [outline, setOutline] = useState("");
  // What the last import wrote, so a re-import only replaces fields the user hasn't edited.
  const lastImported = useRef<Fields>(EMPTY);

  const [importing, startImport] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [state, action, saving] = useActionState<CreateBookState, FormData>(createBook, {});

  const analysis = useMemo(() => analyzeOutline(outline), [outline]);
  const set = (key: keyof Fields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));

  function applyImport(next: Fields) {
    const previous = lastImported.current; // captured now; the updater below runs later
    setFields((current) => {
      const merged = { ...current };
      for (const key of Object.keys(next) as (keyof Fields)[]) {
        const untouched = current[key] === "" || current[key] === previous[key];
        if (next[key] && untouched) merged[key] = next[key];
      }
      return merged;
    });
    lastImported.current = next;
  }

  function runImport() {
    setNotice(null);
    startImport(async () => {
      try {
        const res = await importNovelFromUrl(url);
        if (res.ok) {
          const m = res.metadata;
          applyImport({
            title: m.title ?? "",
            author: m.author ?? "",
            description: m.description ?? "",
            cover_url: m.cover_url ?? "",
            source_url: m.source_url,
          });
          setNotice({ tone: "ok", text: `Found “${m.title}”. ${res.notes.join(" ")} Review the details below, then save.` });
        } else {
          // Keep what we know (the link, and a title guessed from it) so nothing has to be retyped.
          applyImport({ ...EMPTY, title: res.fallbackTitle ?? "", source_url: res.source_url ?? "" });
          setNotice({
            tone: "warn",
            text: `${res.error}${res.source_url ? " Your link was kept — fill in the details below." : ""}`,
          });
        }
      } catch {
        setNotice({ tone: "warn", text: "Import failed unexpectedly. You can fill in the details manually." });
      }
    });
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">Import from Ranobelib</h2>
        <p className="mt-1 text-sm text-muted">
          Paste a link to the novel&apos;s main page. Recall asks the site only for public details (title, cover,
          author, description) and never downloads chapter text. If the site returns nothing, the link is kept and
          you can fill everything in by hand.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="import-url">
            Ranobelib link
          </label>
          <input
            id="import-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://ranobelib.me/ru/book/…"
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={runImport}
            disabled={importing || !url.trim()}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {importing ? "Fetching…" : "Fetch details"}
          </button>
        </div>
        {notice && (
          <p
            role="status"
            className={`mt-3 rounded-xl px-3 py-2 text-sm ${
              notice.tone === "ok" ? "bg-accent-soft" : "bg-danger/10 text-danger"
            }`}
          >
            {notice.text}
          </p>
        )}
      </section>

      <form action={action} className="space-y-5 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">Novel details</h2>

        <label className="block text-sm font-medium">
          Title *
          <input
            name="title"
            required
            maxLength={300}
            value={fields.title}
            onChange={(e) => set("title")(e.target.value)}
            className={inputCls}
          />
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Author
            <input
              name="author"
              maxLength={200}
              value={fields.author}
              onChange={(e) => set("author")(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block text-sm font-medium">
            Status
            <select name="status" value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              {BOOK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium">
          Cover image link (https)
          <input
            name="cover_url"
            type="url"
            value={fields.cover_url}
            onChange={(e) => set("cover_url")(e.target.value)}
            placeholder="https://…"
            className={inputCls}
          />
        </label>
        <label className="block text-sm font-medium">
          Source link <span className="font-normal text-muted">(optional, ranobelib.me)</span>
          <input
            name="source_url"
            type="url"
            value={fields.source_url}
            onChange={(e) => set("source_url")(e.target.value)}
            placeholder="https://ranobelib.me/…"
            className={inputCls}
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            Used for the “Open on the original site” link in the book and reader.
          </span>
        </label>
        <label className="block text-sm font-medium">
          Description
          <textarea
            name="description"
            rows={4}
            maxLength={4000}
            value={fields.description}
            onChange={(e) => set("description")(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block text-sm font-medium">
          Chapter list <span className="font-normal text-muted">(optional)</span>
          <textarea
            name="outline"
            rows={7}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
            placeholder={"# Volume 1: The Beginning\nChapter 1 title\nChapter 2 title\n# Volume 2\nChapter 3 title"}
            className={`${inputCls} font-mono`}
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            One chapter title per line. A line starting with # (or “Volume 2: …”) starts a new volume. You can add
            more chapters later.
          </span>
          {outline.trim() && (
            <span
              className={`mt-2 block rounded-lg px-3 py-2 text-xs font-normal ${
                analysis.warnings.length ? "bg-danger/10 text-danger" : "bg-accent-soft"
              }`}
              aria-live="polite"
            >
              {describeOutline(analysis)}
              {analysis.warnings.map((w) => (
                <span key={w} className="mt-1 block">
                  {w}
                </span>
              ))}
            </span>
          )}
        </label>

        {state.error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {state.error}
          </p>
        )}
        <button
          disabled={saving}
          className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Add to library"}
        </button>
      </form>
    </div>
  );
}
