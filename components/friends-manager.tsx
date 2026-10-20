"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeFriend, respondToRequest, sendFriendRequest } from "@/app/actions/friends";
import type { FriendsOverview } from "@/lib/friends";
import { USERNAME_MAX } from "@/lib/profile";
import { Avatar } from "./avatar";

const primary = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50";
const ghost = "rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent-soft disabled:opacity-50";

type Note = { kind: "ok" | "error"; text: string } | null;

function Section({ title, count, children, testId }: { title: string; count?: number; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5" data-testid={testId}>
      <h2 className="font-semibold">
        {title}
        {count !== undefined && <span className="ml-2 text-sm font-normal text-muted">{count}</span>}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Ask someone by username. They have to accept before anything is shared. */
function AddFriend() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Section title="Add a friend" testId="add-friend">
      <p className="mb-3 text-xs text-muted">Enter their username. When they accept, you can see each other&apos;s profile and library (titles, covers and progress; never the text you read).</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          setNote(null);
          start(async () => {
            const res = await sendFriendRequest(value);
            if (!res.ok) return setNote({ kind: "error", text: res.error });
            setNote({ kind: "ok", text: res.data.message });
            setValue("");
            router.refresh();
          });
        }}
      >
        <label htmlFor="friend-username" className="sr-only">
          Friend&apos;s username
        </label>
        <input
          id="friend-username"
          value={value}
          maxLength={USERNAME_MAX + 1}
          onChange={(e) => setValue(e.target.value.replace(/^@/, ""))}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button className={primary} disabled={pending || value.trim().length < 3}>
          {pending ? "Sending…" : "Send request"}
        </button>
      </form>
      {note && (
        <p role={note.kind === "error" ? "alert" : "status"} className={`mt-3 rounded-xl px-3 py-2 text-xs ${note.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent-soft"}`}>
          {note.text}
        </p>
      )}
    </Section>
  );
}

function Name({ username, displayName }: { username: string; displayName: string | null }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium">{displayName || `@${username}`}</span>
      {displayName && <span className="block truncate text-xs text-muted">@{username}</span>}
    </span>
  );
}

/** Buttons that change a friendship and then refresh the list. Errors stay visible. */
function useChange() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  return { pending, error, run };
}

function IncomingRow({ r }: { r: FriendsOverview["incoming"][number] }) {
  const { pending, error, run } = useChange();
  return (
    <li className="py-3" data-testid="incoming-request">
      <div className="flex items-center gap-3">
        <Avatar profile={{ username: r.username, display_name: r.display_name }} size="sm" />
        <Name username={r.username} displayName={r.display_name} />
        <span className="ml-auto flex shrink-0 gap-2">
          <button type="button" disabled={pending} className={primary} onClick={() => run(() => respondToRequest(r.friendship_id, true))}>
            Accept
          </button>
          <button type="button" disabled={pending} className={ghost} onClick={() => run(() => respondToRequest(r.friendship_id, false))}>
            Decline
          </button>
        </span>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

function OutgoingRow({ r }: { r: FriendsOverview["outgoing"][number] }) {
  const { pending, error, run } = useChange();
  return (
    <li className="py-3" data-testid="outgoing-request">
      <div className="flex items-center gap-3">
        <Avatar profile={{ username: r.username, display_name: r.display_name }} size="sm" />
        <Name username={r.username} displayName={r.display_name} />
        <span className="ml-2 text-xs text-muted">waiting for an answer</span>
        <button type="button" disabled={pending} className={`${ghost} ml-auto shrink-0`} onClick={() => run(() => removeFriend(r.friendship_id))}>
          Cancel
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

function FriendRow({ f }: { f: FriendsOverview["friends"][number] }) {
  const { pending, error, run } = useChange();
  return (
    <li className="py-3" data-testid="friend-row">
      <div className="flex items-center gap-3">
        <Link href={`/friends/${encodeURIComponent(f.username)}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl hover:text-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent">
          <Avatar profile={{ username: f.username, display_name: f.display_name, avatar_path: f.avatar_path }} owner={f.username} size="sm" />
          <Name username={f.username} displayName={f.display_name} />
        </Link>
        <button
          type="button"
          disabled={pending}
          className="shrink-0 text-xs text-muted hover:text-danger disabled:opacity-50"
          onClick={() => {
            if (window.confirm(`Remove @${f.username} from your friends? You will stop seeing each other's profile and library.`)) run(() => removeFriend(f.friendship_id));
          }}
        >
          Remove
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

/** Everything on the Friends page. The data comes from the server; each button asks the server and then refreshes. */
export function FriendsManager({ overview }: { overview: FriendsOverview }) {
  return (
    <div className="space-y-4" data-testid="friends-manager">
      <AddFriend />

      {overview.incoming.length > 0 && (
        <Section title="Requests for you" count={overview.incoming.length} testId="incoming">
          <ul className="divide-y divide-border">{overview.incoming.map((r) => <IncomingRow key={r.friendship_id} r={r} />)}</ul>
        </Section>
      )}

      <Section title="Your friends" count={overview.friends.length} testId="friends">
        {overview.friends.length === 0 ? (
          <p className="text-sm text-muted">No friends yet. Send a request with a username above.</p>
        ) : (
          <ul className="divide-y divide-border">{overview.friends.map((f) => <FriendRow key={f.friendship_id} f={f} />)}</ul>
        )}
      </Section>

      {overview.outgoing.length > 0 && (
        <Section title="Requests you sent" count={overview.outgoing.length} testId="outgoing">
          <ul className="divide-y divide-border">{overview.outgoing.map((r) => <OutgoingRow key={r.friendship_id} r={r} />)}</ul>
        </Section>
      )}
    </div>
  );
}

/** "Remove friend" on a friend's own page. */
export function RemoveFriendButton({ friendshipId, username }: { friendshipId: string; username: string }) {
  const router = useRouter();
  const { pending, error, run } = useChange();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={ghost}
        onClick={() => {
          if (!window.confirm(`Remove @${username} from your friends? You will stop seeing each other's profile and library.`)) return;
          run(async () => {
            const res = await removeFriend(friendshipId);
            if (res.ok) router.push("/friends");
            return res;
          });
        }}
      >
        {pending ? "Removing…" : "Remove friend"}
      </button>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
