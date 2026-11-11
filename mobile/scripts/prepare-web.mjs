// Builds mobile/www, the web assets Capacitor bundles into the APK, from the shared desktop
// renderer. The folder layout matches the desktop app (src/renderer, src/shared, vendor/foliate-js),
// so every relative import works unchanged; Capacitor starts at /src/renderer/index.html.
//
// index.html gets two changes:
//  - the Content-Security-Policy as a <meta> tag (on desktop, main.js sends it as a header).
//    Book sections are blob: documents, which inherit it, so scripts inside books stay blocked.
//  - the Android window.api adapter, loaded before app.js.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(MOBILE, '..')
const WWW = path.join(MOBILE, 'www')

// keep in step with CSP in src/main.js ('self' is https://localhost here)
const CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const skip = f => /\.(md|map)$/i.test(f) || /(^|[/\\])\.git/.test(f)
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: src => !skip(src) })

fs.rmSync(WWW, { recursive: true, force: true })
copy(path.join(ROOT, 'src/renderer'), path.join(WWW, 'src/renderer'))
copy(path.join(ROOT, 'src/shared'), path.join(WWW, 'src/shared'))
copy(path.join(ROOT, 'vendor/foliate-js'), path.join(WWW, 'vendor/foliate-js'))
copy(path.join(MOBILE, 'web'), path.join(WWW, 'src/android'))
fs.copyFileSync(path.join(MOBILE, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(WWW, 'src/android/capacitor.js'))

// pdf.js needs a few recent JavaScript features that older Android WebViews lack
const polyfills = fs.readFileSync(path.join(MOBILE, 'scripts/pdfjs-polyfills.js'), 'utf8')
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
  const file = path.join(WWW, 'vendor/foliate-js/vendor/pdfjs', f)
  fs.writeFileSync(file, polyfills + '\n' + fs.readFileSync(file, 'utf8'))
}

const indexFile = path.join(WWW, 'src/renderer/index.html')
let html = fs.readFileSync(indexFile, 'utf8')
const must = (find, replace) => {
  if (!html.includes(find)) throw new Error(`index.html: "${find}" not found`)
  html = html.replace(find, replace)
}
must('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
must('<script type="module" src="app.js"></script>',
  '<script src="../android/capacitor.js"></script>\n<script type="module" src="../android/api.js"></script>\n<script type="module" src="app.js"></script>')
fs.writeFileSync(indexFile, html)

// a stray index.html at the root would only be served for "/", which the app never loads
fs.writeFileSync(path.join(WWW, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=src/renderer/index.html">\n')

let files = 0, bytes = 0
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size } } }
walk(WWW)
console.log(`www: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`)
