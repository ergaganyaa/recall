import { describe, expect, it } from "vitest";
import { parseNovelUrl, titleHintFromUrl } from "@/lib/import/ranobelib";

describe("parseNovelUrl (SSRF guard)", () => {
  it.each([
    "http://ranobelib.me/ru/book/1", // not https
    "https://evil.com/ru/book/1",
    "https://ranobelib.me.evil.com/x", // look-alike host
    "https://evilranobelib.me/x",
    "https://user:pw@ranobelib.me/x", // credentials
    "https://ranobelib.me:8443/x", // custom port
    "https://127.0.0.1/",
    "https://localhost/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
    "",
  ])("rejects %s", (bad) => expect(parseNovelUrl(bad)).toBeNull());

  it("accepts ranobelib.me with or without www, ignoring surrounding spaces", () => {
    expect(parseNovelUrl("https://ranobelib.me/ru/book/123--my-novel")).not.toBeNull();
    expect(parseNovelUrl("  https://www.ranobelib.me/ru/book/123--my-novel  ")).not.toBeNull();
    expect(parseNovelUrl("https://RANOBELIB.ME/ru/book/1--x")).not.toBeNull();
  });
});

describe("titleHintFromUrl", () => {
  const hint = (u: string) => titleHintFromUrl(new URL(u));
  it("builds a readable title from the slug", () => {
    expect(hint("https://ranobelib.me/ru/book/123--my-cool-novel?ui=1")).toBe("My Cool Novel");
    expect(hint("https://ranobelib.me/ru/book/my_novel")).toBe("My Novel");
  });
  it("returns null when there is no book slug", () => {
    expect(hint("https://ranobelib.me/ru/catalog")).toBeNull();
  });
});
