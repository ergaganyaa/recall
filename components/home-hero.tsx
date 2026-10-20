import Link from "next/link";
import { setupFeaturedSeries } from "@/app/actions/import";
import { MigrationNotice } from "@/components/migration-notice";
import { schemaIsCurrent } from "@/lib/schema";
import { FeaturedHero } from "@/components/featured-hero";
import { getUser } from "@/lib/auth";
import { FEATURED_SERIES } from "@/lib/featured";
import { getBookStructure, getFeaturedBook } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";

async function setup() {
  "use server";
  await setupFeaturedSeries();
}

/** Signed-in with a featured book → that book. Otherwise the generic landing hero. */
export async function HomeHero() {
  const user = isSupabaseConfigured ? await getUser() : null;
  if (user && !(await schemaIsCurrent())) return <MigrationNotice />;
  const featured = user ? await getFeaturedBook() : null;

  if (user && featured) {
    const { volumes, chapters, progress } = await getBookStructure(featured.id);
    return <FeaturedHero book={featured} volumes={volumes} chapters={chapters} progress={progress} />;
  }
  return <LandingHero signedIn={Boolean(user)} />;
}

export function LandingHero({ signedIn }: { signedIn: boolean }) {
  return (
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
        <p className="inline-block rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">For light novels & long series</p>
        <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight sm:text-6xl">
          Come back after months. Remember everything. Spoil nothing.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted">
          Recall tracks your place in long stories and answers questions about what you&apos;ve already read — never a chapter further.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {signedIn ? (
            <>
              <form action={setup}>
                <button className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90">
                  Feature {FEATURED_SERIES.title}
                </button>
              </form>
              <Link href="/profile#library" className="rounded-full border border-border px-6 py-3 text-sm font-medium transition hover:bg-accent-soft">
                Open my library
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup" className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90">
                Get started
              </Link>
              <Link href="/profile#library" className="rounded-full border border-border px-6 py-3 text-sm font-medium transition hover:bg-accent-soft">
                Open my library
              </Link>
            </>
          )}
        </div>
        {signedIn && (
          <p className="mx-auto mt-4 max-w-md text-xs text-muted">
            This creates the series entry only. Chapter text and illustrations come from files you import.
          </p>
        )}
      </div>
    </section>
  );
}
