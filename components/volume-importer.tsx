"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { deleteVolume, finalizeVolumeImport, saveImportedChapter, setBookCover, startVolumeImport } from "@/app/actions/import";
import type { ImageReport } from "@/lib/chapter-merge";
import { EpubError, parseEpub, type ParsedChapter, type ParsedImage } from "@/lib/epub";
import { EXTENSION_FOR } from "@/lib/image-sniff";
import {
  discardImport,
  retryFailedChapters,
  runVolumeImport,
  type RunInput,
  type RunnerDeps,
  type RunResult,
  type RunState,
} from "@/lib/import-runner";
import { inspectPdf, parsePdf, PdfError, PDF_MAX_BYTES, type PdfInspection, type PdfOptions } from "@/lib/pdf";
import { browserCanvas, loadPdfJs } from "@/lib/pdf-browser";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { MAX_UPLOAD_BYTES, prepareTextFile } from "@/lib/text-file";
import { chaptersFromTextSources } from "@/lib/text-import";
import { ChapterEditor, type EditableStructure } from "./chapter-editor";
import { CoverPicker, type CoverChoice } from "./cover-picker";

type ExistingVolume = { number: number; arc: string | null; arc_order: number; title: string | null };

type Draft = {
  kind: "epub" | "text" | "pdf";
  fileLabel: string;
  title: string | null;
  language: string | null;
  seriesIndex: number | null;
  coverCandidates: { ref: string; label: string }[];
  images: Map<string, ParsedImage>;
  warnings: string[];
  pdfNote: string | null;
  /** Pictures found vs kept, and why any were skipped. */
  imageReport: ImageReport | null;
};

type Scanned = { bytes: Uint8Array; fileName: string; info: PdfInspection };

const EPUB_MAX_BYTES = 120 * 1024 * 1024;
const BUCKET = "book-images";
const inputCls =
  "mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent";

