import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(import.meta.dirname, "../app/globals.css"), "utf8");

/** Body of the first rule whose selector line matches. */
function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`No CSS rule starting with ${selectorStart}`);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  const vars: Record<string, string> = {};
  // Custom properties are keyed without the leading "--" (e.g. "surface"); plain ones keep their name ("color-scheme").
  for (const m of css.slice(open + 1, close).matchAll(/(--)?([\w-]+)\s*:\s*([^;]+);/g)) vars[m[2]] = m[3].trim();
  return vars;
}

const light = block(":root {");
const darkExplicit = block(':root[data-theme="dark"]');
const darkSystem = block(':root:not([data-theme="light"])');

const lum = (hex: string) => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// Every foreground/background pair the reader's menus, picker and chapter list actually use.
const PAIRS: [string, string, string][] = [
  ["foreground", "surface", "picker rows and panel text"],
  ["foreground", "background", "page text"],
  ["muted", "surface", "chapter numbers, hints, empty message"],
  ["muted", "background", "secondary text"],
  ["accent", "accent-soft", "the selected chapter / hovered row"],
  ["foreground", "accent-soft", "hovered row text"],
  ["accent", "surface", "links and focus"],
  ["accent-foreground", "accent", "primary buttons"],
  ["danger", "surface", "error text"],
];

describe("theme tokens: readable in light AND dark", () => {
  for (const [name, tokens] of [["light", light], ["dark (explicit toggle)", darkExplicit], ["dark (system preference)", darkSystem]] as const) {
    describe(name, () => {
      it.each(PAIRS)("%s on %s is readable (%s)", (fg, bg) => {
        expect(contrast(tokens[fg], tokens[bg]), `${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}`).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("the dark surface really is dark and the light surface really is light", () => {
    expect(lum(light.surface)).toBeGreaterThan(0.8);
    expect(lum(darkExplicit.surface)).toBeLessThan(0.05);
  });

  it("the system-dark and explicit-dark themes use identical colours (no drift between the two paths)", () => {
    for (const key of ["background", "foreground", "surface", "muted", "border", "accent", "accent-soft", "accent-foreground", "danger"]) {
      expect(darkSystem[key], key).toBe(darkExplicit[key]);
    }
  });

  it("declares a colour-scheme so native controls (scrollbars, date pickers…) follow the theme", () => {
    expect(light["color-scheme"]).toBe("light");
    expect(darkExplicit["color-scheme"]).toBe("dark");
  });

  it("themes native <select>/<option> pop-ups, which the browser would otherwise paint white", () => {
    expect(css).toMatch(/select,\s*option,\s*optgroup\s*\{[^}]*background-color:\s*var\(--surface\)[^}]*color:\s*var\(--foreground\)/);
  });
});
