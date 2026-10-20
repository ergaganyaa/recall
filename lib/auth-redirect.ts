/** The same message for a wrong password, an unknown username and an unknown email, so it reveals nothing. */
export const BAD_LOGIN = "Incorrect username, email or password.";

/** Only allow same-site relative redirects after login. */
export function safeNext(value: FormDataEntryValue | null): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/profile";
}