export function VolumeImporter({
  bookId,
  bookTitle,
  hasManualCover,
  existing,
}: {
  bookId: string;
  bookTitle: string;
  hasManualCover: boolean;
  existing: ExistingVolume[];
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "Reading page 12 of 80" etc.
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [structure, setStructure] = useState<EditableStructure>({ chapters: [], include: [] });

  // volume details
  const [number, setNumber] = useState("");
  const [arc, setArc] = useState(existing.at(-1)?.arc ?? "");
  const [arcOrder, setArcOrder] = useState(String(existing.at(-1)?.arc_order ?? 1));
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("");
  const [replace, setReplace] = useState(false);

  // cover
  const [coverChoice, setCoverChoice] = useState<CoverChoice>({ type: "none" });
  const [customCover, setCustomCover] = useState<ParsedImage | null>(null);
  const [setAsBookCover, setSetAsBookCover] = useState(false);

  // run state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const runRef = useRef<{ input: RunInput; state: RunState } | null>(null);

  const num = Number(number);
  const numValid = number.trim() !== "" && Number.isFinite(num) && num > 0 && Math.abs(num * 100 - Math.round(num * 100)) < 1e-9;
  const arcOrderNum = Number(arcOrder);
  const conflict = useMemo(
    () => numValid && existing.find((v) => v.arc_order === arcOrderNum && v.number === num),
    [existing, num, numValid, arcOrderNum],
  );

  const chosenIdx = structure.chapters.map((_, i) => i).filter((i) => structure.include[i]);
  const totals = chosenIdx.reduce(
    (t, i) => ({ words: t.words + structure.chapters[i].wordCount, images: t.images + structure.chapters[i].imageCount }),
    { words: 0, images: 0 },
  );

  const supabase = useMemo(() => (typeof window === "undefined" ? null : createBrowserSupabase()), []);

  function reset() {
    abort.current?.abort();
    setDraft(null);
    setScanned(null);
    setStructure({ chapters: [], include: [] });
    setResult(null);
    setError(null);
    setBusy(null);
    setCustomCover(null);
    runRef.current = null;
    if (fileInput.current) fileInput.current.value = "";
  }

  function adopt(next: Draft, chapters: ParsedChapter[]) {
    setDraft(next);
    setScanned(null);
    setStructure({ chapters, include: chapters.map(() => true) });
    setTitle(next.title ?? "");
    setLanguage(next.language ?? "");
    setCustomCover(null);
    setSetAsBookCover(false);
    setCoverChoice(next.coverCandidates[0] ? { type: "candidate", ref: next.coverCandidates[0].ref } : { type: "none" });
    const sameArc = existing.filter((v) => v.arc_order === Number(arcOrder));
    setNumber(next.seriesIndex !== null ? String(next.seriesIndex) : String(Math.floor(Math.max(0, ...sameArc.map((v) => v.number))) + 1));
    setReplace(false);
  }

  // ------------------------------------------------------------------ choose & parse
  const pdfOptions = async (): Promise<PdfOptions> => ({
    pdfjs: await loadPdfJs(),
    canvas: browserCanvas,
    signal: abort.current?.signal,
    onProgress: (done, total, label) => setBusy(`${label}${total ? ` (${done}/${total})` : ""}`),
  });

  async function parsePdfFile(bytes: Uint8Array, fileName: string, mode: "text" | "pages-as-images") {
    setBusy("Reading the PDF…");
    const v = await parsePdf(bytes, { ...(await pdfOptions()), mode });
    const noteParts = [`${v.pageCount} pages`, v.structure === "outline" ? "chapters from the PDF's bookmarks" : v.structure === "headings" ? "chapters from detected headings" : "no chapters detected"];
    adopt(
      {
        kind: "pdf",
        fileLabel: fileName,
        title: v.title,
        language: v.language,
        seriesIndex: null,
        coverCandidates: v.coverCandidates ?? [],
        images: v.images,
        warnings: v.warnings,
        pdfNote: noteParts.join(" · "),
        imageReport: v.imageReport ?? null,
      },
      v.chapters,
    );
  }

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    setResult(null);
    setDraft(null);
    setScanned(null);
    abort.current = new AbortController();
    setBusy("Reading the file…");
    try {
      const files = [...list];
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      const epubs = files.filter((f) => /\.epub$/i.test(f.name));

      if (pdfs.length > 0) {
        if (files.length > 1) throw new Error("Choose one PDF on its own.");
        const f = pdfs[0];
        if (f.size > PDF_MAX_BYTES) throw new Error(`“${f.name}” is ${(f.size / 1e6).toFixed(0)} MB; the limit is ${PDF_MAX_BYTES / 1e6} MB.`);
        const bytes = new Uint8Array(await f.arrayBuffer());
        const info = await inspectPdf(bytes, await pdfOptions());
        if (info.scanned) {
          setScanned({ bytes, fileName: f.name, info });
          return;
        }
        await parsePdfFile(bytes, f.name, "text");
        return;
      }

      if (epubs.length > 0) {
        if (files.length > 1) throw new Error("Choose either one EPUB file or several text files, not both.");
        const f = epubs[0];
        if (f.size > EPUB_MAX_BYTES) throw new Error(`“${f.name}” is ${(f.size / 1e6).toFixed(0)} MB; the limit is ${EPUB_MAX_BYTES / 1e6} MB.`);
        const v = parseEpub(new Uint8Array(await f.arrayBuffer()));
        adopt(
          {
            kind: "epub",
            fileLabel: f.name,
            title: v.title,
            language: v.language,
            seriesIndex: v.seriesIndex,
            coverCandidates: v.coverRef ? [{ ref: v.coverRef, label: "Cover from the EPUB" }] : [],
            images: v.images,
            warnings: v.warnings,
            pdfNote: null,
            imageReport: v.imageReport ?? null,
          },
          v.chapters,
        );
        return;
      }

      const sources: { name: string; text: string }[] = [];
      const problems: string[] = [];
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          problems.push(`“${f.name}” is over ${MAX_UPLOAD_BYTES / 1e6} MB.`);
          continue;
        }
        const r = prepareTextFile(f.name, new Uint8Array(await f.arrayBuffer()));
        if (r.ok) sources.push({ name: f.name, text: r.text });
        else problems.push(r.error);
      }
      if (problems.length) throw new Error(problems.join(" "));
      const { chapters, warnings } = chaptersFromTextSources(sources);
      if (chapters.length === 0) throw new Error("No chapter text could be found in the selected files.");
      adopt(
        {
          kind: "text",
          fileLabel: files.length === 1 ? files[0].name : `${files.length} text files`,
          title: null,
          language: null,
          seriesIndex: null,
          coverCandidates: [],
          images: new Map(),
          warnings,
          pdfNote: null,
          imageReport: null,
        },
        chapters,
      );
    } catch (e) {
      if (e instanceof PdfError && e.code === "cancelled") return;
      setError(e instanceof PdfError || e instanceof EpubError || e instanceof Error ? e.message : "Couldn't read that file.");
      if (fileInput.current) fileInput.current.value = "";
    } finally {
      setBusy(null);
    }
  }

  async function importScannedAsImages() {
    if (!scanned) return;
    setError(null);
    abort.current = new AbortController();
    try {
      await parsePdfFile(scanned.bytes, scanned.fileName, "pages-as-images");
    } catch (e) {
      if (e instanceof PdfError && e.code === "cancelled") return;
      setError(e instanceof Error ? e.message : "Couldn't read that PDF.");
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------------ saving
  const coverImage: ParsedImage | null = !draft
    ? null
    : coverChoice.type === "custom"
      ? customCover
      : coverChoice.type === "candidate"
        ? (draft.images.get(coverChoice.ref) ?? null)
        : null;

  function buildDeps(): RunnerDeps {
    return {
      start: (input) =>
        startVolumeImport({
          bookId: input.bookId,
          number: input.number,
          arc: input.arc,
          arcOrder: input.arcOrder,
          title: input.title,
          language: input.language,
          replace: input.replace,
          chapterTitles: input.chapterTitles,
        }),
      uploadImage: async (userId, img) => {
        const id = crypto.randomUUID();
        const path = `${userId}/${bookId}/${id}.${EXTENSION_FOR[img.mime]}`;
        const { error: upErr } = await supabase!.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.mime, upsert: false });
        if (upErr) throw new Error(`Couldn't upload an illustration (${upErr.message}).`);
        return { id, path, mime: img.mime, width: img.width, height: img.height, bytes: img.bytes.byteLength };
      },
      removeObjects: async (paths) => {
        for (let i = 0; i < paths.length; i += 100) await supabase!.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      },
      saveChapter: (input) => saveImportedChapter(input),
      finalize: (input) => finalizeVolumeImport(input),
      discard: (volumeId) => deleteVolume(volumeId, bookId),
      setBookCover: (input) => setBookCover(input),
    };
  }

  async function runImport() {
    if (!draft || !supabase || !numValid) return;
    setError(null);
    setResult(null);
    setRunning(true);
    abort.current = new AbortController();
    const input: RunInput = {
      bookId,
      meta: { number: num, arc: arc.trim(), arcOrder: arcOrderNum, title: title.trim(), language: language.trim(), replace: !!conflict && replace },
      chapters: chosenIdx.map((i) => structure.chapters[i]),
      images: draft.images,
      cover: coverImage,
      setAsBookCover: setAsBookCover && !!coverImage,
      deps: buildDeps(),
      onProgress: (done, total, label) => setProgress({ done, total, label }),
      signal: abort.current.signal,
    };
    try {
      const res = await runVolumeImport(input);
      if (res.status === "done" || res.status === "incomplete") runRef.current = { input, state: res.state };
      setResult(res);
    } finally {
      setRunning(false);
    }
  }

  async function retry() {
    const r = runRef.current;
    if (!r) return;
    setRunning(true);
    abort.current = new AbortController();
    r.input.signal = abort.current.signal;
    try {
      const res = await retryFailedChapters(r.input, r.state);
      if (res.status === "done" || res.status === "incomplete") runRef.current = { input: r.input, state: res.state };
      setResult(res);
    } finally {
      setRunning(false);
    }
  }

  async function discard() {
    const r = runRef.current;
    if (!r) return;
    setRunning(true);
    try {
      await discardImport(r.input.deps, r.state);
      runRef.current = null;
      setResult({ status: "cancelled" });
    } finally {
      setRunning(false);
    }
  }

  // ------------------------------------------------------------------ render: results
  if (result?.status === "done") {
    const outcomes = result.state.outcomes;
    const withText = outcomes.filter((o) => o.words > 0).length;
    const illOnly = outcomes.filter((o) => o.words === 0 && o.images > 0).length;
    return (
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-live="polite">
        <h2 className="text-lg font-semibold">Volume {num} imported</h2>
        <ul className="grid gap-2 text-sm sm:grid-cols-3">
          <li className="rounded-xl bg-accent-soft px-3 py-2">{withText} full-text chapters</li>
          <li className="rounded-xl bg-accent-soft px-3 py-2">{illOnly} illustration-only chapters</li>
          <li className="rounded-xl bg-accent-soft px-3 py-2">{outcomes.reduce((n, o) => n + o.images, 0)} illustrations</li>
        </ul>
        {result.warnings.map((w) => (
          <p key={w} className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{w}</p>
        ))}
        <div className="flex flex-wrap gap-2">
          <Link href={`/library/${bookId}`} className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground">
            Open {bookTitle}
          </Link>
          <Link href="/" className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-accent-soft">
            Go to Home
          </Link>
          <button onClick={reset} className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-accent-soft">
            Import another volume
          </button>
        </div>
      </div>
    );
  }

  if (result?.status === "incomplete") {
    const failed = result.state.outcomes.filter((o) => !o.ok);
    return (
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-live="polite">
        <h2 className="text-lg font-semibold">Volume {num} is not fully imported</h2>
        <p className="text-sm text-muted">
          It is <strong>not</strong> marked as imported, so it won&apos;t change your book cover. Retry the failed chapters, or discard this import to remove
          everything it saved.
        </p>
        {result.error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{result.error}</p>}
        <ul className="space-y-1 text-sm">
          {failed.map((o) => (
            <li key={o.number} className="text-danger">
              Ch. {o.number} — {o.title}: {o.error}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button onClick={retry} disabled={running} className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground disabled:opacity-50">
            {running ? progress.label || "Retrying…" : "Retry"}
          </button>
          <button onClick={discard} disabled={running} className="rounded-full border border-border px-5 py-2.5 text-sm hover:border-danger hover:text-danger disabled:opacity-50">
            Discard this import
          </button>
        </div>
      </div>
    );
  }

  if (result?.status === "failed" || result?.status === "cancelled") {
    return (
      <div className="space-y-4 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-live="polite">
        <h2 className="text-lg font-semibold">{result.status === "cancelled" ? "Import cancelled" : "Import failed"}</h2>
        <p className="text-sm text-muted">
          {result.status === "cancelled" ? "Nothing was kept: the volume and any uploaded pictures were removed." : `${result.error} Nothing was changed.`}
        </p>
        <button onClick={reset} className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground">
          Start over
        </button>
      </div>
    );
  }

  // ------------------------------------------------------------------ render: pick & preview
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <h2 className="font-semibold">1. Choose your file</h2>
        <p className="mt-1 text-sm text-muted">
          One <strong>PDF</strong> or <strong>EPUB</strong> (a whole volume, with its illustrations), or one or more <strong>.txt / .md</strong> files. Files are
          read in your browser; only the chapter text and pictures are saved to your private account. Only import files you have the right to use.
        </p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.epub,.txt,.md,.markdown,application/pdf,application/epub+zip,text/plain,text/markdown"
          disabled={!!busy || running}
          onChange={(e) => onFiles(e.target.files)}
          className="mt-4 block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-accent-foreground"
        />
        {busy && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted" aria-live="polite">
            <span>{busy}</span>
            <button type="button" onClick={() => abort.current?.abort()} className="text-xs text-accent hover:underline">
              Cancel
            </button>
          </div>
        )}
        {error && !draft && (
          <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </section>

      {scanned && (
        <section className="space-y-3 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-live="polite">
          <h2 className="font-semibold">This PDF looks scanned (no selectable text)</h2>
          <p className="text-sm text-muted">
            {scanned.info.picturePages} of {scanned.info.pageCount} pages are pictures with no text layer. <strong>OCR is not built into Recall</strong>, so the
            words can&apos;t be read or searched, and nothing is imported as text.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li><strong>Import pages as images</strong>: you can read them in order, but the assistant can&apos;t search them.</li>
            <li>Or run OCR first (for example OCRmyPDF, or your PDF tool&apos;s &ldquo;recognize text&rdquo;) and import that PDF for searchable text.</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <button onClick={importScannedAsImages} disabled={!!busy} className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground disabled:opacity-50">
              Import pages as images
            </button>
            <button onClick={reset} className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-accent-soft">
              Cancel
            </button>
          </div>
        </section>
      )}

      {draft && (
        <section className="space-y-6 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <div>
            <h2 className="font-semibold">2. Review before saving</h2>
            <p className="mt-1 text-sm text-muted">
              {draft.fileLabel} · {structure.chapters.length} chapters · {structure.chapters.reduce((n, c) => n + c.wordCount, 0).toLocaleString("en-US")} words ·{" "}
              {structure.chapters.reduce((n, c) => n + c.imageCount, 0)} illustrations
              {draft.pdfNote && ` · ${draft.pdfNote}`}
            </p>
            {draft.imageReport && draft.imageReport.found > 0 && (
              <p className="mt-1 text-xs" data-testid="image-report">
                Pictures: {draft.imageReport.found} found · <strong>{draft.imageReport.kept} will be imported</strong>
                {draft.imageReport.skipped.length > 0 &&
                  ` · skipped: ${draft.imageReport.skipped.map((x) => `${x.count} ${x.reason}`).join("; ")}`}
              </p>
            )}
            <p className="mt-1 text-xs text-muted">Nothing is saved until you press Import. You can cancel at any time.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Volume number *
              <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="decimal" placeholder="e.g. 4.5" className={inputCls} />
              <span className={`mt-1 block text-xs font-normal ${number && !numValid ? "text-danger" : "text-muted"}`}>
                {number && !numValid ? "Use a positive number with at most two decimals." : "Decimals are fine for side volumes (4.5, 7.5)."}
              </span>
            </label>
            <label className="block text-sm font-medium">
              Volume title
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className={inputCls} />
            </label>
            <label className="block text-sm font-medium">
              Arc / school year <span className="font-normal text-muted">(optional)</span>
              <input value={arc} onChange={(e) => setArc(e.target.value)} maxLength={120} placeholder="e.g. Year 1" className={inputCls} />
            </label>
            <label className="block text-sm font-medium">
              Arc order
              <input type="number" min={1} max={99} value={arcOrder} onChange={(e) => setArcOrder(e.target.value)} className={inputCls} />
              <span className="mt-1 block text-xs font-normal text-muted">1 = first arc. Arcs are read in this order, each with its own volume numbers.</span>
            </label>
            <label className="block text-sm font-medium">
              Language
              <input value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={20} placeholder="en, ru, ja…" className={inputCls} />
            </label>
          </div>

          {conflict && (
            <label className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="mt-1 size-4" />
              <span>
                <strong>Volume {num} already exists.</strong> Replace it? Its text, pictures and cover are removed and re-imported; your reading position and bookmarks stay
                on the same chapters.
              </span>
            </label>
          )}

          {(draft.images.size > 0 || draft.kind !== "text") && (
            <div className="space-y-2">
              <CoverPicker
                candidates={draft.coverCandidates}
                images={draft.images}
                choice={coverChoice}
                onChoice={setCoverChoice}
                custom={customCover}
                onCustom={setCustomCover}
                disabled={running}
              />
              {coverImage && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={setAsBookCover} onChange={(e) => setSetAsBookCover(e.target.checked)} className="size-4" />
                  Also pin this as the book&apos;s cover{hasManualCover ? " (replaces the cover you chose before)" : " (otherwise the latest imported volume’s cover is used automatically)"}
                </label>
              )}
            </div>
          )}

          {draft.warnings.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-accent-soft px-3 py-2 text-xs">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <ChapterEditor value={structure} onChange={setStructure} disabled={running} wholeFileTitle={title.trim() || draft.fileLabel.replace(/\.[^.]+$/, "")} />

          {running && (
            <div aria-live="polite">
              <div className="h-2 overflow-hidden rounded-full bg-border">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <p className="mt-2 truncate text-xs text-muted">{progress.label}</p>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {running ? (
              <button onClick={() => abort.current?.abort()} className="rounded-full border border-border px-6 py-3 text-sm font-medium hover:border-danger hover:text-danger">
                Cancel import
              </button>
            ) : (
              <>
                <button
                  onClick={runImport}
                  disabled={!numValid || chosenIdx.length === 0 || (!!conflict && !replace)}
                  className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Import {chosenIdx.length} chapters ({totals.words.toLocaleString("en-US")} words, {totals.images} illustrations)
                </button>
                <button onClick={reset} className="rounded-full border border-border px-5 py-3 text-sm hover:bg-accent-soft">
                  Cancel
                </button>
              </>
            )}
          </div>
          {!!conflict && !replace && !running && <p className="text-xs text-muted">Tick “Replace” above to re-import this volume.</p>}
        </section>
      )}
    </div>
  );
}
