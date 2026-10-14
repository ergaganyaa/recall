# Playwright probe: findings (2026-10-14)

Standalone investigation, **not used by the Recall app**. One run against the catalog page
(`/ru/book/6709--…?section=chapters`), stock headless Chromium, no UA/fingerprint changes, no stealth,
no proxies. The script checks `robots.txt` first and stops on any block. It never opened a chapter page.

| Question | Result |
|---|---|
| `robots.txt` allows the catalog page? | Yes (no matching rule for `*`). |
| Blocked / challenged? | No: HTTP 200, no challenge page. |
| Where does the data come from? | The page's own JavaScript calls the site's API (`api.cdnlibs.org`, undocumented) and renders the list in the browser. A plain HTTP fetch of the same page returns only an empty app shell. |
| What the DOM exposed | Title, original title, 20 chapter links (the list is virtualised: the page showed "0 / 397"), no separate volume headers; volume and chapter numbers are embedded in each row's text (e.g. "Том N Глава M.5 - …"), so decimal chapters exist. |
| Chapter links | `/ru/<id>--<slug>/read/vNN/cX`. This path is **not** matched by the `/ru/book/*/chapter` rule as written, but that is a gap in the rule, not permission. |

## Decision
- Catalog metadata is readable in a real browser, once. That is **not** evidence of reliability (one run, a
  virtualised list that needs scrolling, DOM and private API that can change, terms of service unread).
- Chapter pages are **out of scope**: the text is a copyrighted translation, `robots.txt` shows the site's
  intent for chapter content, and no authorisation from the rights holders exists. Recall does not automate it.
- Recommended source of chapter text and illustrations: EPUB/TXT/Markdown files you own (see the README).

Re-run: `npm install && npx playwright install chromium && node probe.mjs "<catalog-url>"` (writes `out/report.json`, git-ignored).
