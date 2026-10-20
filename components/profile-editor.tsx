"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { setLibrarySharing } from "@/app/actions/friends";
import { changePassword, changeUsername, claimUsername, removeAvatar, setAvatar, updateProfile } from "@/app/actions/profile";
import { AvatarError, makeAvatar } from "@/lib/avatar-image";
import { BIO_MAX, DISPLAY_NAME_MAX, USERNAME_MAX, type Profile } from "@/lib/profile";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { Avatar } from "./avatar";

const input = "mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent";
const primary = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50";
const ghost = "rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent-soft disabled:opacity-50";

type Note = { kind: "ok" | "error"; text: string } | null;
function Status({ note }: { note: Note }) {
  if (!note) return null;
  return note.kind === "error" ? (
    <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
      {note.text}
    </p>
  ) : (
    <p role="status" className="rounded-xl bg-accent-soft px-3 py-2 text-xs">
      {note.text}
    </p>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

/** Pick a picture; it is cropped to a small square here, uploaded to your own private folder, then saved. */
function AvatarCard({ profile, userId }: { profile: Profile; userId: string }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);

  function pick(f: File | undefined) {
    if (!f) return;
    setNote(null);
    start(async () => {
      try {
        const { blob, ext } = await makeAvatar(f);
        const path = `${userId}/avatar/${crypto.randomUUID()}.${ext}`;
        const supabase = createBrowserSupabase();
        if (!supabase) throw new AvatarError("Sign-in isn't configured.");
        const { error } = await supabase.storage.from("book-images").upload(path, blob, { contentType: blob.type, upsert: false });
        if (error) throw new AvatarError("Couldn't upload the picture. Please try again.");
        const res = await setAvatar(path);
        if (!res.ok) return setNote({ kind: "error", text: res.error });
        setNote({ kind: "ok", text: "Avatar updated." });
        router.refresh();
      } catch (e) {
        setNote({ kind: "error", text: e instanceof AvatarError ? e.message : "Couldn't update your avatar." });
      } finally {
        if (file.current) file.current.value = "";
      }
    });
  }

  return (
    <Card title="Profile picture" hint="A square picture works best. It is stored privately and only you see it.">
      <div className="flex items-center gap-4">
        <Avatar profile={profile} size="lg" />
        <div className="space-y-2">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" className="sr-only" id="avatar-file" onChange={(e) => pick(e.target.files?.[0])} />
          <label htmlFor="avatar-file" className={`${primary} inline-block cursor-pointer ${pending ? "opacity-50" : ""}`}>
            {pending ? "Uploading…" : profile.avatar_path ? "Change picture" : "Upload a picture"}
          </label>
          {profile.avatar_path && (
            <button
              type="button"
              disabled={pending}
              className={`${ghost} ml-2`}
              onClick={() =>
                start(async () => {
                  const res = await removeAvatar();
                  setNote(res.ok ? { kind: "ok", text: "Avatar removed." } : { kind: "error", text: res.error });
                  if (res.ok) router.refresh();
                })
              }
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <Status note={note} />
    </Card>
  );
}

function DetailsCard({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [name, setName] = useState(profile.display_name ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Card title="About you">
      <label className="block text-sm font-medium">
        Display name
        <input value={name} maxLength={DISPLAY_NAME_MAX} onChange={(e) => setName(e.target.value)} className={input} placeholder={profile.username} autoComplete="name" />
      </label>
      <label className="block text-sm font-medium">
        Bio
        <textarea value={bio} maxLength={BIO_MAX} rows={3} onChange={(e) => setBio(e.target.value)} className={`${input} resize-y`} placeholder="What do you like to read?" />
        <span className="text-xs font-normal text-muted">{bio.length}/{BIO_MAX}</span>
      </label>
      <button
        type="button"
        disabled={pending}
        className={primary}
        onClick={() =>
          start(async () => {
            const res = await updateProfile({ displayName: name, bio });
            setNote(res.ok ? { kind: "ok", text: "Saved." } : { kind: "error", text: res.error });
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Saving…" : "Save"}
      </button>
      <Status note={note} />
    </Card>
  );
}

function UsernameCard({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [value, setValue] = useState(profile.username);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Card title="Username" hint="You can sign in with your username or your email. Letters, numbers and underscores, 3–20 characters.">
      <label className="block text-sm font-medium">
        Username
        <input value={value} maxLength={USERNAME_MAX} onChange={(e) => setValue(e.target.value)} className={input} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" />
      </label>
      <button
        type="button"
        disabled={pending || value.trim().toLowerCase() === profile.username}
        className={primary}
        onClick={() =>
          start(async () => {
            const res = await changeUsername(value);
            setNote(res.ok ? { kind: "ok", text: `You are now @${res.data.username}.` } : { kind: "error", text: res.error });
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Saving…" : "Change username"}
      </button>
      <Status note={note} />
    </Card>
  );
}

/** Who can see your library. Your profile (name, bio, picture) is always visible to friends; the library is optional. */
function PrivacyCard({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [share, setShare] = useState(profile.share_library);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Card title="Privacy" hint="Friends always see your profile. They never see what you read: only titles, covers and how far you are.">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={share}
          disabled={pending}
          className="mt-0.5 size-4 accent-[var(--accent)]"
          onChange={(e) => {
            const next = e.target.checked;
            setShare(next);
            setNote(null);
            start(async () => {
              const res = await setLibrarySharing(next);
              if (!res.ok) {
                setShare(!next);
                return setNote({ kind: "error", text: res.error });
              }
              setNote({ kind: "ok", text: next ? "Friends can see your library." : "Your library is hidden from friends." });
              router.refresh();
            });
          }}
        />
        <span>
          <span className="font-medium">Show my library to friends</span>
          <span className="block text-xs text-muted">Titles, covers and reading progress as counts.</span>
        </span>
      </label>
      <Status note={note} />
    </Card>
  );
}

function PasswordCard() {
  const [value, setValue] = useState("");
  const [again, setAgain] = useState("");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Card title="Password">
      <label className="block text-sm font-medium">
        New password
        <input type="password" value={value} minLength={8} onChange={(e) => setValue(e.target.value)} className={input} autoComplete="new-password" />
      </label>
      <label className="block text-sm font-medium">
        Repeat it
        <input type="password" value={again} minLength={8} onChange={(e) => setAgain(e.target.value)} className={input} autoComplete="new-password" />
      </label>
      <button
        type="button"
        disabled={pending || value.length < 8}
        className={primary}
        onClick={() => {
          if (value !== again) return setNote({ kind: "error", text: "The two passwords don't match." });
          start(async () => {
            const res = await changePassword(value);
            setNote(res.ok ? { kind: "ok", text: "Password changed." } : { kind: "error", text: res.error });
            if (res.ok) {
              setValue("");
              setAgain("");
            }
          });
        }}
      >
        {pending ? "Saving…" : "Change password"}
      </button>
      <Status note={note} />
    </Card>
  );
}

/** Everything you can change about your account. */
export function ProfileEditor({ profile, userId }: { profile: Profile; userId: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="profile-editor">
      <AvatarCard profile={profile} userId={userId} />
      <DetailsCard profile={profile} />
      <UsernameCard profile={profile} />
      <PrivacyCard profile={profile} />
      <PasswordCard />
    </div>
  );
}

/** For accounts created before usernames existed: pick one to finish your profile. */
export function ClaimUsername() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <section className="rounded-2xl border border-accent bg-accent-soft p-5" data-testid="claim-username">
      <h2 className="font-semibold">Choose your username</h2>
      <p className="mt-1 text-sm text-muted">Pick a username to finish your profile. You will be able to sign in with it or with your email.</p>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <input
          value={value}
          maxLength={USERNAME_MAX}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Username"
          placeholder="username"
          className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={pending || value.trim().length < 3}
          className={primary}
          onClick={() =>
            start(async () => {
              const res = await claimUsername(value);
              if (!res.ok) return setNote({ kind: "error", text: res.error });
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : "Save username"}
        </button>
      </div>
      <div className="mt-2">
        <Status note={note} />
      </div>
    </section>
  );
}
