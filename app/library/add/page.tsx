import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AddNovelForm } from "@/components/add-novel-form";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Add a novel" };

export default function AddNovelPage() {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/library" className="text-sm text-muted hover:text-foreground">
        ← Back to library
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Add a novel</h1>
      <Suspense fallback={<div className="skeleton mt-8 h-64" aria-busy="true" />}>
        <Guarded />
      </Suspense>
    </div>
  );
}

async function Guarded() {
  await requireUser();
  return (
    <div className="mt-8">
      <AddNovelForm />
    </div>
  );
}
