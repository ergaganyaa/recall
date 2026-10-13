"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { saveChapterText } from "@/app/actions/library";
import { MAX_CHAPTER_CHARS, prepareTextFile, validateChapterText } from "@/lib/text-file";
import type { ChapterSummary } from "@/lib/types";

const inputCls =
  "mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent";

type Msg = { tone: "ok" | "info" | "err"; text: string };

const toneCls: Record<Msg["tone"], string> = {
  ok: "bg-accent-soft",
  info: "bg-accent-soft text-muted",
  err: "bg-danger/10 text-danger",
};

function titleFromFilename(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 300);
}

/** Add chapter text by paste or .txt/.md upload — the supported text source for the MVP. */
export function AddTextForm({ bookId, chapters }: { bookId: string; chapters: ChapterSummary[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState("0");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);

  function resetFile() {
    if (fileInput.current) fileInput.current.value = "";
    setFileName(null);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMsgs([]);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      setMsgs([{ tone: "err", text: `Couldn't read “${file.name}”. Try selecting it again.` }]);
      resetFile();
      return;
    }
    const result = prepareTextFile(file.name, bytes);
    if (!result.ok) {
      setMsgs([{ tone: "err", text: result.error }]);
      resetFile();
      return;
    }
    setContent(result.text);
    setFileName(file.name);
    if (target === "0" && !title.trim()) setTitle(titleFromFilename(file.name));
    setMsgs([
      { tone: "info", text: `Loaded “${file.name}” (${result.encoding}, ${result.text.length.toLocaleString("en-US")} characters).` },
      ...result.notes.map((text) => ({ tone: "info" as const, text })),
    ]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validateChapterText(content);
    if (problem) return setMsgs([{ tone: "err", text: problem }]);
    if (target === "0" && !title.trim()) return setMsgs([{ tone: "err", text: "Give the new chapter a title." }]);

    setMsgs([]);
    startTransition(async () => {
      try {
        const res = await saveChapterText({ bookId, chapterNumber: Number(target), title, content });
        if (res.ok) {
          setMsgs([{ tone: "ok", text: `Saved chapter ${res.data.chapterNumber} and indexed it for search.` }]);
          setContent("");
          setTitle("");
          setTarget("0");
          resetFile();
          router.refresh();
        } else {
          setMsgs([{ tone: "err", text: res.error }]);
        }
      } catch {
        setMsgs([{ tone: "err", text: "The text couldn't be sent (it may be too large). Try a shorter chapter." }]);
      }
    });
  }

  const over = content.length > MAX_CHAPTER_CHARS;

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-muted">
        Paste text or upload a .txt / .md file you have the right to use (UTF-8, UTF-16 and Windows-1251 are
        detected). It is stored privately in your account.
      </p>

      <label className="block text-xs font-medium">
        Chapter
        <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls}>
          <option value="0">+ New chapter at the end</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.number}>
              Ch. {c.number} — {c.title}
              {c.has_content ? " (replace text)" : ""}
            </option>
          ))}
        </select>
      </label>

      {target === "0" && (
        <label className="block text-xs font-medium">
          New chapter title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className={inputCls} />
        </label>
      )}

      <label className="block text-xs font-medium">
        Text file (.txt / .md, up to 2 MB)
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,.markdown,text/plain,text/markdown"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="mt-1 block w-full text-xs file:mr-3 file:rounded-full file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-medium"
        />
      </label>

      <label className="block text-xs font-medium">
        …or paste text
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            if (fileName) resetFile();
          }}
          rows={6}
          className={`${inputCls} font-mono`}
        />
        <span className={`mt-1 block text-right font-normal ${over ? "text-danger" : "text-muted"}`}>
          {content.length.toLocaleString("en-US")} / {MAX_CHAPTER_CHARS.toLocaleString("en-US")} characters
        </span>
      </label>

      <div aria-live="polite" className="space-y-2">
        {msgs.map((m, i) => (
          <p key={i} role={m.tone === "err" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-xs ${toneCls[m.tone]}`}>
            {m.text}
          </p>
        ))}
      </div>

      <button
        disabled={pending || !content.trim()}
        className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save chapter text"}
      </button>
    </form>
  );
}
