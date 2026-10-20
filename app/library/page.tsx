import { redirect } from "next/navigation";

// The library now lives on your profile.
export default function LibraryPage() {
  redirect("/profile#library");
}
