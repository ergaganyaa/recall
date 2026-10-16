/**
 * Readable book addresses: /library/classroom-of-the-elite. The slug is stored on the book (books.slug, set by the
 * database when the book is created, unique per user, permanent). Full ids from older links still work: the app
 * redirects them to the slug (see resolveBookId in lib/queries.ts).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "/library/classroom-of-the-elite" */
export const bookPath = (book: { slug: string }) => `/library/${encodeURIComponent(book.slug)}`;

export type BookRef = { kind: "id"; id: string } | { kind: "slug"; slug: string };

/** What a /library/[bookId] address refers to: a full id (old links) or a slug. */
export function parseBookParam(param: string): BookRef | null {
  if (UUID.test(param)) return { kind: "id", id: param.toLowerCase() };
  let slug = param;
  try {
    slug = decodeURIComponent(param);
  } catch {
    return null;
  }
  return slug && slug.length <= 80 && !/[/?#\s]/.test(slug) ? { kind: "slug", slug } : null;
}

/** The query string to keep when redirecting an old address to the slug address. */
export const canonicalSuffix = (searchParams: Record<string, string | string[] | undefined>) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, one);
  const s = qs.toString();
  return s ? `?${s}` : "";
};

/** True when the address already is the book's own slug (browsers may hand it over percent-encoded). */
export const isCanonicalParam = (param: string, slug: string) => {
  try {
    return decodeURIComponent(param) === slug;
  } catch {
    return false;
  }
};
