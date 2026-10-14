import { strToU8, zipSync } from "fflate";
import { fakePng } from "./epub-fixture";

const xhtml = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;

/**
 * An illustrated novel in miniature (original text, synthetic pictures):
 *  - cover page, then a named "Color Illustrations" plate section (front matter)
 *  - Chapter One: four pictures in four different wrappers between paragraphs
 *  - "Illustration 1": a stand-alone picture page the book LISTS like a chapter
 *  - Chapter Two: figure, CSS-background picture, SVG picture, and a reference to a MISSING file
 *  - "Illustration 2": another listed picture page
 *  - "Bonus Illustrations": a genuine named image-only section at the end
 *  - one picture stored in the file that no page uses
 */
export function buildInlineEpub(): Uint8Array {
  const img = (n: number) => fakePng(600 + n, 400 + n, n);
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "OEBPS/images/cover.png": img(1),
    "OEBPS/images/plate1.png": img(2),
    "OEBPS/images/plate2.png": img(3),
    "OEBPS/images/a1.png": img(4),
    "OEBPS/images/a2.png": img(5),
    "OEBPS/images/a3.png": img(6),
    "OEBPS/images/a4.png": img(7),
    "OEBPS/images/ill1.png": img(8),
    "OEBPS/images/b1.png": img(9),
    "OEBPS/images/b2.png": img(10),
    "OEBPS/images/b3.png": img(11),
    "OEBPS/images/ill2.png": img(12),
    "OEBPS/images/bonus1.png": img(13),
    "OEBPS/images/bonus2.png": img(14),
    "OEBPS/images/unused.png": img(15),
    "OEBPS/text/cover.xhtml": strToU8(xhtml("Cover", `<div><img src="../images/cover.png" alt=""/></div>`)),
    "OEBPS/text/plates.xhtml": strToU8(xhtml("Plates", `<div><img src="../images/plate1.png" alt=""/></div><div><img src="../images/plate2.png" alt=""/></div>`)),
    "OEBPS/text/ch1.xhtml": strToU8(
      xhtml(
        "One",
        `<h1>Chapter One</h1>
<p>Paragraph one of chapter one.</p>
<p><img src="../images/a1.png" alt="picture in a paragraph"/></p>
<p>Paragraph two of chapter one.</p>
<div class="illust"><img src="../images/a2.png" alt="picture in a div"/></div>
<p>Paragraph three of chapter one.</p>
<p><a href="notes.xhtml"><img src="../images/a3.png" alt="picture inside a link"/></a></p>
<p>Paragraph four of chapter one.</p>
<p>Text and a picture <img src="../images/a4.png" alt="picture inside a sentence"/> in one paragraph.</p>
<p>Paragraph five of chapter one.</p>`,
      ),
    ),
    "OEBPS/text/ill1.xhtml": strToU8(xhtml("Ill1", `<div><img src="../images/ill1.png" alt=""/></div>`)),
    "OEBPS/text/ch2.xhtml": strToU8(
      xhtml(
        "Two",
        `<h1>Chapter Two</h1>
<p>Paragraph one of chapter two.</p>
<figure><img src="../images/b1.png" alt="figure picture"/><figcaption>A short caption.</figcaption></figure>
<p>Paragraph two of chapter two.</p>
<div style="background-image:url('../images/b2.png');height:300px"></div>
<p>Paragraph three of chapter two.</p>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 400"><image width="600" height="400" xlink:href="../images/b3.png"/></svg>
<p>Paragraph four of chapter two.</p>
<p><img src="../images/gone.png" alt="a picture that is missing from the file"/></p>
<p>Paragraph five of chapter two.</p>`,
      ),
    ),
    "OEBPS/text/ill2.xhtml": strToU8(xhtml("Ill2", `<div><img src="../images/ill2.png" alt=""/></div>`)),
    "OEBPS/text/bonus.xhtml": strToU8(xhtml("Bonus", `<div><img src="../images/bonus1.png" alt=""/></div><div><img src="../images/bonus2.png" alt=""/></div>`)),
  };

  const spine = ["cover", "plates", "ch1", "ill1", "ch2", "ill2", "bonus"];
  const toc = [
    ["text/plates.xhtml", "Color Illustrations"],
    ["text/ch1.xhtml", "Chapter One"],
    ["text/ill1.xhtml", "Illustration 1"],
    ["text/ch2.xhtml", "Chapter Two"],
    ["text/ill2.xhtml", "Illustration 2"],
    ["text/bonus.xhtml", "Bonus Illustrations"],
  ];
  files["OEBPS/nav.xhtml"] = strToU8(
    xhtml("Contents", `<nav epub:type="toc"><ol>${toc.map(([h, l]) => `<li><a href="${h}">${l}</a></li>`).join("")}</ol></nav>`),
  );
  const imageIds = ["cover", "plate1", "plate2", "a1", "a2", "a3", "a4", "ill1", "b1", "b2", "b3", "ill2", "bonus1", "bonus2", "unused"];
  files["OEBPS/content.opf"] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Illustrated Sample (original test fixture)</dc:title><dc:creator>Test Author</dc:creator><dc:language>en</dc:language>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  ${imageIds.map((id) => `<item id="im-${id}" href="images/${id}.png" media-type="image/png"${id === "cover" ? ' properties="cover-image"' : ""}/>`).join("\n  ")}
  ${spine.map((id) => `<item id="${id}" href="text/${id}.xhtml" media-type="application/xhtml+xml"/>`).join("\n  ")}
</manifest>
<spine>${spine.map((id) => `<itemref idref="${id}"/>`).join("")}</spine>
</package>`,
  );
  return zipSync(files);
}
