import { strToU8, zipSync } from "fflate";

/** A PNG signature + IHDR with the given size (enough for sniffing; not a decodable picture). */
export function fakePng(width: number, height: number, tag = 0): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set(strToU8("IHDR"), 12);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[39] = tag; // distinguish images from each other
  return b;
}

/** A JPEG with a single SOF0 segment carrying the size. */
export function fakeJpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], 0); // SOI + APP0(len 4)
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8); // SOF0, length, precision
  new DataView(b.buffer).setUint16(13, height);
  new DataView(b.buffer).setUint16(15, width);
  return b;
}

const xhtml = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;

export type FixtureOptions = {
  /** "nav" = EPUB 3 nav document, "ncx" = EPUB 2 NCX */
  toc?: "nav" | "ncx" | "none";
  seriesIndex?: string;
};

/** A small original EPUB: cover, colour plates, three chapters (one image-only), anchors, ruby. */
export function buildEpub({ toc = "nav", seriesIndex = "4.5" }: FixtureOptions = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "OEBPS/images/cover.png": fakePng(800, 1200, 1),
    "OEBPS/images/plate1.png": fakePng(1200, 800, 2),
    "OEBPS/images/plate2.jpg": fakeJpeg(900, 1300),
    "OEBPS/images/inline.png": fakePng(400, 300, 3),
    "OEBPS/images/page.png": fakePng(1000, 1500, 4),
    "OEBPS/text/cover.xhtml": strToU8(
      xhtml("Cover", `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 1200"><image width="800" height="1200" xlink:href="../images/cover.png"/></svg>`),
    ),
    "OEBPS/text/plates.xhtml": strToU8(
      xhtml("Plates", `<div><img src="../images/plate1.png" alt="Plate one"/></div><div><img src="../images/plate2.jpg" alt="Plate two"/></div>`),
    ),
    "OEBPS/text/ch1.xhtml": strToU8(
      xhtml(
        "One",
        `<h1>The Lantern Room</h1>
<p>The first paragraph of the original sample chapter.</p>
<p><ruby>漢<rt>kan</rt></ruby>字 stays readable after the annotation is dropped.</p>
<p><img src="../images/inline.png" alt="An inline sketch"/></p>
<p>Text that follows the sketch.&nbsp;It uses a non-breaking space.</p>`,
      ),
    ),
    "OEBPS/text/ch2.xhtml": strToU8(
      xhtml(
        "Two",
        `<h1 id="a">Part A</h1><p>Alpha paragraph one.</p><p>Alpha paragraph two.</p>
<h1 id="b">Part B</h1><p>Beta paragraph one.</p>`,
      ),
    ),
    "OEBPS/text/ch3.xhtml": strToU8(xhtml("Three", `<h1>Wordless Page</h1><div><img src="../images/page.png" alt=""/></div>`)),
  };

  const items = [
    ["cover", "text/cover.xhtml"],
    ["plates", "text/plates.xhtml"],
    ["ch1", "text/ch1.xhtml"],
    ["ch2", "text/ch2.xhtml"],
    ["ch3", "text/ch3.xhtml"],
  ];
  const tocMarkup: Record<string, { href: string; label: string }[]> = {
    nav: [
      { href: "text/plates.xhtml", label: "Illustrations" },
      { href: "text/ch1.xhtml", label: "The Lantern Room" },
      { href: "text/ch2.xhtml#a", label: "Part A" },
      { href: "text/ch2.xhtml#b", label: "Part B" },
      { href: "text/ch3.xhtml", label: "Wordless Page" },
    ],
  };
  const entries = tocMarkup.nav;

  if (toc === "nav") {
    files["OEBPS/nav.xhtml"] = strToU8(
      xhtml(
        "Contents",
        `<nav epub:type="toc"><ol>${entries.map((e) => `<li><a href="${e.href}">${e.label}</a></li>`).join("")}</ol></nav>`,
      ),
    );
  } else if (toc === "ncx") {
    files["OEBPS/toc.ncx"] = strToU8(
      `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${entries
        .map((e, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${e.label}</text></navLabel><content src="${e.href}"/></navPoint>`)
        .join("")}</navMap></ncx>`,
    );
  }

  files["OEBPS/content.opf"] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>Sample Volume (original test fixture)</dc:title>
  <dc:creator>Test Author</dc:creator>
  <dc:language>en</dc:language>
  <meta name="calibre:series" content="Sample Series"/>
  <meta name="calibre:series_index" content="${seriesIndex}"/>
  <meta name="cover" content="cover-img"/>
</metadata>
<manifest>
  <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
  <item id="p1" href="images/plate1.png" media-type="image/png"/>
  <item id="p2" href="images/plate2.jpg" media-type="image/jpeg"/>
  <item id="i1" href="images/inline.png" media-type="image/png"/>
  <item id="pg" href="images/page.png" media-type="image/png"/>
  ${toc === "nav" ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ""}
  ${toc === "ncx" ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
  ${items.map(([id, href]) => `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`).join("\n  ")}
</manifest>
<spine${toc === "ncx" ? ' toc="ncx"' : ""}>${items.map(([id]) => `<itemref idref="${id}"/>`).join("")}</spine>
</package>`,
  );

  return zipSync(files);
}
