import type { Book } from "@/lib/types";

export function BookCover({
  book,
  className = "",
}: {
  book: Pick<Book, "title" | "author" | "cover">;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={`Cover of ${book.title}`}
      className={`relative flex aspect-[2/3] flex-col justify-between overflow-hidden rounded-xl p-4 text-white shadow-lg ${className}`}
      style={{ backgroundImage: `linear-gradient(155deg, ${book.cover[0]}, ${book.cover[1]})` }}
    >
      <div className="absolute inset-y-0 left-0 w-2 bg-black/20" aria-hidden />
      <div className="absolute -right-8 -top-8 size-32 rounded-full bg-white/15 blur-2xl" aria-hidden />
      <span className="pl-2 text-[0.65rem] font-medium uppercase tracking-[0.2em] text-white/70">
        Light Novel
      </span>
      <div className="pl-2">
        <p className="text-balance text-lg font-bold leading-tight drop-shadow sm:text-xl">
          {book.title}
        </p>
        <p className="mt-2 text-xs text-white/80">{book.author}</p>
      </div>
    </div>
  );
}
