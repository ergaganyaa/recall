import "server-only";
import { requireUser } from "./auth";
import { getBook, getBookStructure, getChapter, getChat, resolveBookId } from "./queries";
import { schemaIsCurrent } from "./schema";
import { timed } from "./timing";

/**
 * Everything the reader page needs, fetched in ONE parallel round (it used to be book, then chapter, then
 * illustrations, each waiting for the previous one). Every query is scoped to the signed-in user by row level
 * security, so asking for a book or chapter that is not theirs simply finds nothing.
 */
export async function loadReaderData(bookParam: string, number: number) {
  await timed("reader: auth", () => requireUser());
  const bookId = await resolveBookId(bookParam); // a full id costs nothing; a readable address is looked up once
  if (!bookId) return { kind: "missing" as const };
  if (!(await timed("reader: schema check", () => schemaIsCurrent()))) return { kind: "migrate" as const };

  const [book, chapter, structure, messages] = await timed("reader: data (parallel)", () =>
    Promise.all([
      getBook(bookId),
      getChapter(bookId, number),
      getBookStructure(bookId, { bookmarks: false }),
      getChat(bookId),
    ]),
  );
  if (!book || !chapter) return { kind: "missing" as const };
  return { kind: "ok" as const, book, chapter, structure, messages };
}
