export function LibrarySkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14" aria-busy="true" aria-label="Loading your library">
      <div className="skeleton h-9 w-56" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton aspect-[2/3]" />
        ))}
      </div>
    </div>
  );
}

export function BookSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6" aria-busy="true" aria-label="Loading book">
      <div className="grid gap-8 md:grid-cols-[14rem_1fr]">
        <div className="skeleton mx-auto aspect-[2/3] w-44 md:w-full" />
        <div className="space-y-4">
          <div className="skeleton h-10 w-3/4" />
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-24 w-full max-w-xl" />
        </div>
      </div>
    </div>
  );
}

export function ReaderSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-16" aria-busy="true" aria-label="Loading chapter">
      <div className="skeleton h-8 w-2/3" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="skeleton h-4 w-full" />
      ))}
    </div>
  );
}
