import Link from "next/link";
import { contentKind } from "@/lib/chapter-content";
import type { ChapterSummary, Volume } from "@/lib/types";

type Stat = {
  volume: Volume;
  chapters: ChapterSummary[];
  full: number;
  ill: number;
  none: number;
  read: number;
  isCurrent: boolean;
};

function statusOf(s: Stat): { label: string; tone: string } {
  if (s.chapters.length === 0 || s.none === s.chapters.length) return { label: "Not imported", tone: "border-dashed text-muted" };
  if (s.none > 0 || s.ill > 0 && s.full === 0) {
    return s.full === 0 ? { label: "Illustrations only", tone: "text-muted" } : { label: `Partial · ${s.full + s.ill}/${s.chapters.length}`, tone: "text-accent" };
  }
  return { label: "Full text", tone: "text-accent" };
}

/**
 * Volumes in reading order, grouped by arc (school year). Decimal volumes such as
 * 4.5 sort between their neighbours. Only volumes that exist in the library are
 * listed, so the layout stays tidy when just some volumes have been imported.
 */
export function VolumeBrowser({
  basePath,
  volumes,
  chapters,
  lastRead,
  current,
}: {
  basePath: string;
  volumes: Volume[];
  chapters: ChapterSummary[];
  lastRead: number;
  current: number;
}) {
  const stats: Stat[] = volumes.map((volume) => {
    const own = chapters.filter((c) => c.volume_id === volume.id);
    const kinds = own.map(contentKind);
    return {
      volume,
      chapters: own,
      full: kinds.filter((k) => k === "full_text").length,
      ill: kinds.filter((k) => k === "illustrations_only").length,
      none: kinds.filter((k) => k === "metadata_only").length,
      read: own.filter((c) => c.number <= lastRead).length,
      isCurrent: own.some((c) => c.number === current),
    };
  });

  const arcs: { key: number; name: string; items: Stat[] }[] = [];
  for (const s of stats) {
    let arc = arcs.find((a) => a.key === s.volume.arc_order);
    if (!arc) {
      arc = { key: s.volume.arc_order, name: s.volume.arc ?? (stats.some((x) => x.volume.arc) ? "Other volumes" : "Volumes"), items: [] };
      arcs.push(arc);
    }
    arc.items.push(s);
  }

  const importHref = `${basePath}/import`;

  if (stats.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center">
        <h3 className="font-semibold">No volumes imported yet</h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Import a volume from an EPUB, TXT or Markdown file you own. Each one is placed in reading order, so you can start
          with any volume.
        </p>
        <Link href={importHref} className="mt-5 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90">
          Import your first volume
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {arcs.map((arc) => (
        <section key={arc.key} aria-label={arc.name}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-accent">{arc.name}</h3>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {arc.items.map((s) => {
              const first = s.chapters[0];
              const st = statusOf(s);
              const pct = s.chapters.length ? Math.floor((s.read / s.chapters.length) * 100) : 0;
              return (
                <li key={s.volume.id}>
                  <Link
                    href={first ? `${basePath}/read/${first.number}` : importHref}
                    className={`flex h-full flex-col rounded-2xl border bg-surface p-4 transition hover:-translate-y-0.5 hover:shadow-md ${
                      s.isCurrent ? "border-accent ring-1 ring-accent" : "border-border"
                    }`}
                  >
                    <span className="flex items-center justify-between">
                      <span className="text-2xl font-bold tracking-tight">{Number.isInteger(s.volume.number) ? s.volume.number : s.volume.number.toFixed(1).replace(/\.0$/, "")}</span>
                      {s.isCurrent && (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-medium text-accent-foreground">Reading</span>
                      )}
                    </span>
                    <span className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-snug">
                      {s.volume.title ?? `Volume ${s.volume.number}`}
                    </span>
                    <span className="mt-3 h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`Volume ${s.volume.number} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                      <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="mt-2 flex items-center justify-between text-xs">
                      <span className={`rounded-full border px-2 py-0.5 ${st.tone}`}>{st.label}</span>
                      <span className="text-muted">{s.read}/{s.chapters.length}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
            {arc === arcs[arcs.length - 1] && (
              <li>
                <Link
                  href={importHref}
                  className="grid h-full min-h-[9rem] place-items-center rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted transition hover:border-accent hover:text-accent"
                >
                  <span>
                    <span className="block text-2xl leading-none">+</span>
                    Add a volume
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
