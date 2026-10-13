"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, signUp, type AuthState } from "@/app/actions/auth";

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    mode === "login" ? signIn : signUp,
    {},
  );
  const isLogin = mode === "login";

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <h1 className="text-2xl font-bold tracking-tight">{isLogin ? "Welcome back" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-muted">
        {isLogin ? "Sign in to pick up where you left off." : "Start a library that remembers for you."}
      </p>

      <form action={action} className="mt-6 space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        <label className="block text-sm font-medium">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-xl border border-border bg-surface px-4 py-2.5 outline-none focus:border-accent"
          />
        </label>
        <label className="block text-sm font-medium">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={isLogin ? "current-password" : "new-password"}
            className="mt-1 w-full rounded-xl border border-border bg-surface px-4 py-2.5 outline-none focus:border-accent"
          />
        </label>

        {state.error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="rounded-xl bg-accent-soft px-3 py-2 text-sm">
            {state.message}
          </p>
        )}

        <button
          disabled={pending}
          className="w-full rounded-full bg-accent py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Please wait…" : isLogin ? "Sign in" : "Sign up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        {isLogin ? "New to Recall? " : "Already have an account? "}
        <Link href={isLogin ? "/signup" : "/login"} className="font-medium text-accent hover:underline">
          {isLogin ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}
