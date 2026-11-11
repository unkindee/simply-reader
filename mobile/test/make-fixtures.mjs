// Writes small synthetic test books (no real books or personal data) into the folder given:
//   node test/make-fixtures.mjs <dir>
// sample.epub has several chapters of generated text, a picture, a footnote, an external link,
// and hostile content that must never run: a <script>, an inline event handler and a
// javascript: link. If any of them ran, it would set data-pwned on the app's <body>.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { writeZip } = require('../../src/zip.js')
const zlib = require('node:zlib')

const dir = path.resolve(process.argv[2] ?? '.')
fs.mkdirSync(dir, { recursive: true })

// a 160×100 PNG with a colour gradient, made by hand (no image library)
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3
    raw[i] = 40 + x; raw[i + 1] = 90 + y; raw[i + 2] = 160
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const words = 'the river ran quietly past the old mill where the miller kept his books and every evening he read by the window until the light was gone'.split(' ')
let seed = 7
const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
const sentence = () => { const s = Array.from({ length: 8 + rnd(12) }, () => words[rnd(words.length)]).join(' '); return s[0].toUpperCase() + s.slice(1) + '.' }
const para = () => `<p>${Array.from({ length: 4 + rnd(4) }, sentence).join(' ')}</p>`

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>${title}</title></head>
<body>${body}</body>
</html>`

const chapters = []
for (let c = 1; c <= 4; c++) {
  let body = `<h1>Chapter ${c}</h1>` + Array.from({ length: 30 }, para).join('\n')
  if (c === 1) body = `<h1>Chapter 1</h1>
<p id="first">The first paragraph of the test book. It has a footnote<a epub:type="noteref" href="#n1">1</a> and a link to <a href="https://example.org/">a web page</a>.</p>
<p><img src="picture.png" alt="A test picture" width="320" height="200"/></p>
<script>document.body.dataset.pwned = 'script'; try { parent.document.body.dataset.pwned = 'script' } catch (e) {}</script>
<p><img src="missing.png" alt="" onerror="parent.document.body.dataset.pwned = 'onerror'"/></p>
<p><a href="javascript:parent.document.body.dataset.pwned='href'">A javascript: link</a></p>
${Array.from({ length: 30 }, para).join('\n')}
<aside epub:type="footnote" id="n1"><p>This is the footnote text.</p></aside>`
  chapters.push({ id: `c${c}`, file: `chapter${c}.xhtml`, title: `Chapter ${c}`, html: xhtml(`Chapter ${c}`, body) })
}

const nav = xhtml('Contents', `<nav epub:type="toc"><h1>Contents</h1><ol>${chapters.map(c => `<li><a href="${c.file}">${c.title}</a></li>`).join('')}</ol></nav>`)
const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:7f6c1c66-0000-4000-8000-simplyreader01</dc:identifier>
<dc:title>The Miller’s Test Book</dc:title>
<dc:creator>Test Author</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="pic" href="picture.png" media-type="image/png"/>
${chapters.map(c => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"${c.id === 'c1' ? ' properties="scripted"' : ''}/>`).join('\n')}
</manifest>
<spine>${chapters.map(c => `<itemref idref="${c.id}"/>`).join('')}</spine>
</package>`

await writeZip(path.join(dir, 'sample.epub'), [
  { name: 'mimetype', data: Buffer.from('application/epub+zip') },
  { name: 'META-INF/container.xml', data: Buffer.from(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
  { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
  { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav) },
  { name: 'OEBPS/picture.png', data: png(160, 100) },
  ...chapters.map(c => ({ name: `OEBPS/${c.file}`, data: Buffer.from(c.html) })),
])
console.log('wrote', path.join(dir, 'sample.epub'))
