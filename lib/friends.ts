import "server-only";
import { cache } from "react";
import { z } from "zod";
import { getUser } from "./auth";
import { chooseCover, type CoverVolume } from "./cover";
import { createClient } from "./supabase/server";

/**
 * Reading what friends are allowed to share. Every function here calls a database function that answers ONLY for
 * a confirmed friend of the signed-in user (and only with the thin fields listed below); for anyone else the result
 * is null, the same as for a name that does not exist.
 */
const person = z.object({
  friendship_id: z.string(),
  username: z.string(),
  display_name: z.string().nullable(),
});

const overviewShape = z.object({
  friends: z.array(person.extend({ avatar_path: z.string().nullable(), since: z.string().nullable() })),
  incoming: z.array(person.extend({ created_at: z.string() })),
  outgoing: z.array(person.extend({ created_at: z.string() })),
});
export type FriendsOverview = z.infer<typeof overviewShape>;
const EMPTY: FriendsOverview = { friends: [], incoming: [], outgoing: [] };

/** Friends, requests to you and requests from you. Once per request. */
export const getFriendsOverview = cache(async (): Promise<FriendsOverview> => {
  if (!(await getUser())) return EMPTY;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("friends_overview");
  if (error) return EMPTY; // e.g. the friends migration has not been run yet
  const parsed = overviewShape.safeParse(data);
  return parsed.success ? parsed.data : EMPTY;
});

const friendProfileShape = z.object({
  username: z.string(),
  display_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_path: z.string().nullable(),
  created_at: z.string(),
  share_library: z.boolean(),
  friendship_id: z.string().nullable(),
});
export type FriendProfile = z.infer<typeof friendProfileShape>;

export async function getFriendProfile(username: string): Promise<FriendProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("friend_profile", { p_username: username });
  if (error || !data) return null;
  const parsed = friendProfileShape.safeParse(data);
  return parsed.success ? parsed.data : null;
}

const volumeShape = z.object({
  id: z.string(),
  number: z.number(),
  arc_order: z.number(),
  imported_at: z.string().nullable(),
  cover_image_id: z.string().nullable(),
});
const bookShape = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  status: z.string(),
  cover_image_id: z.string().nullable(),
  cover_url: z.string().nullable(),
  volumes: z.array(volumeShape),
  current_chapter: z.number().nullable(),
  finished: z.number(),
  total: z.number(),
  reading_volume_id: z.string().nullable(),
  shareable: z.boolean(),
  my_slug: z.string().nullable(),
});
const libraryShape = z.object({ shared: z.boolean(), books: z.array(bookShape) });

export type FriendBook = {
  id: string;
  title: string;
  author: string | null;
  status: string;
  /** a cover image (served by /friends/<username>/cover/<id>) or a linked address */
  coverImageId: string | null;
  coverUrl: string | null;
  finished: number;
  total: number;
  /** the owner allows friends to add a copy */
  shareable: boolean;
  /** the slug of YOUR copy, if you already added this novel */
  mySlug: string | null;
};

/** null = not a friend; shared:false = they turned sharing off. Covers follow THEIR reading position. */
export async function getFriendLibrary(username: string): Promise<{ shared: boolean; books: FriendBook[] } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("friend_library", { p_username: username });
  if (error || !data) return null;
  const parsed = libraryShape.safeParse(data);
  if (!parsed.success) return null;
  return {
    shared: parsed.data.shared,
    books: parsed.data.books.map((b) => {
      const volumes: CoverVolume[] = b.volumes;
      const place = { chapters: b.current_chapter !== null ? [{ number: b.current_chapter, volume_id: b.reading_volume_id }] : [], currentChapter: b.current_chapter };
      const cover = chooseCover({ id: b.id, cover_image_id: b.cover_image_id, cover_url: b.cover_url }, volumes, place);
      return { id: b.id, title: b.title, author: b.author, status: b.status, coverImageId: cover.imageId, coverUrl: cover.url, finished: b.finished, total: b.total, shareable: b.shareable, mySlug: b.my_slug };
    }),
  };
}
