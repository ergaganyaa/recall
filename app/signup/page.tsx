import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { SetupNotice } from "@/components/setup-notice";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return <AuthForm mode="signup" />;
}
