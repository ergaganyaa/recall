import Link from "next/link";

const features = [
  {
    title: "Spoiler-proof by design",
    body: "Ask about characters, plot and lore. Search only ever sees chapters you've finished — the limit is enforced in the database, not the UI.",
  },
  {
    title: "Resume exactly where you stopped",
    body: "Recall remembers your chapter and scroll position, plus bookmarks, across devices.",
  },
  {
    title: "Built for huge series",
    body: "Volumes, hundreds of chapters, and passage-level search instead of re-reading everything after a long break.",
  },
];

const steps = [
  ["Add a novel", "Paste a Ranobelib link for its details, or enter it yourself."],
  ["Read & track", "Add chapter text, read in a clean reader, and let progress track itself."],
  ["Ask without spoilers", "Come back months later and ask what you've forgotten."],
];

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div
          className="absolute inset-0 -z-10 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(60rem 28rem at 80% -10%, var(--accent-soft), transparent), radial-gradient(40rem 20rem at 0% 0%, var(--accent-soft), transparent)",
          }}
          aria-hidden
        />
        <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <p className="inline-block rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
            For light novels & long series
          </p>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight sm:text-6xl">
            Come back after months. Remember everything. Spoil nothing.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted">
            Recall tracks your place in long stories and answers questions about what you&apos;ve
            already read — never a chapter further.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/library"
              className="rounded-full border border-border px-6 py-3 text-sm font-medium transition hover:bg-accent-soft"
            >
              Open my library
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-border bg-surface p-6">
              <h2 className="font-semibold">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-4 rounded-2xl border border-border p-5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
