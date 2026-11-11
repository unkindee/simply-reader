import { makeBook } from '../../vendor/foliate-js/view.js'
import { Overlayer } from '../../vendor/foliate-js/overlayer.js'
import * as CFI from '../../vendor/foliate-js/epubcfi.js'
import { FootnoteHandler } from '../../vendor/foliate-js/footnotes.js'

const api = window.api
// What this platform can do. Desktop has everything; Android (mobile/web/api.js) leaves out a
// few desktop features, whose controls are hidden (see applyCapabilities).
const CAN = { folderImport: true, showInFolder: true, dragDrop: true, pageCapture: true, autoBackup: true, ...api.capabilities }
const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v != null) e.setAttribute(k, v)
  }
  e.append(...children.filter(c => c != null))
  return e
}
const icon = id => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ic')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#' + id)
  svg.append(use)
  return svg
}
const plural = (n, word, pl = word + 's') => `${n} ${n === 1 ? word : pl}`
const debounce = (fn, ms) => {
  let t
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
  d.cancel = () => clearTimeout(t)
  return d
}
// coalesce bursts (e.g. slider drags) into one call per animation frame
const perFrame = fn => {
  let queued = false
  return () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fn() }) } }
}

const SUPPORTED = /\.(epub|mobi|azw3?|kf8|prc|fb2|fbz|cbz|pdf)$/i
const pct = new Intl.NumberFormat('en', { style: 'percent' })
const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  theme: 'dark', fontFamily: 'publisher', fontSize: 18, lineHeight: 1.5,
  gap: 6, maxWidth: 720, flow: 'paginated', columns: 2, pageTurn: 'flip',
  justify: true, hyphenate: true, override: true, pageNumbers: true,
  footerAuto: true, // progress footer hidden until the pointer is over it
  pdfZoom: 'fit-page', pdfDark: false, // fixed-layout pages: 'fit-page' | 'fit-width' | scale number
}
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const THEMES = {
  light: { fg: '#1f1d1a', bg: '#fbfaf7', link: '#b4532a', dark: false },
  sepia: { fg: '#4a3a2b', bg: '#f4ecd8', link: '#9b4a22', dark: false },
  dark:  { fg: '#e0dcd4', bg: '#1d1d21', link: '#e59a68', dark: true },
  black: { fg: '#c8c3bb', bg: '#000000', link: '#e59a68', dark: true },
}
const HL = { yellow: '#f5c84c', green: '#6fcf8a', blue: '#64a8f0', pink: '#f080ac' }
const FINISHED = 0.995 // reading progress treated as "finished"
const inProgress = b => !!b.lastOpened && (b.fraction ?? 0) > 0 && (b.fraction ?? 0) < FINISHED
let S = { ...DEFAULTS }

// fonts bundled with the app; declared inside each book page (pages are separate documents)
const BUNDLED_FONTS = [
  ['Atkinson Hyperlegible', 'atkinson-hyperlegible/AtkinsonHyperlegible', [
    ['Regular', 400, 'normal'], ['Italic', 400, 'italic'], ['Bold', 700, 'normal'], ['BoldItalic', 700, 'italic']]],
]
const fontURL = new Map() // file path -> URL used in @font-face (an in-memory blob once loaded)
const buildFontFaceCSS = () => BUNDLED_FONTS.flatMap(([family, base, faces]) => faces.map(([file, weight, style]) => {
  const rel = `fonts/${base}-${file}.ttf`
  const url = fontURL.get(rel) ?? new URL(rel, import.meta.url).href
  return `@font-face { font-family: '${family}'; src: url("${url}") format("truetype"); font-weight: ${weight}; font-style: ${style}; font-display: block; }`
})).join('\n')
let fontFaceCSS = buildFontFaceCSS()
// Every book page is its own document and would re-request the font files; reading them
// once into blob URLs makes each page (and the background page count) load them instantly.
async function preloadBundledFonts() {
  await Promise.all(BUNDLED_FONTS.flatMap(([, base, faces]) => faces.map(async ([file]) => {
    const rel = `fonts/${base}-${file}.ttf`
    try {
      const blob = await (await fetch(new URL(rel, import.meta.url))).blob()
      fontURL.set(rel, URL.createObjectURL(new Blob([blob], { type: 'font/ttf' })))
    } catch (e) { console.error('font preload failed', rel, e) }
  })))
  fontFaceCSS = buildFontFaceCSS()
}

const bookCSS = s => {
  const t = THEMES[s.theme] ?? THEMES.dark
  const fam = s.fontFamily !== 'publisher' ? s.fontFamily : null
  return `
@namespace epub "http://www.idpf.org/2007/ops";
${fam?.includes('Atkinson') ? fontFaceCSS : ''}
html { color-scheme: ${t.dark ? 'dark' : 'light'}; font-size: ${s.fontSize}px !important; }
html, body { color: ${t.fg} !important; background: ${t.bg} !important; }
body { line-height: ${s.lineHeight}; }
${fam ? `body, body *:not(pre):not(code):not(kbd):not(samp):not(tt) { font-family: ${fam} !important; }` : ''}
p, li, blockquote, dd {
  line-height: ${s.lineHeight} !important;
  text-align: ${s.justify ? 'justify' : 'start'};
  -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
  hyphens: ${s.hyphenate ? 'auto' : 'manual'};
  widows: 2; orphans: 2;
}
[align="left"] { text-align: left; } [align="right"] { text-align: right; }
[align="center"] { text-align: center; } [align="justify"] { text-align: justify; }
${s.override ? `body *:not(img):not(svg):not(svg *):not(image):not(video) {
  color: inherit !important; background-color: transparent !important;
}` : ''}
a:link, a:visited, a:link *, a:visited * { color: ${t.link} !important; }
${t.dark ? 'img { filter: brightness(.9); }' : ''}
::selection { background: ${t.link}55; }
pre { white-space: pre-wrap !important; }
aside[epub|type~="endnote"], aside[epub|type~="footnote"],
aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`
}

// Each book keeps its own text and page settings; theme, page turn and the footer are shared.
// G holds the defaults (settings.json); bookPrefs holds the open book's own choices
// (saved with the book in the library); S is what's in effect: { ...G, ...bookPrefs }.
const BOOK_KEYS = ['fontFamily', 'fontSize', 'lineHeight', 'gap', 'maxWidth', 'flow', 'columns',
  'justify', 'hyphenate', 'override', 'pdfZoom', 'pdfDark']
let G = { ...DEFAULTS }
let bookPrefs = {}
const mergeSettings = () => { S = { ...G, ...bookPrefs } }
const pickBookPrefs = o => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => BOOK_KEYS.includes(k)))
// Pending saves are only dropped once they are written: a failed write stays pending and is
// tried again with the next save (flushAll runs when the app is hidden).
let settingsPending = false
const saveSettingsSoon = debounce(flushSettings, 300)
const saveSettings = () => { settingsPending = true; saveSettingsSoon() }
function flushSettings() {
  saveSettingsSoon.cancel()
  if (!settingsPending) return undefined
  settingsPending = false
  return api.settings.set(G).catch(e => { console.error(e); settingsPending = true })
}
let bookPrefsPending = null
const saveBookPrefsSoon = debounce(flushBookPrefs, 300)
function flushBookPrefs() {
  saveBookPrefsSoon.cancel()
  const p = bookPrefsPending
  bookPrefsPending = null
  return p ? api.library.upsert(p.path, { prefs: p.prefs }).catch(e => {
    console.error(e)
    bookPrefsPending ??= p // unless newer settings are already waiting
  }) : undefined
}
function storeBookPrefs() {
  const prefs = { ...bookPrefs }
  if (libCache[current.id]) libCache[current.id].prefs = prefs
  bookPrefsPending = { path: current.path, prefs }
  saveBookPrefsSoon()
  syncScopeUI()
}
// with a book open, its settings change only for that book
function assignSetting(k, v) {
  if (current && BOOK_KEYS.includes(k)) {
    if (v === G[k]) delete bookPrefs[k]; else bookPrefs[k] = v
    storeBookPrefs()
  } else {
    G[k] = v
    saveSettings()
  }
  mergeSettings()
}
function syncScopeUI() {
  const own = !!current && Object.keys(bookPrefs).length > 0
  $('#set-scope-note').textContent = !current ? '' : own
    ? 'This book has its own settings.' : 'This book uses your default settings. Changes apply to this book only.'
  $('#set-make-default').hidden = !own
  $('#set-reset').textContent = own ? 'Reset this book' : 'Restore original defaults'
  $('#set-reset').title = own ? 'Go back to your default settings for this book' : 'Restore the settings Simply Reader came with'
}

// layout shared by the visible reader and the hidden page counter, so page counts match
function configureRenderer(r, flow) {
  r.setAttribute('flow', flow)
  r.setAttribute('gap', S.gap + '%')
  r.setAttribute('margin', '28px')
  r.setAttribute('max-inline-size', S.maxWidth + 'px')
  r.setAttribute('max-column-count', String(S.columns))
  r.setStyles?.(bookCSS(S))
}

function applySettings() {
  document.body.dataset.theme = S.theme
  syncChrome()
  document.body.classList.toggle('pdf-dark', !!S.pdfDark)
  if (view?.isFixedLayout) view.renderer.setAttribute('zoom', String(S.pdfZoom))
  $('#reader').classList.toggle('scrolled', S.flow === 'scrolled')
  syncFooterButton()
  syncSettingsUI()
  if (!view?.renderer) return
  configureRenderer(view.renderer, S.flow)
  schedulePagination()
}
const applySettingsPerFrame = perFrame(applySettings)
// Android: the status and navigation bars take the theme's background colour
let chromeKey = ''
function syncChrome() {
  if (!api.setChrome) return
  // the theme token, not the body's colour, which is still mid-transition right after a change
  let bg = getComputedStyle(document.body).getPropertyValue('--bg').trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(bg)) bg = '#' + [...bg.slice(1)].map(c => c + c).join('')
  if (!/^#[0-9a-f]{6}$/.test(bg)) return
  const dark = !!(THEMES[S.theme] ?? THEMES.dark).dark
  if (chromeKey === bg + dark) return
  chromeKey = bg + dark
  api.setChrome({ bg, dark })
}
if (api.setChrome) addEventListener('resize', debounce(() => { chromeKey = ''; syncChrome() }, 300)) // rotating resets the bars
const setSetting = (k, v) => { assignSetting(k, v); applySettings() }

// segmented controls: setting key -> [container, value parser]
const SEGMENTS = {
  flow: ['#set-flow', String], columns: ['#set-columns', Number],
  pageTurn: ['#set-pageTurn', String], pdfZoom: ['#set-pdfFit', String],
}
const CHECKBOXES = ['justify', 'hyphenate', 'override', 'pageNumbers', 'pdfDark']

// Font menu. Windows has the fonts listed in index.html. Elsewhere (Linux) installed fonts
// vary by distribution, so the menu lists the candidates below that are actually there. The
// Windows fonts keep their Windows values, so a font chosen on one system still matches on
// another that has it.
const FONT_CANDIDATES = {
  serif: ['Georgia, serif', "'Palatino Linotype', 'Book Antiqua', Palatino, serif", 'Cambria, serif', "'Times New Roman', serif",
    "'Noto Serif', serif", "'DejaVu Serif', serif", "'Liberation Serif', serif", "'Source Serif 4', serif", 'Gelasio, serif'],
  sans: ["'Segoe UI', system-ui, sans-serif", 'Calibri, sans-serif', 'Verdana, sans-serif',
    "'Noto Sans', sans-serif", "'DejaVu Sans', sans-serif", "'Liberation Sans', sans-serif", 'Ubuntu, sans-serif',
    "'Adwaita Sans', sans-serif", 'Cantarell, sans-serif', 'Carlito, sans-serif'],
  mono: ['Consolas, monospace', "'Noto Sans Mono', monospace", "'DejaVu Sans Mono', monospace", "'Liberation Mono', monospace",
    "'Ubuntu Mono', monospace", "'Adwaita Mono', monospace"],
}
const firstFamily = value => value.split(',')[0].replace(/['"]/g, '').trim()
const FONT_LABELS = { 'Palatino Linotype': 'Palatino', 'Times New Roman': 'Times' }
function listInstalledFonts() {
  if (api.platform === 'win32') return
  // A font is installed when sample text set in it measures differently from the generic
  // families. Linux can also stand in a look-alike for a missing font (Liberation Serif for
  // Times New Roman): fonts that measure exactly like one already listed are left out.
  const ctx = document.createElement('canvas').getContext('2d')
  const sample = 'mmmmmmmmmmlli1|WQ@#Ægå—'
  const widths = family => ['monospace', 'serif', 'sans-serif'].map(base => {
    ctx.font = `40px ${family ? `"${family}", ` : ''}${base}`
    return ctx.measureText(sample).width
  }).join()
  const generic = widths(null), seen = new Set([generic])
  const pick = value => {
    const w = widths(firstFamily(value))
    if (seen.has(w)) return null
    seen.add(w)
    return el('option', { value, text: FONT_LABELS[firstFamily(value)] ?? firstFamily(value) })
  }
  const sel = $('#set-font')
  const keep = value => [...sel.options].find(o => o.value === value || (value === 'atkinson' && o.value.includes('Atkinson')))
  sel.replaceChildren(keep('publisher'), ...FONT_CANDIDATES.serif.map(pick).filter(Boolean), keep('atkinson'),
    ...[...FONT_CANDIDATES.sans, ...FONT_CANDIDATES.mono].map(pick).filter(Boolean))
}
// a font chosen on another computer (in a restored backup) that this one doesn't list
function showFontChoice(value) {
  const sel = $('#set-font')
  if (![...sel.options].some(o => o.value === value)) {
    const name = FONT_LABELS[firstFamily(value)] ?? firstFamily(value)
    // outside Windows the list holds every installed candidate, so this one isn't installed
    sel.append(el('option', { value, text: api.platform === 'win32' ? name : `${name} (not installed)` }))
  }
  sel.value = value
}

function syncSettingsUI() {
  $$('[data-theme-btn]').forEach(b => b.classList.toggle('active', b.dataset.themeBtn === S.theme))
  showFontChoice(S.fontFamily)
  $('#out-fontSize').value = S.fontSize + 'px'
  $('#set-lineHeight').value = S.lineHeight; $('#out-lineHeight').value = (+S.lineHeight).toFixed(2)
  $('#set-gap').value = S.gap; $('#out-gap').value = S.gap + '%'
  $('#set-maxWidth').value = S.maxWidth; $('#out-maxWidth').value = S.maxWidth
  for (const [k, [sel, parse]] of Object.entries(SEGMENTS))
    $$(sel + ' button').forEach(b => b.classList.toggle('active', parse(b.dataset.val) === parse(S[k])))
  for (const k of CHECKBOXES) $('#set-' + k).checked = !!S[k]
  $('#out-zoom').value = typeof S.pdfZoom === 'number' ? `${Math.round(S.pdfZoom * 100)}%` : 'Fit'
  syncScopeUI()
}

// current on-screen scale of fixed-layout pages (pdf.js stores it on each page document)
function currentPageScale() {
  for (const { doc } of liveFxlLayers()) {
    const f = parseFloat(getComputedStyle(doc.documentElement).getPropertyValue('--scale-factor'))
    if (f > 0) return f / devicePixelRatio
  }
  return 1
}
function zoomStep(dir) {
  const cur = typeof S.pdfZoom === 'number' ? S.pdfZoom : currentPageScale()
  const next = dir > 0 ? ZOOM_STEPS.find(z => z > cur + 0.01) ?? ZOOM_STEPS.at(-1)
    : ZOOM_STEPS.findLast(z => z < cur - 0.01) ?? ZOOM_STEPS[0]
  setSetting('pdfZoom', next)
}

function initSettingsUI() {
  $$('[data-theme-btn]').forEach(b => b.onclick = () => setSetting('theme', b.dataset.themeBtn))
  listInstalledFonts()
  $('#set-font').onchange = e => setSetting('fontFamily', e.target.value)
  $$('[data-step]').forEach(b => b.onclick = () => changeFontSize(+b.dataset.dir))
  // sliders fire many input events per second while dragging: restyle the book once per frame
  for (const k of ['lineHeight', 'gap', 'maxWidth'])
    $('#set-' + k).oninput = e => { assignSetting(k, +e.target.value); applySettingsPerFrame() }
  for (const [k, [sel, parse]] of Object.entries(SEGMENTS))
    $$(sel + ' button').forEach(b => b.onclick = () => setSetting(k, parse(b.dataset.val)))
  $$('[data-zoom]').forEach(b => b.onclick = () => zoomStep(+b.dataset.zoom))
  for (const k of CHECKBOXES) $('#set-' + k).onchange = e => setSetting(k, e.target.checked)
  $('#set-reset').onclick = () => {
    if (current && Object.keys(bookPrefs).length) { bookPrefs = {}; storeBookPrefs() }
    else { G = { ...DEFAULTS, theme: G.theme }; saveSettings() }
    mergeSettings(); applySettings()
  }
  $('#set-make-default').onclick = () => {
    G = { ...G, ...bookPrefs } // books you haven't adjusted follow the new defaults
    bookPrefs = {}
    saveSettings(); storeBookPrefs()
    mergeSettings(); applySettings()
    toast('These settings are now the default for your books')
  }
}
const changeFontSize = dir => setSetting('fontSize', Math.min(40, Math.max(10, S.fontSize + dir)))
// Ctrl+wheel / Ctrl+= / Ctrl+- / Ctrl+0: zoom fixed-layout pages, resize reflowable text
const zoomBy = dir => view?.isFixedLayout ? zoomStep(dir) : changeFontSize(dir)
const resetZoom = () => view?.isFixedLayout ? setSetting('pdfZoom', 'fit-page') : setSetting('fontSize', DEFAULTS.fontSize)

// ---------------------------------------------------------------- helpers
const langMap = x => !x ? '' : typeof x === 'string' ? x : x[Object.keys(x)[0]] ?? ''
const formatAuthor = a => {
  const one = c => typeof c === 'string' ? c : langMap(c?.name)
  return Array.isArray(a) ? a.map(one).filter(Boolean).join(', ') : one(a)
}
const baseName = p => p.replace(/^sr-book:/, '').split(/[\\/]/).pop() // Android books are "sr-book:<file name>"
const stripExt = n => n.replace(/\.[^.]+$/, '')

function toast(msg, type = '', ms = 3500) {
  const t = el('div', { class: 'toast ' + type, text: msg })
  $('#toasts').append(t)
  setTimeout(() => t.remove(), ms)
}
const showLoading = text => { $('#loading-text').textContent = text; $('#loading').hidden = false }
const hideLoading = () => { $('#loading').hidden = true }

// Covers are kept sharp on high-DPI screens and large cards. Bump COVER_RES to make the
// library regenerate every stored cover (older entries are upgraded in the background).
const COVER_RES = 800 // max width in px
async function makeThumb(book) {
  try {
    const blob = await book.getCover?.()
    return blob ? await thumbFromBlob(blob) : null
  } catch { return null }
}
async function thumbFromBlob(blob) {
  try {
    let src = await createImageBitmap(blob)
    const w = Math.min(COVER_RES, src.width)
    const h = Math.round(src.height * w / src.width)
    // halve in steps: one big drawImage reduction skips pixels and looks jagged
    while (src.width / 2 >= w) {
      const half = el('canvas', { width: Math.round(src.width / 2), height: Math.round(src.height / 2) })
      const hc = half.getContext('2d')
      hc.imageSmoothingQuality = 'high'
      hc.drawImage(src, 0, 0, half.width, half.height)
      src.close?.()
      src = half
    }
    const canvas = el('canvas', { width: w, height: h })
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#fff' // transparent PNG covers would turn black as JPEG
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(src, 0, 0, w, h)
    src.close?.()
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch { return null }
}

const bookInfo = (book, fileName) => ({
  title: langMap(book.metadata?.title)?.trim() || stripExt(fileName),
  author: formatAuthor(book.metadata?.author)?.trim() || '',
  format: (fileName.match(/\.([^.]+)$/)?.[1] ?? '').toUpperCase(),
  length: (book.sections ?? []).reduce((sum, s) => sum + (s.linear !== 'no' && s.size > 0 ? s.size : 0), 0),
})

// a cloth-binding color taken from the cover: saturated pixels count more than gray ones
async function spineColorFrom(dataUrl) {
  try {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const c = el('canvas', { width: 24, height: 36 })
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, 24, 36)
    const d = ctx.getImageData(0, 0, 24, 36).data
    let r = 0, g = 0, b = 0, wsum = 0
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2])
      const sat = (max - min) / 255
      const w = 0.12 + sat * sat * 4
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w
    }
    r /= wsum * 255; g /= wsum * 255; b /= wsum * 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l0 = (max + min) / 2
    let h = 0, s = 0
    if (max !== min) {
      const dd = max - min
      s = l0 > 0.5 ? dd / (2 - max - min) : dd / (max + min)
      h = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4
      h *= 60
    }
    const l = Math.min(0.5, Math.max(0.2, l0))
    s = Math.min(0.75, Math.max(0.18, s * 1.15))
    return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`
  } catch { return null }
}

// cover thumbnail and spine color for a library entry that doesn't have them yet
async function coverFields(book, prev) {
  const out = {}
  if (!prev?.customCover && (!prev?.cover || prev.coverRes !== COVER_RES)) {
    const cover = await makeThumb(book)
    if (cover) out.cover = cover
    out.coverRes = COVER_RES // also when the book has no cover image, so it isn't retried
  }
  const cover = out.cover ?? prev?.cover
  if (!prev?.spineColor && cover) out.spineColor = await spineColorFrom(cover)
  return out
}

// re-create low-resolution covers saved by older versions, one book at a time while idle
let coverUpgradeRunning = false
let restoring = false // a backup is replacing the library: background saves stop
async function upgradeCovers() {
  if (coverUpgradeRunning) return
  coverUpgradeRunning = true
  let changed = false
  try {
    for (const b of Object.values(libCache)) {
      if (restoring) break
      if (b.missing || b.customCover || b.coverRes === COVER_RES) continue
      while (current) await wait(2000) // never compete with the open book
      await new Promise(r => (window.requestIdleCallback ?? setTimeout)(r))
      let book
      try {
        const { name, data } = await api.readBook(b.path)
        book = await makeBook(new File([data], name))
        const cover = await makeThumb(book)
        if (restoring) break
        const entry = await api.library.upsert(b.path, cover ? { cover, coverRes: COVER_RES } : { coverRes: COVER_RES })
        libCache[entry.id] = { ...libCache[entry.id], ...entry }
        changed ||= !!cover
      } catch (e) {
        console.warn('cover upgrade failed', b.path, e)
      } finally { try { book?.destroy?.() } catch {} }
    }
  } finally {
    coverUpgradeRunning = false
    if (changed && !current) renderLibrary()
  }
}

// The reader lays pages out right-to-left when the book's (first) language is an RTL one.
// Some books list many languages (e.g. "ar-SA, de-DE, en-US…") with an RTL one first even
// though the text is English, which flips the column order. When the listed languages
// disagree on direction, look at the actual text and keep a language that matches it.
const langDir = lang => {
  try { const l = new Intl.Locale(lang); return (l.getTextInfo?.() ?? l.textInfo)?.direction ?? 'ltr' } catch { return 'ltr' }
}
async function fixBookLanguage(book) {
  const meta = book.metadata
  const langs = [meta?.language].flat().filter(x => typeof x === 'string' && x.trim())
  if (langs.length < 2) return
  const dirs = langs.map(langDir)
  if (dirs.every(d => d === dirs[0])) return
  let letters = 0, rtl = 0
  for (const s of book.sections ?? []) {
    if (letters > 3000) break
    if (s.linear === 'no' || !s.createDocument) continue
    try {
      const text = (await s.createDocument())?.body?.textContent ?? ''
      letters += text.match(/\p{L}/gu)?.length ?? 0
      rtl += text.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g)?.length ?? 0
    } catch {}
  }
  if (!letters) return
  const want = rtl / letters > 0.5 ? 'rtl' : 'ltr'
  const candidates = langs.filter((_, i) => dirs[i] === want)
  // the language also drives hyphenation: prefer the system language, then English
  const base = l => l.split(/[-_]/)[0].toLowerCase()
  const pick = candidates.find(l => base(l) === base(navigator.language || ''))
    ?? candidates.find(l => base(l) === 'en') ?? candidates[0]
  if (pick) meta.language = pick
}

const loadFile = async path => {
  const { name, data } = await api.readBook(path)
  const file = new File([data], name)
  const book = await makeBook(file)
  await fixBookLanguage(book)
  return { name, file, book }
}

// ---------------------------------------------------------------- library
let libCache = {}

async function refreshLibrary() {
  const [lib, st] = await Promise.all([api.library.get(), api.stats.get().catch(() => null)])
  libCache = lib.books ?? {}
  if (st) statsCache = st
  renderLibrary()
}

function coverEl(b) {
  if (b.cover) return el('div', { class: 'cover' }, el('img', { src: b.cover, alt: '', draggable: 'false' }))
  // generated cover: deterministic color from title
  let h = 0
  for (const c of b.title ?? '') h = (h * 31 + c.charCodeAt(0)) >>> 0
  const hue = h % 360
  const c = el('div', { class: 'cover generated' },
    el('div', { class: 'g-title', text: b.title }),
    el('div', { class: 'g-author', text: b.author }))
  c.style.background = `linear-gradient(160deg, hsl(${hue} 42% 38%), hsl(${(hue + 40) % 360} 45% 22%))`
  return c
}

function renderLibrary() {
  const q = $('#lib-filter').value.trim().toLowerCase()
  const sort = $('#lib-sort').value
  let books = Object.values(libCache)
  if (q) books = books.filter(b => `${b.title} ${b.author} ${baseName(b.path)}`.toLowerCase().includes(q))
  renderFilters()
  const filter = activeFilter()
  books = books.filter(filter.test)
  const cmp = {
    recent: (a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || (b.added ?? 0) - (a.added ?? 0),
    added: (a, b) => (b.added ?? 0) - (a.added ?? 0),
    title: (a, b) => (a.title ?? '').localeCompare(b.title ?? ''),
    author: (a, b) => (a.author ?? '').localeCompare(b.author ?? '') || (a.title ?? '').localeCompare(b.title ?? ''),
    progress: (a, b) => (b.fraction ?? 0) - (a.fraction ?? 0),
  }[sort]
  books.sort(cmp)

  const total = Object.keys(libCache).length
  $('#lib-empty').hidden = total > 0
  $('#lib-toolbar').hidden = total === 0

  // "continue reading" hero
  const cont = $('#continue')
  const last = !q && Object.values(libCache)
    .filter(b => b.lastOpened && !b.missing && (b.fraction ?? 0) < FINISHED)
    .sort((a, b) => b.lastOpened - a.lastOpened)[0]
  cont.hidden = !last
  cont.replaceChildren()
  if (last) {
    cont.append(coverEl(last), el('div', {},
      el('div', { class: 'kicker', text: 'Continue reading' }),
      el('h3', { text: last.title }),
      el('div', { class: 'meta', text: [last.author, last.chapter].filter(Boolean).join(' · ') }),
      el('div', { class: 'bar-wrap' },
        el('div', { class: 'pbar' }, el('i', { style: `width:${(last.fraction ?? 0) * 100}%` })),
        el('div', { class: 'pmeta', text: `${pct.format(last.fraction ?? 0)} read` }))))
    cont.onclick = () => openBook(last.path)
  }
  renderGoalStrip()

  const grid = $('#lib-grid')
  grid.replaceChildren()
  const label = $('#lib-label')
  label.hidden = total === 0
  label.textContent = q ? plural(books.length, 'match', 'matches')
    : libFilter === 'all' ? `Library · ${plural(total, 'book')}` : `${filter.name} · ${plural(books.length, 'book')}`
  $('#lib-stats').hidden = total === 0
  if (!books.length && total) grid.replaceChildren(el('div', { class: 'empty-note', text: q ? 'No books match your search.' : 'No books here yet.' }))
  $$('#lib-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === libMode))
  hideShelfTip()
  if (libMode === 'shelf') { grid.className = ''; if (books.length) renderShelf(books); return }
  if (libMode === 'list') { renderList(books); return }
  clearListSelection()
  grid.className = 'grid'

  for (const b of books) {
    const f = b.fraction ?? 0
    const card = el('div', { class: 'card' + (b.missing ? ' missing' : ''), tabindex: '0', title: b.missing ? `File not found:\n${b.path}` : b.path })
    const badge = b.missing ? 'MISSING' : !b.lastOpened ? 'NEW' : f >= FINISHED ? 'FINISHED' : null
    if (badge) card.append(el('span', { class: 'badge' + (badge === 'NEW' ? ' new' : ''), text: badge }))
    const more = el('button', { class: 'more', title: 'More', 'aria-label': 'More options' }, icon('i-dots'))
    more.onclick = e => { e.stopPropagation(); showCardMenu(b, more.getBoundingClientRect()) }
    card.append(more, coverEl(b),
      el('div', { class: 'title', text: b.title }),
      el('div', { class: 'author', text: b.author || b.format || '' }))
    if (inProgress(b))
      card.append(el('div', { class: 'pbar' }, el('i', { style: `width:${f * 100}%` })))
    bindBookActions(card, b)
    grid.append(card)
  }
}

// ----- list view: one row per book with its details
const fmtLastRead = t => {
  if (!t) return 'Never'
  const d = new Date(t), now = new Date()
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days} days ago`
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
function renderList(books) {
  const list = $('#lib-grid')
  list.className = 'book-list'
  if (!books.length) { clearListSelection(); return }
  // keep only selections that are still on screen (search and filters can hide books)
  for (const id of [...listSel]) if (!books.some(b => b.id === id)) listSel.delete(id)
  const all = el('input', { type: 'checkbox', id: 'bl-all', 'aria-label': 'Select all books' })
  all.onchange = () => { if (all.checked) books.forEach(b => listSel.add(b.id)); else listSel.clear(); listAnchor = null; syncListSelection() }
  list.append(el('div', { class: 'bl-head' },
    el('label', { class: 'bl-sel', title: 'Select all (Ctrl+A)' }, all), el('span'), el('span', { text: 'Title' }), el('span', { class: 'bl-c-coll', text: 'Collections' }),
    el('span', { text: 'Progress' }), el('span', { class: 'bl-c-date', text: 'Last read' }), el('span')))
  for (const [i, b] of books.entries()) {
    const f = b.fraction ?? 0
    const status = b.missing ? 'File missing' : !b.lastOpened ? 'New' : f >= FINISHED ? 'Finished' : pct.format(f)
    const readMs = statsCache.books?.[b.id] ?? 0
    const sub = [b.author, b.format, readMs >= 60000 ? `${fmtDuration(readMs)} read` : null].filter(Boolean).join(' · ')
    const more = el('button', { class: 'icon-btn bl-more', title: 'More', 'aria-label': 'More options' }, icon('i-dots'))
    more.onclick = e => { e.stopPropagation(); showCardMenu(b, more.getBoundingClientRect()) }
    more.onkeydown = e => e.stopPropagation() // Enter opens the menu, not the book
    const row = el('div', {
      class: 'bl-row' + (b.missing ? ' missing' : ''), tabindex: '0', role: 'button',
      title: b.missing ? `File not found:
${b.path}` : b.path, 'aria-label': `${b.title}${b.author ? ' by ' + b.author : ''}, ${status}`,
    },
      listCheckbox(b, i, books),
      el('div', { class: 'bl-cover' }, coverEl(b)),
      el('div', { class: 'bl-main' }, el('div', { class: 'bl-title', text: b.title }), el('div', { class: 'bl-sub', text: sub })),
      el('div', { class: 'bl-c-coll' }, ...collectionsOf(b).map(c => el('span', { class: 'bl-tag', text: c }))),
      el('div', { class: 'bl-prog' },
        el('span', { class: 'bl-status' + (status === 'New' ? ' new' : status === 'Finished' ? ' done' : ''), text: status }),
        inProgress(b) ? el('div', { class: 'pbar' }, el('i', { style: `width:${f * 100}%` })) : null),
      el('div', { class: 'bl-c-date', text: fmtLastRead(b.lastOpened) }),
      more)
    row.dataset.id = b.id
    bindBookActions(row, b)
    list.append(row)
  }
  syncListSelection()
}

// ----- list view: select several books (Shift-click for a range) and remove them together
const listSel = new Set()
let listAnchor = null // row index of the last checkbox clicked
function listCheckbox(b, i, books) {
  const box = el('input', { type: 'checkbox', class: 'bl-check', 'aria-label': `Select ${b.title}` })
  box.checked = listSel.has(b.id)
  box.onclick = e => {
    e.stopPropagation() // selecting never opens the book
    if (e.shiftKey && listAnchor != null) {
      const [from, to] = [Math.min(listAnchor, i), Math.max(listAnchor, i)]
      for (let k = from; k <= to; k++) box.checked ? listSel.add(books[k].id) : listSel.delete(books[k].id)
    } else box.checked ? listSel.add(b.id) : listSel.delete(b.id)
    listAnchor = i
    syncListSelection()
  }
  box.onkeydown = e => e.stopPropagation() // Enter/Space act on the checkbox, not the row
  const cell = el('label', { class: 'bl-sel' }, box)
  cell.onclick = e => e.stopPropagation()
  return cell
}
function syncListSelection() {
  const rows = $$('.bl-row')
  for (const r of rows) {
    const on = listSel.has(r.dataset.id)
    r.classList.toggle('selected', on)
    const c = r.querySelector('.bl-check')
    if (c) c.checked = on
  }
  const all = $('#bl-all')
  if (all) {
    all.checked = rows.length > 0 && listSel.size === rows.length
    all.indeterminate = listSel.size > 0 && listSel.size < rows.length
  }
  const n = listSel.size
  $('#bulk-bar').hidden = !(n && libMode === 'list')
  $('#bulk-count').textContent = `${plural(n, 'book')} selected`
}
function selectAllListed() {
  for (const r of $$('.bl-row')) listSel.add(r.dataset.id)
  syncListSelection()
}
function clearListSelection() {
  listSel.clear()
  listAnchor = null
  syncListSelection()
}
async function removeSelected() {
  const books = [...listSel].map(id => libCache[id]).filter(Boolean)
  if (!books.length) return
  const names = books.slice(0, 3).map(b => `“${b.title}”`).join(', ') + (books.length > 3 ? ` and ${books.length - 3} more` : '')
  if (!confirm(`Remove ${plural(books.length, 'book')} from the library?\n\n${names}\n\nTheir saved copies, reading positions, bookmarks and highlights will be deleted. Your original files are not touched.`)) return
  if (current && books.some(b => b.id === current.id)) await closeBook()
  let failed = 0
  for (const b of books) await api.library.remove(b.id).catch(e => { console.error(e); failed++ })
  listSel.clear()
  listAnchor = null
  await refreshLibrary()
  toast(failed ? `Removed ${plural(books.length - failed, 'book')}; ${failed} could not be removed` : `Removed ${plural(books.length, 'book')}`, failed ? 'error' : '')
}
$('#bulk-clear').onclick = clearListSelection
$('#bulk-remove').onclick = removeSelected

// open on click / Enter, context menu at the pointer (used by covers and spines)
function bindBookActions(node, b, beforeMenu) {
  node.onclick = () => openBook(b.path)
  node.onkeydown = e => { if (e.key === 'Enter') openBook(b.path) }
  node.oncontextmenu = e => {
    e.preventDefault()
    beforeMenu?.()
    showCardMenu(b, { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX })
  }
}

// ----- bookshelf view
let libMode = 'covers'
try { libMode = ['shelf', 'list'].includes(localStorage.getItem('libMode')) ? localStorage.getItem('libMode') : 'covers' } catch {}
$$('#lib-mode button').forEach(b => b.onclick = () => {
  libMode = b.dataset.mode
  try { localStorage.setItem('libMode', libMode) } catch {}
  shareViewPrefs()
  renderLibrary()
})

const hashStr = s => {
  let h = 2166136261
  for (const c of s ?? '') h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h
}
const measureCtx = document.createElement('canvas').getContext('2d')
const textWidth = (text, font) => { measureCtx.font = font; return measureCtx.measureText(text).width }

// ----- bookshelf textures: generated once, used as small repeating image tiles
function makeShelfTextures() {
  let seed = 20251107
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const tile = (w, h, draw) => {
    const c = el('canvas', { width: w, height: h })
    draw(c.getContext('2d'), w, h)
    return `url(${c.toDataURL('image/png')})`
  }
  // wood grain: long wavy fibres; wave frequencies are whole cycles so the tile repeats seamlessly
  const grain = vertical => tile(vertical ? 160 : 720, vertical ? 720 : 160, (ctx, W, H) => {
    const L = vertical ? H : W, T = vertical ? W : H
    for (let i = 0; i < 90; i++) {
      const base = rnd() * T, amp = 0.6 + rnd() * 3.2, k1 = 1 + Math.floor(rnd() * 3), k2 = 3 + Math.floor(rnd() * 5)
      const ph = rnd() * 6.28, dark = rnd() < 0.72
      ctx.strokeStyle = dark ? `rgba(0,0,0,${0.05 + rnd() * 0.14})` : `rgba(255,236,200,${0.03 + rnd() * 0.06})`
      ctx.lineWidth = 0.5 + rnd() * (dark ? 2.2 : 1.2)
      ctx.beginPath()
      for (let s = 0; s <= L; s += 6) {
        const off = base + Math.sin(s / L * 6.283 * k1 + ph) * amp + Math.sin(s / L * 6.283 * k2 + ph * 1.7) * amp * 0.35
        vertical ? ctx.lineTo(off, s) : ctx.lineTo(s, off)
      }
      ctx.stroke()
    }
  })
  const noise = (size, alpha) => tile(size, size, (ctx, W, H) => {
    const img = ctx.createImageData(W, H)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() < 0.5 ? 0 : 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = rnd() * alpha
    }
    ctx.putImageData(img, 0, 0)
  })
  const leather = tile(180, 180, ctx => {
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 180, y = rnd() * 180, r = 0.4 + rnd() * 2.4
      ctx.fillStyle = rnd() < 0.8 ? `rgba(0,0,0,${0.04 + rnd() * 0.1})` : `rgba(255,255,255,${0.02 + rnd() * 0.05})`
      ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.5 + rnd()), rnd() * 3, 0, 6.29); ctx.fill()
    }
  })
  const weave = tile(4, 4, ctx => {
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(0, 0, 4, 1); ctx.fillRect(0, 2, 2, 1)
    ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(0, 0, 1, 4); ctx.fillRect(2, 1, 1, 2)
  })
  const root = document.documentElement.style
  root.setProperty('--tex-grain-h', grain(false))
  root.setProperty('--tex-grain-v', grain(true))
  root.setProperty('--tex-noise', noise(96, 40))
  root.setProperty('--tex-leather', leather)
  root.setProperty('--tex-weave', weave)
}
let shelfTexturesMade = false // generated on the first shelf render, not at startup

const BINDINGS = ['leather', 'cloth', 'label', 'paperback']
const EMBLEMS = ['❦', '✦', '◆', '✻', '❧', '✢', '●']
const hslParts = c => (/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(c) ?? [0, 20, 35, 30]).slice(1).map(Number)
const shelfGeom = new WeakMap() // spine element -> { w, h, hash } used by the shelf layout
const spineColorPending = new Map() // book id -> promise of the color being derived from its cover

function spineEl(b) {
  const h = hashStr(b.title + b.path)
  // thickness follows the book's length; height and binding vary per book
  const w = b.length > 0
    ? Math.round(Math.min(66, Math.max(22, 12 + Math.sqrt(b.length / 1000) * 1.4)))
    : 24 + h % 20
  const height = 176 + (h >>> 5) % 50
  const binding = BINDINGS[(h >>> 11) % BINDINGS.length]
  const color = b.spineColor ?? `hsl(${h % 360} 38% 30%)`
  const f = b.fraction ?? 0
  // spines carry the short title (no subtitle) and the author's surname
  const title = (b.title ?? '').split(/\s*(?:[:;]|,\s*or,|\(|\s—\s)/)[0].trim() || b.title
  const author = (b.author ?? '').split(/,|&| and /)[0].trim().split(/\s+/).at(-1) ?? ''

  // vertical space taken by each binding's decorations; the rest is for lettering
  // (padding + bands/rules + emblems + text padding, as laid out in styles.css)
  const reserve = { leather: 92, cloth: 64, label: 72, paperback: 90 }[binding]
  const along = height - reserve
  const titleFont = binding === 'paperback' ? '700 100px "Segoe UI"' : '600 100px Georgia'
  const per100 = textWidth(title, titleFont) / 100 * 1.04
  // the author's name is shown whole or not at all (paperbacks print it in the top band)
  const authorW = author ? textWidth(author.toUpperCase(), '600 9px "Segoe UI Variable Text", "Segoe UI"') + author.length * 1.1 + 4 : 0
  let authorSpace = binding !== 'paperback' && w >= 28 && author && authorW <= along * 0.42 ? authorW : 0
  const titleSpace = () => along - (authorSpace ? authorSpace + 10 : 0)
  const fit = space => Math.min(w * 0.42, 17, space / per100)
  let fs = fit(titleSpace())
  if (fs < 11 && authorSpace) { authorSpace = 0; fs = fit(titleSpace()) }
  let twoLine = false // long titles on thick spines wrap onto two lines, like real books
  if (fs < 12 && w >= 38) {
    const fs2 = Math.min(17, (w - 8) / 2.3, titleSpace() * 2 * 0.82 / per100)
    if (fs2 > fs + 1) { fs = fs2; twoLine = true }
  }
  fs = Math.max(9, fs)
  const bandAuthor = binding === 'paperback' && author && w >= 26 && authorW <= 30 + (w >= 34 ? 6 : 0) ? author : ''
  const foil = binding === 'leather' || (binding === 'cloth' && (h >>> 3) % 3 === 0)
  const emblem = EMBLEMS[(h >>> 17) % EMBLEMS.length]

  const titleEl = el('span', { class: 's-title' + (twoLine ? ' two-line' : '') + (foil ? ' foil' : ''), text: title })
  const authorEl = authorSpace ? el('span', { class: 's-author' + (foil ? ' foil' : ''), text: author }) : null
  const parts = {
    leather: () => [el('i', { class: 'hub' }), el('i', { class: 'hub' }),
      el('div', { class: 's-text' }, titleEl, authorEl), el('i', { class: 'hub' }), el('i', { class: 'hub' })],
    cloth: () => [el('i', { class: 'rule' }), el('div', { class: 's-text' }, titleEl, authorEl),
      el('span', { class: 'emblem' + (foil ? ' foil' : ''), text: emblem }), el('i', { class: 'rule' })],
    label: () => [el('div', { class: 's-label' }, el('div', { class: 's-text' }, titleEl, authorEl)),
      el('span', { class: 'emblem', text: emblem })],
    paperback: () => [el('div', { class: 'pb-band' }, bandAuthor ? el('span', { text: bandAuthor }) : null),
      el('div', { class: 's-text' }, titleEl), el('span', { class: 'pb-logo' })],
  }[binding]()

  const spine = el('div', { class: `spine bind-${binding}` }, ...parts)
  const book = el('div', {
    class: 'book' + (b.missing ? ' missing' : ''), tabindex: '0', role: 'button',
    'aria-label': `${b.title}${b.author ? ' by ' + b.author : ''}`,
  }, spine,
    inProgress(b) ? el('span', { class: 'bookmark' }) : null,
    f >= FINISHED ? el('span', { class: 'done-mark', text: '✦' }) : null)
  book.style.setProperty('--w', w + 'px')
  book.style.setProperty('--h', height + 'px')
  book.style.setProperty('--fs', fs.toFixed(1) + 'px')
  book.style.setProperty('--tilt', ((h >>> 7) % 5 - 2) * 0.6 + 'deg') // bookmarks never sit perfectly straight
  setSpineColor(book, color)
  shelfGeom.set(book, { w, h: height, hash: h })
  bindBookActions(book, b, hideShelfTip)
  book.onmouseenter = book.onfocus = () => showShelfTip(b, book)
  book.onmouseleave = book.onblur = hideShelfTip
  // older library entries: derive the binding color from the cover once and remember it;
  // re-renders while it runs share the same derivation instead of starting another
  if (!b.spineColor && b.cover) {
    let pending = spineColorPending.get(b.id)
    if (!pending) {
      pending = spineColorFrom(b.cover).then(c => {
        spineColorPending.delete(b.id)
        if (c) { b.spineColor = c; api.library.upsert(b.path, { spineColor: c }) }
        return c
      })
      spineColorPending.set(b.id, pending)
    }
    pending.then(c => { if (c) setSpineColor(book, c) })
  }
  return book
}
function setSpineColor(book, color) {
  const [hue, sat, light] = hslParts(color)
  book.style.setProperty('--c', color)
  book.style.setProperty('--ink', light >= 46 ? '#231a12' : '#f4ead6')
  // paperbacks: a contrasting band in a lighter or darker shade of the same hue
  const l2 = light < 40 ? Math.min(82, light + 38) : Math.max(14, light - 26)
  book.style.setProperty('--c2', `hsl(${(hue + 18) % 360} ${Math.min(70, sat + 10)}% ${l2}%)`)
  book.style.setProperty('--ink2', l2 >= 50 ? '#1f1812' : '#f6eedd')
}

function renderShelf(books) {
  if (!shelfTexturesMade) { makeShelfTextures(); shelfTexturesMade = true }
  const grid = $('#lib-grid')
  const inner = el('div', { class: 'bc-inner' })
  grid.append(el('div', { class: 'bookcase' },
    el('div', { class: 'bc-crown' }),
    el('div', { class: 'bc-body' }, el('div', { class: 'bc-post' }), inner, el('div', { class: 'bc-post' })),
    el('div', { class: 'bc-plinth' })))
  const avail = inner.clientWidth - 28 - 12
  const GAP = 3
  const geom = b => shelfGeom.get(b)
  const rows = [[]]
  let used = 0
  for (const book of books.map(spineEl)) {
    const w = geom(book).w + GAP
    if (used + w > avail && rows.at(-1).length) { rows.push([]); used = 0 }
    rows.at(-1).push(book)
    used += w
  }
  rows.forEach((row, r) => {
    const isLast = r === rows.length - 1
    let free = avail - row.reduce((s, b) => s + geom(b).w + GAP, 0)
    const items = [...row]
    // the last shelf gets a little pile of books lying flat when there's room
    if (isLast && row.length >= 5 && free > 270) {
      const pile = []
      let thick = 0
      while (pile.length < 3 && items.length > 3 && thick + geom(items.at(-1)).w <= 150) {
        const b = items.pop()
        thick += geom(b).w
        pile.unshift(b)
      }
      if (pile.length >= 2) {
        const len = Math.max(...pile.map(b => geom(b).h))
        for (const b of pile) {
          b.classList.add('flat')
          b.style.setProperty('--shift', ((geom(b).hash >>> 9) % 13 - 6) + 'px')
        }
        free += thick + pile.length * GAP - (len + 18)
        items.push(el('div', { class: 'pile' }, ...pile.reverse()))
      } else items.push(...pile)
    }
    // a book leaning against its neighbours where a shelf isn't full
    const lastBook = items.findLast(x => x.classList.contains('book'))
    if (lastBook && items.length > 2 && free > 70) {
      const deg = 3 + (geom(lastBook).hash >>> 13) % 6
      const gap = Math.ceil(geom(lastBook).h * Math.sin(deg * Math.PI / 180)) + 2
      if (free > gap + 30) {
        lastBook.classList.add('leaning')
        lastBook.style.setProperty('--lean', `-${deg}deg`)
        lastBook.style.setProperty('--lean-gap', gap + 'px')
        free -= gap
      }
    }
    // and a brass bookend holding the last shelf together
    if (isLast && free > 60) items.push(el('div', { class: 'bookend', 'aria-hidden': 'true' }))
    inner.append(el('div', { class: 'shelf' },
      el('div', { class: 'shelf-books' }, ...items),
      el('div', { class: 'board' })))
  })
}

function showShelfTip(b, s) {
  const tip = $('#shelf-tip')
  const img = tip.querySelector('img')
  if (b.cover) img.src = b.cover; else img.removeAttribute('src')
  tip.querySelector('.t-title').textContent = b.title
  tip.querySelector('.t-author').textContent = b.author || b.format || ''
  const f = b.fraction ?? 0
  tip.querySelector('.t-progress').textContent = b.missing ? 'File not found'
    : !b.lastOpened ? 'Not started' : f >= FINISHED ? 'Finished' : `${pct.format(f)} read${b.chapter ? ' · ' + b.chapter : ''}`
  tip.hidden = false
  const r = s.getBoundingClientRect()
  const { width, height } = tip.getBoundingClientRect()
  let top = r.top - height - 16
  if (top < 72) top = r.bottom + 10
  tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, innerWidth - width - 8)) + 'px'
  tip.style.top = top + 'px'
}
function hideShelfTip() { $('#shelf-tip').hidden = true }
$('#library').addEventListener('scroll', hideShelfTip, { passive: true })

let lastLibWidth = 0
const renderLibrarySoon = debounce(renderLibrary, 120)
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width)
  if (w === lastLibWidth) return
  lastLibWidth = w
  if (libMode !== 'shelf' || document.body.dataset.view !== 'library') return
  renderLibrarySoon()
}).observe($('#library'))

let menuBook = null
function showCardMenu(b, rect) {
  menuBook = b
  const m = $('#card-menu')
  m.hidden = false
  const { width, height } = m.getBoundingClientRect()
  m.style.left = Math.min(rect.left, innerWidth - width - 8) + 'px'
  m.style.top = (rect.bottom + height + 8 > innerHeight ? rect.top - height - 4 : rect.bottom + 4) + 'px'
  menuAnchor = m.getBoundingClientRect() // where follow-up pop-ups (Collections) open
}
let menuAnchor = null
$('#card-menu').addEventListener('click', async e => {
  const action = e.target.closest('button')?.dataset.cm
  const b = menuBook
  $('#card-menu').hidden = true
  if (!b || !action) return
  if (action === 'open') openBook(b.path)
  else if (action === 'info') openBookInfo(b)
  else if (action === 'edit') openEditDialog(b)
  else if (action === 'collections') openCollections(b, menuAnchor)
  else if (action === 'folder') api.showInFolder(b.path).catch(() => toast('File not found', 'error'))
  else if (action === 'reset') { await api.library.upsert(b.path, { cfi: null, fraction: 0, lastOpened: null, chapter: null, finishedAt: null }); refreshLibrary() }
  else if (action === 'remove') {
    if (!confirm(`Remove “${b.title}” from the library?

Its saved copy, reading position, bookmarks and highlights will be deleted.`)) return
    try { await api.library.remove(b.id) }
    catch (e) { console.error(e); return toast(`Couldn’t remove “${b.title}”`, 'error') }
    refreshLibrary(); toast(`Removed “${b.title}”`)
  }
})

// ----- book info: description, publisher, year, length, time spent, highlights
// Details read from the file (and the word count) are kept in the entry's `info`.
const INFO_V = 2
const WORDS_PER_PAGE = 275 // for a page estimate before the book has been paginated
const metaStr = x => Array.isArray(x) ? [...new Set(x.map(metaStr).filter(Boolean))].join(', ')
  : typeof x === 'string' ? x.trim() : x?.name ? metaStr(x.name) : langMap(x)?.trim?.() ?? ''
function descriptionText(html) {
  if (typeof html !== 'string' || !html.trim()) return ''
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n\n').replace(/<\/(p|div|li|h\d)>/gi, '\n\n'), 'text/html')
  return (doc.body.textContent ?? '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim().slice(0, 6000)
}
const findIsbn = m => {
  for (const x of [m?.identifier, ...[m?.altIdentifier ?? []].flat()]) {
    const s = String(typeof x === 'string' ? x : x?.value ?? '').replace(/[-\s]/g, '')
    const hit = s.match(/97[89]\d{10}|\b\d{9}[\dX]\b/)
    if (hit) return hit[0]
  }
  return ''
}
async function countWords(book) {
  let words = 0, read = 0
  for (const s of book.sections ?? []) {
    if (s.linear === 'no' || !s.createDocument) continue
    try {
      const text = (await s.createDocument())?.body?.textContent ?? ''
      words += text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0
      read++
    } catch {}
    if (read % 8 === 0) await wait(0) // keep the window responsive
  }
  return read ? words : null
}
async function readBookDetails(book, format) {
  const m = book.metadata ?? {}
  const series = [m.belongsTo?.series].flat().find(x => x?.name)
  const fixed = format === 'PDF' || format === 'CBZ' || !!book.rendition?.layout?.includes?.('pre-paginated')
  return {
    v: INFO_V,
    description: descriptionText(langMap(m.description)),
    publisher: metaStr(m.publisher),
    published: typeof m.published === 'string' ? m.published.trim() : '',
    language: [m.language].flat().find(x => typeof x === 'string' && x.trim()) ?? '',
    subjects: [m.subject ?? []].flat().map(metaStr).filter(s => s && s.length < 60).slice(0, 8),
    series: series ? metaStr(series.name) + (Number.isFinite(series.position) ? ` #${series.position}` : '') : '',
    isbn: findIsbn(m),
    sections: (book.sections ?? []).length,
    fixedPages: fixed ? (book.sections ?? []).length : null,
    words: fixed && format !== 'PDF' ? null : await countWords(book),
  }
}

let infoBook = null
async function openBookInfo(b) {
  b = libCache[b.id] ?? b
  infoBook = b
  flushReading()
  const [st] = await Promise.all([api.stats.get().catch(() => null)])
  if (st) statsCache = st
  renderBookInfo(b, b.info?.v === INFO_V ? b.info : null)
  const dlg = $('#info-dialog')
  if (!dlg.open) dlg.showModal()
  dlg.focus()
  if (b.info?.v === INFO_V || b.missing) return
  try {
    let info
    if (current?.id === b.id && view?.book) info = await readBookDetails(view.book, b.format)
    else {
      const { book } = await loadFile(b.path)
      try { info = await readBookDetails(book, b.format) } finally { try { book.destroy?.() } catch {} }
    }
    const saved = await api.library.upsert(b.path, { info })
    libCache[saved.id] = saved
    if (infoBook?.id === b.id && dlg.open) renderBookInfo(saved, info)
  } catch (e) {
    console.error('book info', e)
    if (infoBook?.id === b.id) renderBookInfo(b, {})
  }
}

const fmtNum = n => n.toLocaleString()
function publishedText(s) {
  if (!s) return ''
  if (/^\d{4}$/.test(s)) return s
  const d = new Date(s)
  return isNaN(d) || d.getFullYear() < 1000 ? s : /^\d{4}-\d{2}-\d{2}/.test(s) ? dateFmt.format(d) : String(d.getFullYear())
}
const languageName = code => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code } catch { return code } }

// info === null: still reading the file
function renderBookInfo(b, info) {
  const loading = info === null
  info ??= {}
  const isCurrent = current?.id === b.id
  const notes = isCurrent ? annotations : b.annotations ?? []
  const marks = isCurrent ? bookmarks : b.bookmarks ?? []
  const withNote = notes.filter(a => a.note?.trim()).length
  const spent = statsCache?.books?.[b.id] ?? 0
  const layoutPages = b.pagination?.pages?.reduce((s, n) => s + n, 0) || 0

  $('#info-cover').replaceChildren(coverEl(b))
  $('#info-title').textContent = b.title
  $('#info-author').textContent = b.author || 'Unknown author'
  const year = publishedText(info.published).match(/\d{4}/)?.[0]
  $('#info-sub').textContent = [b.format, year, info.language && languageName(info.language)].filter(Boolean).join(' · ')
  const f = b.fraction ?? 0
  $('#info-progress').textContent = b.finishedAt || f >= FINISHED ? `Finished${b.finishedAt ? ' ' + dateFmt.format(b.finishedAt) : ''}`
    : b.lastOpened && f > 0 ? `${pct.format(f)} read · last opened ${dateFmt.format(b.lastOpened)}` : 'Not started'

  // pages: fixed pages for PDFs/comics, the count at your layout once paginated, else an estimate
  const pages = info.fixedPages ? [fmtNum(info.fixedPages), 'pages']
    : layoutPages ? [fmtNum(layoutPages), 'pages', 'at your current text size and layout']
    : info.words ? ['~' + fmtNum(Math.max(1, Math.round(info.words / WORDS_PER_PAGE))), 'pages', `estimated at ${WORDS_PER_PAGE} words a page`]
    : [loading ? '…' : '—', 'pages']
  const words = info.words ? [fmtNum(info.words), 'words'] : [loading ? '…' : '—', 'words', loading ? 'counting…' : info.fixedPages ? 'not available for this format' : '']
  const time = [spent >= 60000 ? fmtDuration(spent) : spent ? '<1 min' : '0 min', 'time spent reading']
  const hl = [fmtNum(notes.length), notes.length === 1 ? 'highlight' : 'highlights',
    [withNote && plural(withNote, 'note'), marks.length && plural(marks.length, 'bookmark')].filter(Boolean).join(' · ')]
  $('#info-stats').replaceChildren(...[pages, words, time, hl].map(([v, label, hint]) =>
    el('div', { class: 'info-stat', title: hint || '' },
      el('div', { class: 'is-val', text: v }), el('div', { class: 'is-label', text: label }),
      hint ? el('div', { class: 'is-hint', text: hint }) : '')))

  const rows = [
    ['Series', info.series], ['Publisher', info.publisher], ['Published', publishedText(info.published)],
    ['Language', info.language && languageName(info.language)], ['Subjects', info.subjects?.join(', ')],
    ['ISBN', info.isbn], ['File', baseName(b.originalPath ?? b.path) + (b.missing ? ' (missing)' : '')],
  ].filter(([, v]) => v)
  $('#info-details').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))

  const desc = $('#info-desc')
  desc.replaceChildren(...(info.description ? info.description.split('\n\n').map(p => el('p', { text: p }))
    : [el('p', { class: 'muted', text: loading ? 'Reading the book…' : 'This book has no description.' })]))
  $('#info-open').textContent = isCurrent ? 'Back to the book' : b.lastOpened && f > 0 && f < FINISHED ? 'Continue reading' : 'Read'
  $('#info-open').disabled = !!b.missing && !isCurrent
}
$('#info-close').onclick = () => $('#info-dialog').close()
$('#info-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() })
$('#info-dialog').addEventListener('keydown', e => e.stopPropagation())
$('#info-dialog').addEventListener('close', () => { infoBook = null; if (current) view?.renderer.focusView?.() })
$('#info-open').onclick = () => {
  const b = infoBook
  $('#info-dialog').close()
  if (b && current?.id !== b.id) openBook(b.path)
}
$('#info-edit').onclick = () => {
  const b = infoBook
  $('#info-dialog').close()
  if (b) openEditDialog(libCache[b.id] ?? b)
}
$('#drawer-info').onclick = () => { if (current) { closePanels(); openBookInfo(libCache[current.id] ?? { ...current }) } }

// ----- edit book details
// Title, author and cover can be changed per book. Edited fields are kept in `custom`
// (and `customCover`) so reopening the book never overwrites them with the file's metadata.
let edit = null // { b, cover, coverCustom, restored, original, busy }

function openEditDialog(b) {
  edit = { b, cover: undefined, coverCustom: !!b.customCover, restored: false, original: null }
  $('#ed-title').value = b.title ?? ''
  $('#ed-author').value = b.author ?? ''
  $('#ed-file').textContent = baseName(b.originalPath ?? b.path)
  $('#ed-restore').disabled = !!b.missing
  showEditCover(b.cover)
  $('#edit-dialog').showModal()
  $('#ed-title').focus()
  $('#ed-title').select()
}
function showEditCover(src) {
  const img = $('#ed-cover-img')
  if (src) img.src = src; else img.removeAttribute('src')
}
async function setEditBusy(on) {
  $('#ed-cover').classList.toggle('busy', on)
  $('#ed-save').disabled = on
}
async function useCoverImage(blob) {
  if (!edit || !blob) return
  if (!/^image\//.test(blob.type || 'image/')) return toast('That file is not an image', 'error')
  setEditBusy(true)
  const url = await thumbFromBlob(blob)
  setEditBusy(false)
  if (!url) return toast('That image could not be read', 'error')
  edit.cover = url
  edit.coverCustom = true
  showEditCover(url)
}
// the book's own title, author and cover, read from the file
async function loadOriginalDetails(b) {
  const { name, data } = await api.readBook(b.path)
  const book = await makeBook(new File([data], name))
  try {
    await fixBookLanguage(book)
    return { ...bookInfo(book, name), cover: await makeThumb(book) }
  } finally { try { book.destroy?.() } catch {} }
}

$('#ed-choose').onclick = async () => {
  try {
    const r = await api.chooseImage()
    if (r) await useCoverImage(new Blob([r.data], { type: imageType(r.name) }))
  } catch (e) { console.error(e); toast(e.message?.includes('too large') ? 'That image is too large' : 'That image could not be opened', 'error') }
}
const imageType = name => {
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase()
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' }[ext] ?? 'image/*'
}
$('#ed-restore').onclick = async () => {
  if (!edit) return
  const st = edit
  setEditBusy(true)
  $('#ed-restore').disabled = true
  try {
    const o = await loadOriginalDetails(st.b)
    if (st !== edit) return
    st.original = o
    st.restored = true
    st.cover = o.cover ?? null
    st.coverCustom = false
    $('#ed-title').value = o.title
    $('#ed-author').value = o.author
    showEditCover(o.cover)
  } catch (e) {
    console.error(e)
    toast('Could not read the book file', 'error')
  } finally {
    setEditBusy(false)
    $('#ed-restore').disabled = false
  }
}
$('#ed-cancel').onclick = () => $('#edit-dialog').close()
$('#edit-dialog').addEventListener('close', () => { edit = null; resetSuggestions() })

$('#edit-form').addEventListener('submit', async e => {
  e.preventDefault()
  if (!edit) return
  const { b } = edit
  const title = $('#ed-title').value.replace(/\s+/g, ' ').trim()
  const author = $('#ed-author').value.replace(/\s+/g, ' ').trim()
  if (!title) return $('#ed-title').focus()
  // remember which fields differ from the book's own metadata
  const custom = edit.restored ? {} : { ...(b.custom ?? {}) }
  const base = edit.restored ? edit.original : b
  if (title !== base.title) custom.title = title
  if (author !== (base.author ?? '')) custom.author = author
  const data = { title, author, custom }
  if (edit.cover !== undefined) {
    data.cover = edit.cover
    data.customCover = edit.coverCustom
    data.coverRes = COVER_RES
    data.spineColor = edit.cover ? await spineColorFrom(edit.cover) : null
  }
  setEditBusy(true)
  try {
    const entry = await api.library.upsert(b.path, data)
    libCache[entry.id] = { ...libCache[entry.id], ...entry }
    if (current?.id === entry.id) { // the same book may still be open behind the library
      Object.assign(current, { title, author })
      document.title = `${title} — Simply Reader`
      $('#book-title').textContent = title
      $('#drawer-title').textContent = title
      $('#drawer-author').textContent = author
      if (entry.cover) $('#drawer-cover').src = entry.cover; else $('#drawer-cover').removeAttribute('src')
    }
    $('#edit-dialog').close()
    renderLibrary()
    toast('Book details saved', '', 1800)
  } catch (err) {
    console.error(err)
    toast('Could not save the changes', 'error')
  } finally { setEditBusy(false) }
})

// drop or paste an image as the new cover (and keep drops away from the book importer)
const editDialog = $('#edit-dialog')
for (const t of ['dragenter', 'dragover', 'dragleave', 'drop']) editDialog.addEventListener(t, e => {
  e.preventDefault()
  e.stopPropagation()
  const over = t === 'dragenter' || t === 'dragover'
  $('#ed-cover').classList.toggle('drop', over)
  if (t === 'drop') useCoverImage([...(e.dataTransfer?.files ?? [])].find(f => f.type.startsWith('image/')))
})
editDialog.addEventListener('paste', e => {
  const file = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'))
  if (file) { e.preventDefault(); useCoverImage(file) }
})
editDialog.addEventListener('keydown', e => e.stopPropagation()) // typing must not trigger app shortcuts

// ----- edit details: suggestions found online (Apple Books, Open Library)
let suggestGen = 0
let suggestURLs = [] // blob URLs of result thumbnails, released when the list changes

// a search phrase from the title and author fields, cleaned of file-name debris
function suggestionQuery() {
  const title = $('#ed-title').value
    .replace(/\.(epub|pdf|mobi|azw3?|fb2|cbz)$/i, '')
    .replace(/_?OceanofPDF\.com_?/gi, ' ')
    .replace(/[_+]+/g, ' ')
    .replace(/\s+[-–—:]\s+/g, ' ')
    .replace(/\s+/g, ' ').trim()
  const author = $('#ed-author').value.trim()
  return { title, author, query: author && !title.toLowerCase().includes(author.toLowerCase()) ? `${title} ${author}` : title }
}
function resetSuggestions() {
  suggestGen++
  for (const u of suggestURLs) URL.revokeObjectURL(u)
  suggestURLs = []
  $('#eds-results').replaceChildren()
  $('#eds-status').textContent = ''
  $('#ed-search').hidden = true
  $('#edit-dialog').classList.remove('with-search')
}
async function coverBlob(url) {
  const r = url ? await api.fetchCoverImage(url) : null
  return r ? new Blob([r.data], { type: r.type }) : null
}

async function searchSuggestions(fromFields) {
  if (!edit) return
  const auto = suggestionQuery()
  if (fromFields) $('#eds-query').value = auto.query
  const query = $('#eds-query').value.trim()
  if (!query) return $('#eds-query').focus()
  const gen = ++suggestGen
  for (const u of suggestURLs) URL.revokeObjectURL(u)
  suggestURLs = []
  $('#ed-search').hidden = false
  $('#edit-dialog').classList.add('with-search')
  $('#eds-results').replaceChildren()
  $('#eds-status').textContent = `Searching for “${query}”…`
  let results
  try {
    // the exact title/author search only makes sense while the box holds the fields' text
    results = await api.searchBookInfo(query === auto.query ? auto : { query })
  } catch (e) {
    console.warn('book search', e)
    if (gen === suggestGen) $('#eds-status').textContent = 'Couldn’t reach Apple Books or Open Library. Check your internet connection.'
    return
  }
  if (gen !== suggestGen || !edit) return
  $('#eds-status').textContent = results.length
    ? 'Choose “Use” to take the title, author and cover, or “Cover only”. You can still edit the fields afterwards.'
    : `Nothing found for “${query}”. Try fewer words, or the book’s original (e.g. English) title.`
  $('#eds-results').replaceChildren(...results.map(r => suggestionItem(r, gen)))
}

function suggestionItem(r, gen) {
  const coverBox = el('div', { class: 'eds-cover' }, el('span', { text: r.thumb ? '…' : 'No cover' }))
  const use = el('button', { type: 'button', class: 'btn primary', text: 'Use', title: 'Use this title, author and cover' })
  const coverOnly = el('button', { type: 'button', class: 'btn ghost', text: 'Cover only', title: 'Use just this cover' })
  coverOnly.hidden = !r.cover
  const item = el('div', { class: 'eds-item' }, coverBox,
    el('div', { class: 'eds-title', text: r.title }),
    el('div', { class: 'eds-sub', text: [r.author, r.year, r.source].filter(Boolean).join(' · ') }),
    el('div', { class: 'eds-actions' }, use, coverOnly))
  if (r.thumb) coverBlob(r.thumb).then(blob => {
    if (gen !== suggestGen) return
    if (!blob) { coverBox.firstChild.textContent = 'No cover'; r.cover = null; coverOnly.hidden = true; return }
    const url = URL.createObjectURL(blob)
    suggestURLs.push(url)
    coverBox.replaceChildren(el('img', { src: url, alt: '' }))
    r.thumbBlob = blob
  }).catch(() => { coverBox.firstChild.textContent = 'No cover' })

  const choose = async withText => {
    if (!edit) return
    $$('.eds-item.chosen').forEach(x => x.classList.remove('chosen'))
    item.classList.add('chosen')
    if (withText) {
      $('#ed-title').value = r.title
      if (r.author) $('#ed-author').value = r.author
    }
    if (!r.cover) return
    setEditBusy(true)
    try {
      // the large cover, or the thumbnail if the large one isn't available
      const blob = (await coverBlob(r.cover).catch(() => null)) ?? r.thumbBlob
      setEditBusy(false)
      if (blob) await useCoverImage(blob)
      else toast('That cover could not be downloaded', 'error')
    } finally { setEditBusy(false) }
  }
  use.onclick = () => choose(true)
  coverOnly.onclick = () => choose(false)
  return item
}

$('#ed-find').onclick = () => searchSuggestions(true)
$('#eds-go').onclick = () => searchSuggestions(false)
$('#eds-query').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); searchSuggestions(false) } // not the dialog's Save
})


// ----- library filters: reading state and the user's collections
let libFilter = 'all'
try { libFilter = localStorage.getItem('libFilter') || 'all' } catch {}
const SMART_FILTERS = {
  all: { name: 'All books', test: () => true },
  reading: { name: 'Reading', test: b => inProgress(b) },
  unread: { name: 'Not started', test: b => !b.lastOpened || (b.fraction ?? 0) === 0 },
  finished: { name: 'Finished', test: b => (b.fraction ?? 0) >= FINISHED },
}
const collectionsOf = b => Array.isArray(b.collections) ? b.collections : []
const allCollections = () => [...new Set(Object.values(libCache).flatMap(collectionsOf))]
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
function activeFilter() {
  if (libFilter.startsWith('c:')) {
    const name = libFilter.slice(2)
    return { name, test: b => collectionsOf(b).includes(name) }
  }
  return SMART_FILTERS[libFilter] ?? SMART_FILTERS.all
}
function setLibFilter(f) {
  libFilter = f
  try { localStorage.setItem('libFilter', f) } catch {}
  shareViewPrefs()
  renderLibrary()
}

function renderFilters() {
  const nav = $('#lib-filters')
  const books = Object.values(libCache)
  nav.hidden = books.length === 0
  if (nav.hidden) return
  const names = allCollections()
  // a collection that no longer has books, or a removed smart filter, falls back to all
  if (libFilter.startsWith('c:') ? !names.includes(libFilter.slice(2)) : !SMART_FILTERS[libFilter]) libFilter = 'all'
  const chip = (key, name, n) => {
    const b = el('button', { class: 'chip' + (libFilter === key ? ' active' : ''), type: 'button', 'aria-pressed': String(libFilter === key) },
      el('span', { text: name }), el('span', { class: 'n', text: String(n) }))
    b.onclick = () => setLibFilter(key)
    return b
  }
  const out = []
  for (const [key, f] of Object.entries(SMART_FILTERS)) {
    const n = books.filter(f.test).length
    if (key === 'all' || n || libFilter === key) out.push(chip(key, f.name, n))
  }
  if (names.length) out.push(el('span', { class: 'chip-sep' }))
  for (const name of names) {
    const c = chip('c:' + name, name, books.filter(b => collectionsOf(b).includes(name)).length)
    c.title = 'Right-click to rename or delete'
    c.oncontextmenu = e => { e.preventDefault(); openChipMenu(name, c, e) }
    out.push(c)
  }
  nav.replaceChildren(...out)
}

// add a book to collections / remove it: a checklist plus a "new collection" field
let collBook = null
function openCollections(b, rect) {
  collBook = b
  $('#cp-title').textContent = `Collections · ${b.title}`
  renderCollectionList()
  $('#cp-input').value = ''
  const pop = $('#coll-pop')
  pop.hidden = false
  const { width, height } = pop.getBoundingClientRect()
  pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px'
  pop.style.top = Math.max(8, Math.min(rect.top, innerHeight - height - 8)) + 'px'
  $('#cp-input').focus()
}
function renderCollectionList() {
  const b = collBook && libCache[collBook.id]
  if (!b) return
  const mine = collectionsOf(b)
  const names = allCollections()
  $('#cp-list').replaceChildren(...(names.length ? names.map(name => {
    const box = el('input', { type: 'checkbox' })
    box.checked = mine.includes(name)
    box.onchange = () => setBookCollections(b, box.checked ? [...mine, name] : mine.filter(x => x !== name))
    return el('label', {}, box, el('span', { text: name }))
  }) : [el('div', { class: 'empty-note', text: 'No collections yet. Name one below, e.g. “To read”.' })]))
}
async function setBookCollections(b, list) {
  const collections = [...new Set(list)]
  const entry = await api.library.upsert(b.path, { collections })
  libCache[entry.id] = { ...libCache[entry.id], ...entry }
  renderCollectionList()
  renderLibrary()
}
async function addNewCollection() {
  const name = $('#cp-input').value.replace(/\s+/g, ' ').trim().slice(0, 60)
  const b = collBook && libCache[collBook.id]
  if (!name || !b) return
  const existing = allCollections().find(x => x.toLowerCase() === name.toLowerCase()) ?? name
  $('#cp-input').value = ''
  await setBookCollections(b, [...collectionsOf(b), existing])
}
$('#cp-add').onclick = addNewCollection
$('#cp-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addNewCollection() }
  else if (e.key === 'Escape') $('#coll-pop').hidden = true
})

// right-click a collection chip: rename or delete it (books stay in the library)
let chipTarget = null
function openChipMenu(name, chipEl, e) {
  chipTarget = { name, chipEl }
  const m = $('#chip-menu')
  m.hidden = false
  const { width, height } = m.getBoundingClientRect()
  m.style.left = Math.min(e.clientX, innerWidth - width - 8) + 'px'
  m.style.top = Math.min(e.clientY, innerHeight - height - 8) + 'px'
}
async function renameCollection(from, to) {
  to = to.replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!to || to === from) return renderLibrary()
  const books = Object.values(libCache).filter(b => collectionsOf(b).includes(from))
  for (const b of books) {
    const entry = await api.library.upsert(b.path, { collections: [...new Set(collectionsOf(b).map(x => x === from ? to : x))] })
    libCache[entry.id] = { ...libCache[entry.id], ...entry }
  }
  if (libFilter === 'c:' + from) libFilter = 'c:' + to
  setLibFilter(libFilter)
}
async function deleteCollection(name) {
  const books = Object.values(libCache).filter(b => collectionsOf(b).includes(name))
  if (!confirm(`Delete the collection “${name}”?\n\nThe ${plural(books.length, 'book')} in it stay in your library.`)) return
  for (const b of books) {
    const entry = await api.library.upsert(b.path, { collections: collectionsOf(b).filter(x => x !== name) })
    libCache[entry.id] = { ...libCache[entry.id], ...entry }
  }
  setLibFilter(libFilter === 'c:' + name ? 'all' : libFilter)
  toast(`Deleted “${name}”`)
}
$('#chip-menu').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.chip
  $('#chip-menu').hidden = true
  if (!act || !chipTarget) return
  const { name, chipEl } = chipTarget
  if (act === 'delete') return deleteCollection(name)
  // rename in place: the chip becomes a text field
  const input = el('input', { class: 'chip-edit', value: name, maxlength: '60', 'aria-label': 'Collection name' })
  chipEl.replaceWith(input)
  input.focus(); input.select()
  let done = false
  const finish = save => { if (done) return; done = true; save ? renameCollection(name, input.value) : renderLibrary() }
  input.addEventListener('keydown', k => {
    if (k.key === 'Enter') { k.preventDefault(); finish(true) }
    else if (k.key === 'Escape') { k.stopPropagation(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
})

// ----- reading statistics
// Time counts while a book is open, the window is visible and the reader has turned a page,
// scrolled or pressed a key in the last few minutes; idle time and other windows don't count.
let statsCache = { days: {}, books: {} }
const READ_TICK = 10000, IDLE_LIMIT = 5 * 60000
let lastReadActivity = 0
let readPending = { ms: 0, pages: 0, day: null, bookId: null }
let readFraction = null
let readPage = null // page number shown when the last page turn happened
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const markReading = () => { lastReadActivity = Date.now() }
for (const t of ['keydown', 'wheel', 'pointerdown']) document.addEventListener(t, () => { if (current) markReading() }, { capture: true, passive: true })

function noteReading(fraction) {
  markReading()
  if (!current) return
  // pages read: from the page numbers when they're known (a two-page spread is two pages),
  // otherwise one per forward page turn; jumps and going back don't count
  const page = currentPageNumber()
  let turnedForward = false
  if (page != null && readPage != null) {
    const diff = page - readPage
    turnedForward = diff > 0 && diff <= 4
    if (turnedForward) addReading(0, diff)
  } else if (page == null && readFraction != null) {
    const step = (fraction - readFraction) * (current.length || 0)
    turnedForward = step > 0 && step < 15000
    if (turnedForward) addReading(0, 1)
  }
  if (page !== readPage || fraction !== readFraction) { readPage = page; readFraction = fraction }
  // remember when a book was finished, once: only when the end is reached by turning pages,
  // not by jumping there (End, the progress slider, the contents, a search result)
  const entry = libCache[current.id]
  if (fraction >= FINISHED && turnedForward && entry && !entry.finishedAt) {
    entry.finishedAt = Date.now()
    api.library.upsert(current.path, { finishedAt: entry.finishedAt })
  }
}
function addReading(ms, pages) {
  const day = dayKey(), bookId = current?.id ?? null
  if (readPending.day && (readPending.day !== day || readPending.bookId !== bookId)) flushReading()
  readPending.day = day
  readPending.bookId = bookId
  readPending.ms += ms
  readPending.pages += pages
  // keep the local copy current so the library shows it without waiting for a save
  const d = (statsCache.days[day] ??= { ms: 0, pages: 0 })
  d.ms += ms; d.pages += pages
  if (bookId) statsCache.books[bookId] = (statsCache.books[bookId] ?? 0) + ms
}
function flushReading() {
  const p = readPending
  readPending = { ms: 0, pages: 0, day: null, bookId: null }
  if (!p.day || (!p.ms && !p.pages)) return undefined
  return api.stats.add(p).catch(e => {
    console.warn('stats', e)
    const r = readPending // put it back, if what's pending now is for the same day and book
    if (!r.day || (r.day === p.day && r.bookId === p.bookId)) Object.assign(r, { day: p.day, bookId: p.bookId, ms: r.ms + p.ms, pages: r.pages + p.pages })
  })
}
setInterval(() => {
  if (!current || document.hidden || document.body.dataset.view !== 'reader') return
  if (Date.now() - lastReadActivity > IDLE_LIMIT) return
  addReading(READ_TICK, 0)
  checkDailyGoal()
}, READ_TICK)
setInterval(flushReading, 60000)
document.addEventListener('visibilitychange', () => { if (document.hidden) flushReading() })

const fmtDuration = ms => {
  const m = Math.round(ms / 60000)
  return m < 1 ? '0 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}
const READ_DAY_MIN = 60000 // a day with at least a minute of reading keeps the streak
function readingStreak() {
  const has = d => (statsCache.days[dayKey(d)]?.ms ?? 0) >= READ_DAY_MIN
  const d = new Date()
  if (!has(d)) d.setDate(d.getDate() - 1) // today isn't over: the streak lives until midnight
  let n = 0
  while (has(d)) { n++; d.setDate(d.getDate() - 1) }
  return n
}

// ----- reading goals: minutes a day and books this year, shown as rings in the stats pop-up
let goals = { dailyMinutes: null, yearBooks: null }
let goalEditing = null // 'daily' | 'year' while its editor is open
const GOAL_DEF = {
  daily: { key: 'dailyMinutes', title: 'Daily goal', unit: 'minutes a day', max: 1440, suggest: 20, presets: [10, 20, 30, 60] },
  year: { key: 'yearBooks', title: 'Yearly goal', unit: 'books', max: 1000, suggest: 24, presets: [12, 24, 52] },
}
const finishedThisYear = (year = new Date().getFullYear()) =>
  Object.values(libCache).filter(b => b.finishedAt && new Date(b.finishedAt).getFullYear() === year).length

function goalRing(fraction, center, label, unit = '', size = '') {
  const NS = 'http://www.w3.org/2000/svg', R = 30, C = 2 * Math.PI * R
  const f = Math.max(0, Math.min(1, fraction))
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 76 76')
  svg.setAttribute('class', 'goal-ring' + (fraction >= 1 ? ' done' : ''))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const circle = cls => {
    const c = document.createElementNS(NS, 'circle')
    for (const [k, v] of Object.entries({ cx: 38, cy: 38, r: R, class: cls })) c.setAttribute(k, v)
    return c
  }
  const track = circle('gr-track'), bar = circle('gr-bar')
  bar.setAttribute('stroke-dasharray', `${C * f} ${C}`)
  if (f === 0) bar.setAttribute('visibility', 'hidden')
  svg.append(track, bar)
  return el('div', { class: 'goal-ring-wrap' + (size ? ' ' + size : '') }, svg,
    el('div', { class: 'gr-center', 'aria-hidden': 'true' }, el('b', { text: center }), unit ? el('small', { text: unit }) : null))
}

// progress toward one goal, or null when it isn't set
function goalStatus(which) {
  const goal = goals[GOAL_DEF[which].key]
  if (!goal) return null
  const now = new Date(), year = now.getFullYear()
  if (which === 'daily') {
    const today = statsCache.days[dayKey()]?.ms ?? 0
    const min = Math.floor(today / 60000)
    // how many of the last 7 days (today included) reached the goal
    let met = 0
    for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(now.getDate() - i); if ((statsCache.days[dayKey(d)]?.ms ?? 0) >= goal * 60000) met++ }
    const done = today >= goal * 60000
    return {
      frac: today / (goal * 60000), center: String(min), unit: 'min',
      line: `${min} of ${goal} min today`, short: `${min} / ${goal} min today`,
      sub: done ? `Goal reached · ${met} of the last 7 days` : `${goal - min} min to go · met ${met} of the last 7 days`,
      subShort: done ? 'Goal reached' : `${goal - min} min to go`,
    }
  }
  const done = finishedThisYear(year)
  const start = new Date(year, 0, 1), end = new Date(year + 1, 0, 1)
  const diff = Math.floor(goal * (now - start) / (end - start)) - done
  const pace = done >= goal ? 'Goal reached' : diff > 0 ? `${plural(diff, 'book')} behind schedule` : diff < 0 ? `${plural(-diff, 'book')} ahead of schedule` : 'On track'
  return {
    frac: done / goal, center: String(done), unit: done === 1 ? 'book' : 'books',
    line: `${done} of ${goal} books in ${year}`, short: `${done} / ${goal} books in ${year}`,
    sub: done >= goal ? 'Goal reached — well done!' : pace, subShort: pace,
  }
}

function renderGoals() {
  const box = $('#st-goals')
  const year = new Date().getFullYear()
  const cards = []
  for (const which of ['daily', 'year']) {
    const def = GOAL_DEF[which], st = goalStatus(which)
    const card = el('div', { class: 'goal-card' })
    if (goalEditing === which) { card.append(goalEditor(which)); cards.push(card); continue }
    if (!st) {
      card.classList.add('empty')
      card.append(goalRing(0, '—', `No ${def.title.toLowerCase()} set`),
        el('div', { class: 'goal-text' },
          el('div', { class: 'goal-title', text: def.title }),
          el('div', { class: 'goal-sub', text: which === 'daily' ? 'Read a little every day' : `Books to finish in ${year}` }),
          goalButton(which, which === 'daily' ? 'Set a daily goal' : 'Set a yearly goal')))
      cards.push(card); continue
    }
    card.append(goalRing(st.frac, st.center, st.line, st.unit),
      el('div', { class: 'goal-text' },
        el('div', { class: 'goal-title', text: def.title }),
        el('div', { class: 'goal-line', text: st.line }),
        el('div', { class: 'goal-sub', text: st.sub }),
        goalButton(which, 'Change goal', true)))
    cards.push(card)
  }
  box.replaceChildren(...cards)
  renderGoalStrip()
}

// the goals beside "Continue reading" in the library; a click opens the stats pop-up
function renderGoalStrip() {
  const strip = $('#goal-strip')
  if (!strip) return
  const items = ['daily', 'year'].map(which => {
    const st = goalStatus(which)
    if (!st) return null
    const item = el('button', { type: 'button', class: 'gs-item', title: `${st.line} · ${st.sub}` },
      goalRing(st.frac, st.center, st.line, '', 'mini'),
      el('div', { class: 'gs-text' },
        el('div', { class: 'gs-title', text: GOAL_DEF[which].title }),
        el('div', { class: 'gs-line', text: st.short }),
        el('div', { class: 'gs-sub' + (st.frac >= 1 ? ' done' : ''), text: st.subShort })))
    item.onclick = openStats
    return item
  }).filter(Boolean)
  if (!items.length) {
    const set = el('button', { type: 'button', class: 'gs-item gs-empty' },
      el('div', { class: 'gs-text' }, el('div', { class: 'gs-line', text: 'Set a reading goal' }),
        el('div', { class: 'gs-sub', text: 'Minutes a day or books a year' })))
    set.onclick = openStats
    items.push(set)
  }
  strip.replaceChildren(...items)
  strip.hidden = !Object.keys(libCache).length
}

function goalButton(which, text, quiet) {
  const b = el('button', { type: 'button', class: quiet ? 'goal-link' : 'btn ghost small goal-set', text })
  b.onclick = () => { goalEditing = which; renderGoals(); $('#goal-input')?.focus(); $('#goal-input')?.select() }
  return b
}
function goalEditor(which) {
  const def = GOAL_DEF[which], cur = goals[def.key]
  const input = el('input', { id: 'goal-input', type: 'number', min: '1', max: String(def.max), step: '1', value: String(cur ?? def.suggest), 'aria-label': def.title })
  const save = async v => {
    const n = Math.round(Number(v))
    if (v !== null && !(n >= 1 && n <= def.max)) { input.setCustomValidity(`Enter a number from 1 to ${def.max}`); input.reportValidity(); return }
    goals = await api.goals.set({ ...goals, [def.key]: v === null ? null : n })
    goalEditing = null
    markGoalIfMet()
    renderGoals(); renderStats()
  }
  const cancel = () => { goalEditing = null; renderGoals() }
  input.oninput = () => input.setCustomValidity('')
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); save(input.value) }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() } // closes the editor, not the pop-up
  }
  const presets = def.presets.map(p => {
    const b = el('button', { type: 'button', class: 'goal-chip' + (p === cur ? ' active' : ''), text: String(p) })
    b.onclick = () => save(p)
    return b
  })
  const btn = (text, cls, fn) => { const b = el('button', { type: 'button', class: cls, text }); b.onclick = fn; return b }
  return el('div', { class: 'goal-editor' },
    el('div', { class: 'goal-title', text: def.title }),
    el('div', { class: 'goal-input-row' }, input, el('span', { class: 'goal-unit', text: which === 'year' ? `books in ${new Date().getFullYear()}` : def.unit })),
    el('div', { class: 'goal-presets' }, ...presets),
    el('div', { class: 'goal-actions' },
      cur ? btn('Remove goal', 'goal-link danger', () => save(null)) : el('span'),
      el('span', { class: 'goal-spacer' }),
      btn('Cancel', 'btn ghost small', cancel),
      btn('Save', 'btn primary small', () => save(input.value))))
}

// a quiet note the moment today's goal is reached while reading
let goalToastDay = null
// a goal already met (when the app starts or the goal is set) gets no toast today
const markGoalIfMet = () => {
  if (goals.dailyMinutes && (statsCache.days[dayKey()]?.ms ?? 0) >= goals.dailyMinutes * 60000) goalToastDay = dayKey()
}
function checkDailyGoal() {
  const g = goals.dailyMinutes
  if (!g || goalToastDay === dayKey()) return
  if ((statsCache.days[dayKey()]?.ms ?? 0) >= g * 60000) {
    goalToastDay = dayKey()
    toast(`Daily goal reached: ${g} minutes of reading today`, '', 5000)
  }
}

function openStats() {
  goalEditing = null
  renderGoals()
  renderStats()
  $('#stats-dialog').showModal()
  $('#stats-dialog').focus() // not the close button, so no focus ring on open
}
$('#lib-stats').onclick = openStats
$('#stats-close').onclick = () => $('#stats-dialog').close()
$('#stats-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() }) // click outside
$('#stats-dialog').addEventListener('keydown', e => e.stopPropagation())

function renderStats() {
  const today = new Date()
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(today); d.setDate(today.getDate() - 13 + i)
    const s = statsCache.days[dayKey(d)] ?? { ms: 0, pages: 0 }
    return { date: d, ms: s.ms ?? 0, pages: s.pages ?? 0 }
  })
  const week = days.slice(-7).reduce((t, d) => t + d.ms, 0)
  const year = today.getFullYear()
  const finished = finishedThisYear(year)
  const streak = readingStreak()
  const tile = (label, value, sub) => el('div', { class: 'st-tile' },
    el('div', { class: 'st-label', text: label }), el('div', { class: 'st-value', text: value }), sub ? el('div', { class: 'st-sub', text: sub }) : null)
  $('#st-tiles').replaceChildren(
    tile('Today', fmtDuration(days.at(-1).ms), days.at(-1).pages ? plural(days.at(-1).pages, 'page') : null),
    tile('Last 7 days', fmtDuration(week)),
    tile('Reading streak', plural(streak, 'day')),
    tile(`Finished in ${year}`, plural(finished, 'book')))

  // one column per day; the tallest day (or the daily goal, if higher) sets the scale
  const goalMs = (goals.dailyMinutes ?? 0) * 60000
  const peak = Math.max(...days.map(d => d.ms), goalMs)
  const fmtDay = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const most = Math.max(...days.map(d => d.ms))
  $('#st-peak').textContent = most >= 60000 ? `Most: ${fmtDuration(most)}` : ''
  $('#st-first').textContent = days[0].date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const tip = $('#st-tip')
  $('#st-bars').setAttribute('aria-label', `Reading time per day for the last 14 days. Today ${fmtDuration(days.at(-1).ms)}, last 7 days ${fmtDuration(week)}.`)
  $('#st-bars').replaceChildren(...days.map(d => {
    const h = peak ? Math.max(4, Math.round(d.ms / peak * 100)) : 0
    const col = el('div', { class: 'st-day' + (d.ms < 60000 ? ' zero' : ''), tabindex: '0' }, el('i', { style: `height:${d.ms < 60000 ? 2 : h}%` }))
    const show = () => {
      tip.replaceChildren(el('b', { text: fmtDay(d.date) }), el('span', { text: [fmtDuration(d.ms), d.pages ? plural(d.pages, 'page') : null].filter(Boolean).join(' · ') }))
      tip.hidden = false
      const c = col.getBoundingClientRect(), p = $('.st-chart').getBoundingClientRect()
      const bar = col.firstChild.getBoundingClientRect()
      tip.style.left = Math.max(60, Math.min(c.left - p.left + c.width / 2, p.width - 60)) + 'px'
      tip.style.top = (Math.min(bar.top, c.bottom - 2) - p.top) + 'px'
    }
    col.onmouseenter = col.onfocus = show
    col.onmouseleave = col.onblur = () => { tip.hidden = true }
    return col
  }))
  if (goalMs) $('#st-bars').append(el('div', { class: 'st-goal-line', style: `bottom:${goalMs / peak * 100}%`, 'aria-hidden': 'true' },
    el('span', { text: `Goal ${goals.dailyMinutes} min` })))
  $('#st-table tbody').replaceChildren(...days.map(d => el('tr', {},
    el('td', { text: fmtDay(d.date) }), el('td', { text: fmtDuration(d.ms) }), el('td', { text: String(d.pages) }))))
}

// ----- backup & restore
// view choices kept in this window's storage travel with the backup
const PREF_KEYS = ['libMode', 'libFilter', 'sort', 'readingSpeed']
function uiPrefs() {
  const out = {}
  try { for (const k of PREF_KEYS) { const v = localStorage.getItem(k); if (v != null) out[k] = v } } catch {}
  return out
}
// keep main's copy current, so automatic backups carry today's view choices
const shareViewPrefs = debounce(() => api.backup.setPrefs(uiPrefs()).catch(console.error), 1000)
const fmtWhen = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtSize = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`

async function openBackupDialog() {
  $('#bk-status').textContent = ''
  await renderBackupInfo()
  $('#backup-dialog').showModal()
  $('#backup-dialog').focus()
}
async function renderBackupInfo(info) {
  info ??= await api.backup.info()
  const empty = !Object.keys(libCache).length // nothing to back up yet, but a backup can be restored
  $('#bk-create').disabled = empty
  $('#bk-last').textContent = empty ? 'Your library is empty, so there is nothing to back up yet.'
    : info.lastAt ? `Last backup: ${fmtWhen(info.lastAt)}` : 'No backup yet'
  $('#bk-last').title = info.lastPath ?? ''
  $('#bk-auto').checked = info.auto && !!info.folder
  $('#bk-folder-path').textContent = info.folder ?? ''
  const note = $('#bk-auto-note')
  note.classList.toggle('error', !!(info.auto && info.error))
  note.textContent = info.auto && info.error ? `The last automatic backup failed: ${info.error}`
    : info.auto && info.lastAutoAt ? `Last automatic backup: ${fmtWhen(info.lastAutoAt)}. The 5 newest are kept.`
    : `Choose ${api.platform === 'win32' ? 'a OneDrive or Dropbox' : 'a Dropbox or Nextcloud'} folder to keep a copy off this computer. The 5 newest automatic backups are kept.`
}
async function backupBusy(text, job) {
  const dlg = $('#backup-dialog')
  dlg.classList.add('busy')
  $('#bk-status').textContent = text
  try { return await job() }
  catch (e) {
    console.error(e)
    $('#bk-status').textContent = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    return undefined
  } finally { dlg.classList.remove('busy') }
}

$('#lib-backup').onclick = openBackupDialog
// empty library: "Restore a backup" goes straight to choosing the file
$('[data-action="restore"]').onclick = async () => { await openBackupDialog(); $('#bk-restore').click() }
$('#bk-close').onclick = () => $('#backup-dialog').close()
$('#backup-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() })
$('#backup-dialog').addEventListener('keydown', e => e.stopPropagation())

$('#bk-create').onclick = () => backupBusy('Saving the backup…', async () => {
  await flushPosition()
  await flushBookPrefs() // a setting changed a moment ago
  flushReading()
  const r = await api.backup.create(uiPrefs())
  if (!r) { $('#bk-status').textContent = ''; return }
  await renderBackupInfo()
  $('#bk-status').textContent = `Saved ${plural(r.books, 'book')} (${fmtSize(r.size)}) to ${r.path}`
})
$('#bk-folder').onclick = () => backupBusy('Backing up to the folder…', async () => {
  await renderBackupInfo(await api.backup.auto({ chooseFolder: true }))
  $('#bk-status').textContent = ''
})
$('#bk-auto').onchange = e => backupBusy(e.target.checked ? 'Backing up to the folder…' : '', async () => {
  const want = e.target.checked
  const info = await api.backup.auto(want && !(await api.backup.info()).folder ? { chooseFolder: true } : { enable: want })
  await renderBackupInfo(info)
  $('#bk-status').textContent = ''
})
$('#bk-folder-path').onclick = () => api.backup.show('folder')
$('#bk-last').onclick = () => api.backup.show('last')
$('#bk-safety').onclick = () => api.backup.show('safety')

$('#bk-restore').onclick = () => backupBusy('Reading the backup…', async () => {
  const pick = await api.backup.pick()
  if (!pick) { $('#bk-status').textContent = ''; return }
  const now = Object.keys(libCache).length
  const when = pick.created ? ` from ${fmtWhen(pick.created)}` : ''
  // an empty library has nothing to lose, so don't ask
  const question = api.platform === 'android'
    ? `Replace this device’s library with the backup${when} (${plural(pick.books, 'book')})?\n\nThe library here (${plural(now, 'book')}) is replaced, not merged: its reading progress, highlights and notes are replaced too. A copy of it is saved first.`
    : `Restore the backup${when} with ${plural(pick.books, 'book')}?\n\nIt replaces your current library (${plural(now, 'book')}). A copy of the current library is saved first, so you can go back to it.`
  if (now && !confirm(question)) {
    $('#bk-status').textContent = ''
    return
  }
  $('#bk-status').textContent = 'Restoring…'
  restoring = true
  await closeBook()
  flushReading()
  let r
  try { r = await api.backup.restore(pick.path) }
  finally { if (!r) restoring = false } // failed: the library is still the one shown
  try {
    for (const k of PREF_KEYS) localStorage.removeItem(k)
    for (const [k, v] of Object.entries(r.prefs ?? {})) if (PREF_KEYS.includes(k) && typeof v === 'string') localStorage.setItem(k, v)
    sessionStorage.setItem('restored', `Restored ${plural(r.books, 'book')} from the backup`)
  } catch {}
  location.reload() // start fresh from the restored library and settings
})

async function importPaths(paths) {
  const ids = await Promise.all(paths.map(p => api.bookId(p).catch(() => null)))
  const todo = paths.filter((p, i) => ids[i] && !libCache[ids[i]])
  let ok = 0, failed = 0
  for (const [i, p] of todo.entries()) {
    showLoading(`Importing ${i + 1} of ${todo.length}…\n${baseName(p)}`)
    try {
      const { name, book } = await loadFile(p)
      await api.library.upsert(p, { ...bookInfo(book, name), ...await coverFields(book) })
      book.destroy?.()
      ok++
    } catch (e) {
      console.error(p, e)
      failed++
    }
  }
  hideLoading()
  await refreshLibrary()
  const skipped = paths.length - todo.length
  toast([`Added ${plural(ok, 'book')}`, skipped && `${skipped} already in library`, failed && `${failed} couldn't be read`]
    .filter(Boolean).join(' · '), failed ? 'error' : '')
}

// copy books into the library's own folder so they don't depend on where they came from
async function storePaths(paths) {
  showLoading(paths.length === 1 ? `Adding to library…
${baseName(paths[0])}` : `Adding ${paths.length} books to library…`)
  try { return await api.storeBooks(paths) }
  catch (e) { console.error(e); return paths }
  finally { hideLoading() }
}

async function handlePaths(paths) {
  paths = paths.filter(p => SUPPORTED.test(p))
  if (!paths.length) return toast('No supported files (EPUB, MOBI, AZW3, PDF, FB2, CBZ)', 'error')
  paths = await storePaths(paths)
  if (paths.length === 1) return openBook(paths[0])
  return importPaths(paths)
}

// ---------------------------------------------------------------- reader
let view = null
let current = null // { path, id, title, author }
let lastLoc = null
let annotations = []
let bookmarks = []

function showView(name) {
  document.body.dataset.view = name
  if (name === 'library') document.title = 'Simply Reader'
}

async function openBook(path) {
  if (current?.path === path && view) return showView('reader')
  await closeBook()
  showLoading('Opening…')
  try {
    const [id, { name, file, book }] = await Promise.all([api.bookId(path), loadFile(path)])
    // titles and authors edited by the user win over the book's own metadata
    const info = { ...bookInfo(book, name), ...libCache[id]?.custom }
    const extra = await coverFields(book, libCache[id])
    const entry = await api.library.upsert(path, { ...info, lastOpened: Date.now(), ...extra })
    libCache[entry.id] = entry
    current = { path, id: entry.id, file, ...info }
    pagerCache = new Map()
    pager = null
    if (entry.pagination?.key) pagerCache.set(entry.pagination.key, entry.pagination.pages)
    annotations = (entry.annotations ?? []).map(a => ({ ...a }))
    bookmarks = entry.bookmarks ?? []
    bookPrefs = pickBookPrefs(entry.prefs) // this book's own font size, margins, zoom…
    mergeSettings()

    view = document.createElement('foliate-view')
    $('#view-host').append(view)
    book.transformTarget?.addEventListener('data', ({ detail }) => {
      detail.data = Promise.resolve(detail.data).catch(e => {
        console.error(new Error(`Failed to load ${detail.name}`, { cause: e }))
        return ''
      })
    })
    await view.open(book)
    document.body.classList.toggle('fxl', view.isFixedLayout)
    document.body.classList.toggle('is-pdf', info.format === 'PDF')
    view.addEventListener('relocate', onRelocate)
    view.addEventListener('load', onDocLoad)
    view.addEventListener('create-overlay', e => {
      for (const a of annotations) if (a.index === e.detail.index) view.addAnnotation(a)
    })
    view.addEventListener('draw-annotation', e => {
      const { draw, annotation } = e.detail
      draw(drawAnnotation, { color: HL[annotation.color] ?? HL.yellow, note: !!annotation.note })
    })
    view.addEventListener('show-annotation', onShowAnnotation)
    view.addEventListener('link', onLink)
    view.history.addEventListener('index-change', () => {
      $('#history-back').hidden = !(linkFollowed && view.history.canGoBack)
    })
    for (const a of annotations) {
      try { a.index = view.resolveNavigation(a.value)?.index } catch { a.index = -1 }
    }

    // header / drawer
    document.title = `${info.title} — Simply Reader`
    $('#book-title').textContent = info.title
    $('#chapter-title').textContent = info.author
    $('#drawer-title').textContent = info.title
    $('#drawer-author').textContent = info.author
    if (entry.cover) $('#drawer-cover').src = entry.cover; else $('#drawer-cover').removeAttribute('src')
    renderTOC(book.toc)
    renderBookmarks()
    renderHighlights()

    applySettings()
    showView('reader')
    await view.init({ lastLocation: entry.cfi || null })
    schedulePagination(300)
    view.renderer.focusView?.()
  } catch (e) {
    console.error(e)
    await closeBook()
    showView('library')
    const msg = /not supported/i.test(e.message) ? 'This file type is not supported'
      : /drm|encrypt/i.test(e.message) ? 'This book is DRM-protected and cannot be opened'
      : e.message
    toast(`Couldn't open ${baseName(path)}: ${msg}`, 'error', 6000)
    refreshLibrary()
  } finally {
    hideLoading()
  }
}

let linkFollowed = false
$('#history-back').onclick = () => {
  view?.history.back()
  if (!view?.history.canGoBack) linkFollowed = false
  $('#history-back').hidden = true
}

async function closeBook() {
  hidePopovers(); closePanels(); closeImageViewer()
  await flushBookPrefs()
  if (bookPrefs && Object.keys(bookPrefs).length) { bookPrefs = {}; mergeSettings() }
  if (!view) return
  pageAnim?.finish()
  flushReading()
  readFraction = null; readPage = null
  await flushPosition()
  try { view.close() } catch (e) { console.error(e) }
  view.remove()
  view = null; current = null; lastLoc = null; annotations = []; bookmarks = []; linkFollowed = false
  pagerJob++; pager = null; pagerCache = new Map(); clearTimeout(pagerTimer)
  fxlLayers = []
  document.body.classList.remove('fxl', 'is-pdf')
  $('#history-back').hidden = true
  searchGen++
  $('#search-results').replaceChildren(); $('#search-status').textContent = ''; $('#search-input').value = ''
}

async function backToLibrary() {
  await closeBook()
  showView('library')
  await refreshLibrary()
}

// ----- position persistence
let pendingPos = null
const flushPositionSoon = debounce(flushPosition, 700)
function queuePosition(data) {
  pendingPos = { path: current.path, data }
  flushPositionSoon()
}
async function flushPosition() {
  flushPositionSoon.cancel()
  if (!pendingPos) return
  const p = pendingPos
  pendingPos = null
  try {
    const entry = await api.library.upsert(p.path, p.data)
    libCache[entry.id] = entry
  } catch (e) {
    console.error('position not saved', e)
    if (!/not found/i.test(e?.message)) pendingPos ??= p // tried again with the next save
  }
}
// highlights, notes and bookmarks: a failed save is kept and tried again (flushNotes)
let notesPending = null
function persistNotes() {
  if (!current) return undefined
  notesPending = { path: current.path, data: { annotations: annotations.map(({ index, ...a }) => a), bookmarks: [...bookmarks] } }
  return flushNotes()
}
function flushNotes() {
  const p = notesPending
  notesPending = null
  return p ? api.library.upsert(p.path, p.data).catch(e => {
    console.error('notes not saved', e)
    if (!notesPending) { notesPending = p; toast('Couldn’t save your notes. They’ll be saved again shortly.', 'error', 5000) }
  }) : undefined
}
// everything pending, e.g. when the app goes to the background: Android may stop it any time after
function flushAll() {
  return Promise.allSettled([flushPosition(), flushBookPrefs(), flushSettings(), flushNotes(), flushReading()])
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll() })
api.onPause?.(flushAll)
window.addEventListener('beforeunload', () => { if (pendingPos) api.library.upsert(pendingPos.path, pendingPos.data); flushReading() })

// ----- relocation
let sliderDragging = false
const fmtMin = m => m < 1 ? '< 1 min' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`

function onRelocate(e) {
  const d = e.detail
  lastLoc = d
  const { fraction = 0, tocItem, time } = d
  if (!sliderDragging) $('#progress').value = fraction
  $('#chapter-title').textContent = tocItem?.label?.trim() || current?.author || ''
  updatePageNumbers()
  sampleReadingSpeed(fraction)
  noteReading(fraction)
  showTimeLeft(fraction, time)
  closeFootnote()
  hideLookup()
  setCurrentTOC(tocItem?.href)
  updateBookmarkButton()
  if ($('#sel-pop').dataset.mode !== 'new') hideSelPop()
  if (current) queuePosition({ cfi: d.cfi, fraction, chapter: tocItem?.label?.trim() ?? null, lastOpened: Date.now() })
}

// ----- page numbers
// Real page numbers need every chapter laid out exactly like the visible reader.
// A hidden copy of the book with the same size and styles counts each chapter's
// pages in the background; results are cached per layout and saved with the book.
let pager = null          // { key, pages: [per section], starts: [], total, complete, progress }
let pagerCache = new Map() // layout key -> pages array (this book only)
let pagerJob = 0
let pagerTimer = null
const wait = ms => new Promise(r => setTimeout(r, ms))

function layoutKey() {
  const r = $('#stage').getBoundingClientRect()
  return JSON.stringify(['cols', Math.round(r.width), Math.round(r.height), S.fontFamily, S.fontSize,
    S.lineHeight, S.gap, S.maxWidth, S.columns, S.justify, S.hyphenate])
}

// Pages a section really fills. A chapter that ends in the left column of a two-page
// spread leaves the right column blank; counting whole spreads would turn that blank
// into a page and push every later page number up by one.
function sectionPages(r, doc, perSpread) {
  const spreads = Math.max(1, r.pages - 2)
  const max = spreads * perSpread
  if (perSpread < 2 || !doc?.body || r.getAttribute('flow') === 'scrolled') return max
  try {
    const vertical = doc.defaultView.getComputedStyle(doc.body).writingMode.startsWith('vertical')
    if (vertical) return max
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    const rects = [...range.getClientRects()].filter(x => x.width > 0 && x.height > 0)
    if (!rects.length) return max
    const root = doc.documentElement.getBoundingClientRect()
    const rtl = r.getAttribute('dir') === 'rtl'
    const extent = Math.max(...rects.map(x => rtl ? root.right - x.left : x.right - root.left))
    const pitch = r.size / perSpread // one column plus its gap
    const used = Math.ceil(extent / pitch - 0.01)
    return Math.min(max, Math.max((spreads - 1) * perSpread + 1, used))
  } catch { return max }
}

function setPager(key, pages, complete, progress = 1) {
  const starts = []
  let sum = 0
  for (const n of pages) { starts.push(sum); sum += n }
  pager = { key, pages, starts, total: sum, complete, progress }
}

function schedulePagination(delay = 600) {
  clearTimeout(pagerTimer)
  if (!view || !S.pageNumbers || S.flow !== 'paginated' || view.isFixedLayout) { updatePageNumbers(); return }
  pagerTimer = setTimeout(runPagination, delay)
}

async function runPagination() {
  if (!view || !current) return
  const key = layoutKey()
  if (pager?.key === key && pager.complete) return updatePageNumbers()
  const cached = pagerCache.get(key)
  if (cached?.length === view.book.sections.length) { setPager(key, cached, true); return updatePageNumbers() }

  const job = ++pagerJob
  const sections = view.book.sections
  const pages = sections.map(() => 0)
  setPager(key, pages, false, 0)
  updatePageNumbers()

  const r = $('#stage').getBoundingClientRect()
  const host = el('div', { 'aria-hidden': 'true' })
  host.style.cssText = `position:fixed;left:-40000px;top:0;width:${r.width}px;height:${r.height}px;visibility:hidden;pointer-events:none;contain:strict;`
  document.body.append(host)
  let book, p
  try {
    book = await makeBook(current.file) // separate instance so the visible reader is never disturbed
    p = document.createElement('foliate-paginator')
    configureRenderer(p, 'paginated') // styles are stored and applied once a section loads
    host.append(p)
    p.open(book)
    for (const [i, section] of sections.entries()) {
      // never compete with a page turn for the main thread
      while ((pageAnim || pageCapturing) && job === pagerJob) await wait(60)
      if (job !== pagerJob) return
      if (section.linear === 'no' || !book.sections[i]?.load) continue
      await p.goTo({ index: i })
      const doc = p.getContents()[0]?.doc
      if (doc) {
        // off-screen frames don't load web fonts on their own; load them explicitly
        // (bundled + book-embedded), then re-lay-out so the count uses the real font
        const pendingFonts = [...(doc.fonts ?? [])].filter(f => f.status !== 'loaded')
        await Promise.race([
          Promise.all([
            ...[...doc.images].filter(img => !img.complete).map(img => img.decode().catch(() => {})),
            ...pendingFonts.map(f => f.load().catch(() => {})),
          ]),
          wait(1500),
        ])
        if (pendingFonts.length) p.render()
      }
      await nextFrame(); await nextFrame()
      if (job !== pagerJob) return
      const perSpread = p.feet?.length || 1
      pages[i] = sectionPages(p, p.getContents()[0]?.doc, perSpread)
      pager.progress = (i + 1) / sections.length
      if (i % 4 === 0) updatePageNumbers()
      await wait(0)
    }
    if (job !== pagerJob) return
    pagerCache.set(key, pages)
    setPager(key, pages, true)
    updatePageNumbers()
    api.library.upsert(current.path, { pagination: { key, pages } })
  } catch (e) {
    console.error('pagination failed', e)
    if (job === pagerJob) pager = null
    updatePageNumbers()
  } finally {
    try { p?.destroy() } catch {}
    host.remove()
    try { book?.destroy?.() } catch {}
  }
}

function updatePageNumbers() {
  const r = view?.renderer
  const feet = r?.feet ?? []
  const loc = lastLoc
  const left = $('#loc-left')
  const fallback = () => {
    left.textContent = loc?.pageItem ? `Page ${loc.pageItem.label}`
      : loc?.location ? `Loc ${loc.location.current + 1} of ${loc.location.total}` : ''
  }
  // fixed-layout books (PDFs, comics): one page per section, so the page is always known
  if (view?.isFixedLayout) {
    const i = loc?.section?.current
    left.textContent = i != null ? `Page ${i + 1} of ${view.book.sections.length}` : ''
    return
  }
  const on = S.pageNumbers && S.flow === 'paginated' && !!loc
  if (!on) { for (const f of feet) f.textContent = ''; return fallback() }

  const index = r.getContents?.()[0]?.index
  if (!pager?.complete || pager.key !== layoutKey() || index == null) {
    for (const f of feet) f.textContent = ''
    if (pager && !pager.complete) left.textContent = `Counting pages… ${pct.format(pager.progress)}`
    else fallback()
    return
  }
  const perSpread = feet.length || 1
  const textSpreads = Math.max(1, r.pages - 2)
  // the visible reader is the final word on its own chapter: correct the count if it differs
  const actual = sectionPages(r, r.getContents()[0]?.doc, perSpread)
  if (pager.pages[index] !== actual && pager.pages[index] > 0) {
    pager.pages[index] = actual
    setPager(pager.key, pager.pages, true)
    pagerCache.set(pager.key, pager.pages)
    savePaginationSoon(current.path, { key: pager.key, pages: pager.pages })
  }
  const spread = Math.min(Math.max(0, r.page - 1), textSpreads - 1)
  const first = pager.starts[index] + spread * perSpread + 1
  // columns of this spread that hold text (the last spread of a chapter may be half blank)
  const shown = Math.min(perSpread, pager.starts[index] + pager.pages[index] - first + 1)
  feet.forEach((f, c) => { f.textContent = c < shown && first + c <= pager.total ? String(first + c) : '' })
  const last = Math.min(first + Math.max(1, shown) - 1, pager.total)
  left.textContent = `Page ${first}${last > first ? '–' + last : ''} of ${pager.total}`
}

const savePaginationSoon = debounce((path, pagination) => api.library.upsert(path, { pagination }), 2000)

new ResizeObserver(() => { if (view) schedulePagination(700) }).observe($('#stage'))

// ----- image viewer: click a picture in a book (a map, diagram, illustration) to see it
// full screen. Wheel, +/− or double-click zoom; drag to pan; Esc or a click outside closes.
const iv = { s: 1, fit: 1, cap: 2, min: 1, max: 4, x: 0, y: 0, w: 0, h: 0, url: null, drag: null }
const ivStage = $('#iv-stage'), ivImg = $('#iv-img')

// the picture under a click, or null for small ornaments and pictures that are links
function zoomableImage(target) {
  let el = target?.closest?.('img, image, svg')
  if (!el || el.closest('a[href]')) return null
  if (el.localName === 'svg' && el.querySelectorAll('image').length === 1) el = el.querySelector('image')
  const r = el.getBoundingClientRect()
  return r.width >= 64 || r.height >= 64 ? el : null
}
function imageSource(el, doc) {
  const alt = el.getAttribute('alt') || el.closest('svg')?.getAttribute('aria-label') || ''
  const caption = (el.closest('figure')?.querySelector('figcaption')?.textContent ?? '').trim().replace(/\s+/g, ' ')
  if (el.localName === 'img') return { src: el.currentSrc || el.src, caption: caption || alt }
  if (el.localName === 'image') {
    const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    return href ? { src: new URL(href, doc.baseURI).href, caption: caption || alt } : null
  }
  // an inline drawing: copy it into a standalone SVG file sized as it is on the page
  const r = el.getBoundingClientRect()
  const svg = el.cloneNode(true)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`)
  svg.setAttribute('width', r.width); svg.setAttribute('height', r.height)
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
  return { src: url, own: true, caption: caption || alt, w: r.width, h: r.height }
}

async function openImageViewer(el, doc) {
  const src = imageSource(el, doc)
  if (!src) return
  hidePopovers()
  const dlg = $('#img-viewer')
  ivImg.removeAttribute('style')
  ivImg.src = src.src
  iv.url = src.own ? src.src : null
  $('#iv-caption').textContent = src.caption
  dlg.showModal()
  dlg.focus()
  try { await ivImg.decode() } catch { if (!ivImg.naturalWidth) { closeImageViewer(); toast("This picture couldn't be shown", 'error'); return } }
  const vector = /svg/.test(src.src) || src.own
  const page = el.getBoundingClientRect()
  iv.w = ivImg.naturalWidth || src.w || page.width
  iv.h = ivImg.naturalHeight || src.h || page.height
  const { width: W, height: H } = ivStage.getBoundingClientRect()
  // fit the screen; small raster pictures are enlarged at most 2×, drawings as much as fits
  iv.cap = vector ? 12 : 2
  iv.fit = Math.min((W - 48) / iv.w, (H - 110) / iv.h, iv.cap)
  iv.min = Math.min(iv.fit, 1)
  iv.max = Math.max(iv.fit * 8, vector ? iv.fit * 8 : 4)
  ivFit(false)
}
function closeImageViewer() {
  const dlg = $('#img-viewer')
  if (dlg.open) dlg.close()
}
$('#img-viewer').addEventListener('close', () => {
  ivImg.removeAttribute('src')
  if (iv.url) URL.revokeObjectURL(iv.url)
  iv.url = null; iv.drag = null
  view?.renderer.focusView?.()
})

function ivRender(animate) {
  ivImg.classList.toggle('anim', !!animate)
  const { width: W, height: H } = ivStage.getBoundingClientRect()
  const cw = iv.w * iv.s, ch = iv.h * iv.s
  // a picture smaller than the screen stays centred; a bigger one can't be dragged off screen
  iv.x = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, iv.x))
  iv.y = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, iv.y))
  ivImg.style.width = cw + 'px'
  ivImg.style.height = ch + 'px'
  ivImg.style.transform = `translate(${iv.x}px, ${iv.y}px)`
  $('#iv-pct').textContent = Math.round(iv.s * 100) + '%'
  ivStage.classList.toggle('zoomed', iv.s > iv.fit * 1.01)
  $('#iv-out').disabled = iv.s <= iv.min * 1.001
  $('#iv-in').disabled = iv.s >= iv.max * 0.999
}
function ivZoomTo(s, cx, cy, animate) {
  const { width: W, height: H } = ivStage.getBoundingClientRect()
  cx ??= W / 2; cy ??= H / 2
  s = Math.min(iv.max, Math.max(iv.min, s))
  iv.x = cx - (cx - iv.x) * (s / iv.s) // keep the point under the cursor in place
  iv.y = cy - (cy - iv.y) * (s / iv.s)
  iv.s = s
  ivRender(animate)
}
function ivFit(animate = true) { iv.s = iv.fit; ivRender(animate) }
const IV_STEP = 1.4

ivStage.addEventListener('wheel', e => {
  e.preventDefault()
  const r = ivStage.getBoundingClientRect()
  const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
  ivZoomTo(iv.s * Math.exp(-d * 0.0022), e.clientX - r.left, e.clientY - r.top)
}, { passive: false })
ivStage.addEventListener('dblclick', e => {
  const r = ivStage.getBoundingClientRect()
  if (iv.s > iv.fit * 1.01) ivFit()
  else ivZoomTo(Math.max(iv.fit * 2.5, Math.min(1, iv.max)), e.clientX - r.left, e.clientY - r.top, true)
})
ivStage.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  iv.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: iv.x, oy: iv.y, moved: false }
  ivStage.setPointerCapture(e.pointerId)
})
ivStage.addEventListener('pointermove', e => {
  const d = iv.drag
  if (!d || d.id !== e.pointerId) return
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
  d.moved = true
  ivStage.classList.add('dragging')
  iv.x = d.ox + e.clientX - d.x
  iv.y = d.oy + e.clientY - d.y
  ivRender(false)
})
ivStage.addEventListener('pointerup', e => {
  const d = iv.drag
  if (!d || d.id !== e.pointerId) return
  iv.drag = null
  ivStage.classList.remove('dragging')
  // a plain click beside the picture closes the viewer
  if (!d.moved && e.target !== ivImg && e.detail < 2) setTimeout(() => { if (!iv.drag) closeImageViewer() }, 0)
})
ivStage.addEventListener('pointercancel', () => { iv.drag = null; ivStage.classList.remove('dragging') })
$('#iv-in').onclick = () => ivZoomTo(iv.s * IV_STEP, undefined, undefined, true)
$('#iv-out').onclick = () => ivZoomTo(iv.s / IV_STEP, undefined, undefined, true)
$('#iv-pct').onclick = () => ivFit()
$('#iv-close').onclick = closeImageViewer
$('#img-viewer').addEventListener('keydown', e => {
  e.stopPropagation() // the book underneath shouldn't turn pages
  const k = e.key, pan = 80
  if (k === '+' || k === '=') ivZoomTo(iv.s * IV_STEP, undefined, undefined, true)
  else if (k === '-' || k === '_') ivZoomTo(iv.s / IV_STEP, undefined, undefined, true)
  else if (k === '0') ivFit()
  else if (k === 'ArrowLeft') { iv.x += pan; ivRender(true) }
  else if (k === 'ArrowRight') { iv.x -= pan; ivRender(true) }
  else if (k === 'ArrowUp') { iv.y += pan; ivRender(true) }
  else if (k === 'ArrowDown') { iv.y -= pan; ivRender(true) }
  else return
  e.preventDefault()
})
addEventListener('resize', () => {
  if (!$('#img-viewer').open || !iv.w) return
  const atFit = iv.s <= iv.fit * 1.01
  const { width: W, height: H } = ivStage.getBoundingClientRect()
  iv.fit = Math.min((W - 48) / iv.w, (H - 110) / iv.h, iv.cap)
  iv.min = Math.min(iv.fit, 1)
  if (atFit) iv.s = iv.fit
  ivRender(false)
})

function hookBookImages(doc) {
  doc.addEventListener('pointerover', e => {
    const el = zoomableImage(e.target)
    if (el && !el.style.cursor) el.style.cursor = 'zoom-in'
  })
  // runs before the page-turn click handler; preventDefault stops the page turning
  doc.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || suppressClick || anyOverlayOpen()) return
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) return
    const el = zoomableImage(e.target)
    if (!el) return
    e.preventDefault()
    openImageViewer(el, doc)
  })
}

// ----- per-section document hooks
function frameOffset(doc) {
  const r = doc.defaultView?.frameElement?.getBoundingClientRect()
  return r ? { x: r.left, y: r.top } : { x: 0, y: 0 }
}

function onDocLoad({ detail: { doc, index } }) {
  if (view?.isFixedLayout) attachFxlLayer(doc, index)
  else hookBookImages(doc)
  doc.addEventListener('keydown', handleKey)
  doc.addEventListener('wheel', handleWheel, { passive: false })
  doc.addEventListener('click', e => handleDocClick(e, doc))
  doc.addEventListener('pointerup', () => checkSelection(doc, index))
  doc.addEventListener('keyup', e => { if (e.shiftKey) checkSelection(doc, index) })
  doc.addEventListener('pointerdown', () => {
    if (noteEdit) closeNoteEditor(true)
    const sel = doc.getSelection()
    suppressClick = anyOverlayOpen() || !!(sel && !sel.isCollapsed)
    hideSelPop(); closeFootnote(); hideLookup(); hideGoto()
  })
  doc.addEventListener('mousemove', e => {
    if (!$('#reader').classList.contains('immersive')) return
    const y = frameOffset(doc).y + e.clientY
    revealBars(y < 70 || y > innerHeight - 70)
  })
  doc.addEventListener('dragover', e => e.preventDefault())
  doc.addEventListener('drop', onDrop)
  doc.addEventListener('contextmenu', e => {
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed) { e.preventDefault(); checkSelection(doc, index) }
  })
}

let annotationClicked = false
let suppressClick = false
function handleDocClick(e, doc) {
  if (e.defaultPrevented || e.button !== 0) return
  const sel = doc.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().trim()) return
  setTimeout(() => {
    if (annotationClicked) { annotationClicked = false; return }
    if (suppressClick || anyOverlayOpen()) { suppressClick = false; hidePopovers(); closePanels(); return }
    const x = frameOffset(doc).x + e.clientX
    const r = view.getBoundingClientRect()
    const rel = (x - r.left) / r.width
    if (S.flow === 'paginated' && rel < 0.22) turnPage('left')
    else if (S.flow === 'paginated' && rel > 0.78) turnPage('right')
    else toggleImmersive()
  }, 0)
}

let wheelLastEvent = 0, wheelLastFire = 0
function handleWheel(e) {
  if (!view) return
  if (e.ctrlKey) { // Ctrl + wheel: zoom pages / resize text
    e.preventDefault()
    const now = performance.now()
    if (now - wheelLastFire < 120) return
    wheelLastFire = now
    return zoomBy(e.deltaY < 0 ? 1 : -1)
  }
  // zoomed-in PDF pages scroll with the wheel; arrow keys still turn pages
  if (view.isFixedLayout && S.pdfZoom !== 'fit-page') return
  if (S.flow !== 'paginated') return
  e.preventDefault()
  const now = performance.now()
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
  const newGesture = now - wheelLastEvent > 180
  wheelLastEvent = now
  if (Math.abs(delta) < 2) return
  if (!newGesture && now - wheelLastFire < 450) return
  wheelLastFire = now
  turnNext(delta > 0)
}

// ----- progress footer: hidden until hovered, or always shown (toggle in the top bar)
function syncFooterButton() {
  const auto = !!S.footerAuto
  $('#reader').classList.toggle('footer-auto', auto)
  const b = $('#btn-footer')
  b.classList.toggle('on', !auto)
  b.setAttribute('aria-pressed', String(!auto))
  b.title = auto ? 'Show the progress bar all the time' : 'Hide the progress bar (it appears when you point at the bottom)'
}
$('#btn-footer').onclick = () => setSetting('footerAuto', !S.footerAuto)

// ----- page turn animation
// The current page is captured as an image and laid over the reader; the book moves
// to the new page underneath, then the image is animated away (3D flip or slide).
let pageAnim = null      // running animation: { finish() }
let pageCapturing = false
// Chromium stops animation frames while the window is hidden or covered by other
// windows; never wait on one forever
const nextFrame = () => new Promise(r => {
  const t = setTimeout(r, 100)
  requestAnimationFrame(() => { clearTimeout(t); r() })
})
const navSide = side => side === 'right' ? view.goRight() : view.goLeft()
const turnNext = forward => turnPage((view?.book?.dir === 'rtl') === forward ? 'left' : 'right')

// the paginator renders one footer slot per visible column
const isSpread = () => !view.isFixedLayout && (view.renderer.feet?.length ?? 1) > 1

// resolves true once the view has moved and painted, false if it did not move (start/end of book)
function navigateAndSettle(side) {
  return new Promise(resolve => {
    const before = lastLoc?.cfi
    let settled = false
    const done = moved => {
      if (settled) return
      settled = true
      view?.removeEventListener('relocate', onRelocate)
      clearTimeout(timer)
      resolve(moved)
    }
    const onRelocate = () => nextFrame().then(nextFrame).then(() => done(true))
    view.addEventListener('relocate', onRelocate)
    const timer = setTimeout(() => done(lastLoc?.cfi !== before), 2000)
    Promise.resolve(navSide(side)).then(() => setTimeout(() => done(lastLoc?.cfi !== before), 30))
  })
}

async function turnPage(side) {
  if (!view) return
  const effect = S.pageTurn
  if (effect === 'none' || !CAN.pageCapture || S.flow !== 'paginated' || matchMedia('(prefers-reduced-motion: reduce)').matches)
    return navSide(side)
  if (pageCapturing) return
  pageAnim?.finish()
  pageCapturing = true
  const stage = $('#stage')
  const r = stage.getBoundingClientRect()
  let url, overlay
  try {
    hideSelPop()
    const buf = await api.capture({ x: r.left, y: r.top, width: r.width, height: r.height })
    url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))
    const img = new Image()
    img.src = url
    await img.decode()
    if (!view) throw new Error('closed')
    overlay = buildPageOverlay(url, r, side, effect)
    stage.append(overlay.el)
    await nextFrame()
  } catch {
    pageCapturing = false
    if (url) URL.revokeObjectURL(url)
    return view && navSide(side)
  }
  const moved = await navigateAndSettle(side)
  pageCapturing = false
  const cleanup = () => { overlay.el.remove(); URL.revokeObjectURL(url) }
  if (!moved || !view) return cleanup()
  pageAnim = overlay.play(cleanup)
}

function buildPageOverlay(url, r, side, effect) {
  const W = r.width, H = r.height
  const theme = THEMES[S.theme] ?? THEMES.dark
  const root = el('div', { class: 'pt-overlay' })
  const bg = (node, offsetX) => {
    node.style.backgroundImage = `url("${url}")`
    node.style.backgroundSize = `${W}px ${H}px`
    node.style.backgroundPosition = `${-offsetX}px 0`
  }
  const easing = 'cubic-bezier(.42, 0, .3, 1)'
  const runAll = (anims, cleanup) => {
    let finished = false
    const end = () => { if (finished) return; finished = true; cleanup(); if (pageAnim?.anims === anims) pageAnim = null }
    Promise.all(anims.map(a => a.finished)).then(end, end)
    return { anims, finish: () => { anims.forEach(a => { try { a.finish() } catch {} }); end() } }
  }

  if (effect === 'slide') {
    const sheet = el('div')
    Object.assign(sheet.style, { left: 0, width: W + 'px', boxShadow: '0 0 28px rgba(0,0,0,.35)' })
    bg(sheet, 0)
    root.append(sheet)
    return {
      el: root,
      play: cleanup => runAll([sheet.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(${side === 'right' ? -W - 40 : W + 40}px)` }],
        { duration: 380, easing: 'cubic-bezier(.3, .1, .25, 1)', fill: 'forwards' })], cleanup),
    }
  }

  // flip: in a two-page spread the turning leaf is one half, hinged at the spine;
  // with a single page, the whole page turns on its outer edge
  const spread = isSpread()
  const spineX = spread ? W / 2 : side === 'right' ? 0 : W
  const leafX = side === 'right' ? spineX : 0
  const leafW = side === 'right' ? W - spineX : spineX
  root.style.perspective = `${Math.max(1600, W * 1.6)}px`
  root.style.perspectiveOrigin = `${spineX}px 50%`

  // the half of the old spread that does not move until the leaf lands on it
  let still = null
  if (spread) {
    still = el('div')
    const stillX = side === 'right' ? 0 : spineX
    Object.assign(still.style, { left: stillX + 'px', width: (W - leafW) + 'px' })
    bg(still, stillX)
    root.append(still)
  }
  // shadow the leaf throws onto the page being revealed
  const cast = el('div', { class: 'pt-cast' })
  Object.assign(cast.style, {
    left: leafX + 'px', width: leafW + 'px',
    background: `linear-gradient(${side === 'right' ? 90 : 270}deg, rgba(0,0,0,.45), rgba(0,0,0,.08) 35%, transparent 70%)`,
  })
  const leaf = el('div', { class: 'pt-leaf' })
  Object.assign(leaf.style, {
    left: leafX + 'px', width: leafW + 'px',
    transformOrigin: side === 'right' ? 'left center' : 'right center',
  })
  const front = el('div', { class: 'pt-face' })
  bg(front, leafX)
  front.style.backgroundColor = theme.bg
  const frontShade = el('div', { class: 'pt-shade' })
  frontShade.style.background = `linear-gradient(${side === 'right' ? 90 : 270}deg, rgba(0,0,0,.05), rgba(0,0,0,.35) 60%, rgba(255,255,255,.12))`
  front.append(frontShade)
  // The back of the leaf is see-through: the book has already moved to the new
  // spread underneath, so the real new page shows "printed" on the leaf's back.
  const back = el('div', { class: 'pt-face pt-back' })
  const backShade = el('div', { class: 'pt-shade' })
  backShade.style.background = `linear-gradient(${side === 'right' ? 270 : 90}deg, rgba(0,0,0,.45), rgba(0,0,0,.12) 22%, rgba(255,255,255,.06) 60%, rgba(0,0,0,.18))`
  back.append(backShade)
  leaf.append(front, back)
  root.append(cast, leaf)

  // Sample the motion so the uncovering of the old half can follow the exact
  // perspective-projected edge of the leaf.
  const D = spread ? 640 : 560
  const P = parseFloat(root.style.perspective)
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
  const N = 36
  const leafFrames = [], stillFrames = [], frontFrames = [], backFrames = []
  for (let i = 0; i <= N; i++) {
    const t = i / N, e = ease(t)
    const a = (side === 'right' ? -180 : 180) * e
    const rad = a * Math.PI / 180
    leafFrames.push({ offset: t, transform: `rotateY(${a}deg)` })
    // screen x of the leaf's free edge, relative to the spine
    const x = side === 'right'
      ? leafW * Math.cos(rad) * P / (P + leafW * Math.sin(rad))
      : -leafW * Math.cos(rad) * P / (P - leafW * Math.sin(rad))
    if (still) {
      const covered = side === 'right' ? Math.max(0, -x) : Math.max(0, x)
      stillFrames.push({ offset: t, clipPath: side === 'right' ? `inset(0 ${covered}px 0 0)` : `inset(0 0 0 ${covered}px)` })
    }
    const lift = Math.sin(Math.PI * e) // 0 → 1 (upright) → 0
    frontFrames.push({ offset: t, opacity: e < 0.5 ? lift : 1 })
    backFrames.push({ offset: t, opacity: e < 0.5 ? 1 : 0.25 + 0.75 * lift })
  }
  const opts = { duration: D, easing: 'linear', fill: 'forwards' }
  return {
    el: root,
    play: cleanup => {
      const anims = [
        leaf.animate(leafFrames, opts),
        frontShade.animate(frontFrames, opts),
        backShade.animate(backFrames, opts),
        cast.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }], { duration: D, easing, fill: 'forwards' }),
      ]
      if (still) anims.push(still.animate(stillFrames, opts))
      // the last bit of shading fades so the hand-off to the live page is seamless
      anims.push(root.animate([{ opacity: 1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], opts))
      return runAll(anims, cleanup)
    },
  }
}

// ----- immersive mode
function toggleImmersive(force) {
  const r = $('#reader')
  const on = r.classList.toggle('immersive', force)
  r.classList.remove('show-bars')
  if (!on) hidePopovers()
}
let barsTimer
function revealBars(show) {
  const r = $('#reader')
  if (show) { clearTimeout(barsTimer); r.classList.add('show-bars') }
  else if (r.classList.contains('show-bars') && !anyOverlayOpen()) {
    clearTimeout(barsTimer)
    barsTimer = setTimeout(() => r.classList.remove('show-bars'), 500)
  }
}
$('#stage').addEventListener('mousemove', e => {
  if ($('#reader').classList.contains('immersive')) revealBars(e.clientY < 70 || e.clientY > innerHeight - 70)
})
$('#reader').addEventListener('mouseleave', () => revealBars(false))

// ----- TOC
let tocLinks = new Map()
let currentTocEl = null
function renderTOC(toc) {
  const host = $('#tab-toc')
  host.replaceChildren()
  tocLinks = new Map()
  currentTocEl = null
  if (!toc?.length) return host.append(el('div', { class: 'empty-note', text: 'This book has no table of contents.' }))
  const build = (items, depth) => {
    const ul = el('ul', { class: depth === 0 ? 'toc-list' : '' })
    for (const item of items) {
      const li = el('li')
      const hasKids = item.subitems?.length > 0
      const row = el('div', { class: 'toc-item' })
      if (hasKids) {
        const tw = el('button', { class: 'twisty', 'aria-label': 'Expand' }, icon('i-right'))
        tw.onclick = () => li.classList.toggle('expanded')
        row.append(tw)
      } else row.append(el('span', { class: 'spacer' }))
      const a = el('a', { class: 'toc-link', text: item.label?.trim() || '—' })
      if (item.href) {
        a.onclick = () => { view?.goTo(item.href); closePanels() }
        tocLinks.set(item.href, a)
      }
      row.append(a)
      li.append(row)
      if (hasKids) li.append(build(item.subitems, depth + 1))
      ul.append(li)
    }
    return ul
  }
  host.append(build(toc, 0))
}
function setCurrentTOC(href) {
  const a = href ? tocLinks.get(href) : null
  if (a === currentTocEl) return
  currentTocEl?.classList.remove('current')
  currentTocEl = a
  if (!a) return
  a.classList.add('current')
  for (let li = a.closest('li')?.parentElement?.closest('li'); li; li = li.parentElement?.closest('li'))
    li.classList.add('expanded')
}

// ----- bookmarks
function bookmarkIndexHere() {
  if (!lastLoc?.cfi) return -1
  try {
    const start = CFI.collapse(lastLoc.cfi), end = CFI.collapse(lastLoc.cfi, true)
    return bookmarks.findIndex(b => CFI.compare(start, b.cfi) <= 0 && CFI.compare(b.cfi, end) <= 0)
  } catch { return -1 }
}
function updateBookmarkButton() {
  const on = bookmarkIndexHere() >= 0
  $('#btn-bookmark').classList.toggle('on', on)
  $('#btn-bookmark').title = on ? 'Remove bookmark (Ctrl+B)' : 'Bookmark this page (Ctrl+B)'
}
function toggleBookmark() {
  if (!view || !lastLoc?.cfi) return
  const i = bookmarkIndexHere()
  if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed', '', 1500) }
  else {
    let text = ''
    try { text = lastLoc.range?.toString().replace(/\s+/g, ' ').trim().slice(0, 180) ?? '' } catch {}
    bookmarks.push({
      cfi: CFI.collapse(lastLoc.cfi), fraction: lastLoc.fraction,
      chapter: lastLoc.tocItem?.label?.trim() ?? '', text, created: Date.now(),
    })
    bookmarks.sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
    toast('Bookmarked', '', 1500)
  }
  updateBookmarkButton()
  renderBookmarks()
  persistNotes()
}
function renderBookmarks() {
  const host = $('#tab-bookmarks')
  host.replaceChildren()
  if (!bookmarks.length) return host.append(el('div', { class: 'empty-note', text: 'No bookmarks yet.\nPress Ctrl+B or the bookmark button to mark a page.' }))
  for (const b of bookmarks) {
    const del = el('button', { class: 'icon-btn n-del', title: 'Delete bookmark' }, icon('i-close'))
    del.onclick = e => { e.stopPropagation(); bookmarks.splice(bookmarks.indexOf(b), 1); renderBookmarks(); updateBookmarkButton(); persistNotes() }
    host.append(el('div', { class: 'note-item', onclick: () => { view.goTo(b.cfi); closePanels() } },
      el('div', { class: 'n-meta' }, el('span', { text: b.chapter || 'Bookmark' }), el('span', { text: pct.format(b.fraction ?? 0) })),
      el('div', { class: 'n-text', text: b.text || '…' }), del))
  }
}

// ----- highlights & selection popover
let selState = null
function checkSelection(doc, index) {
  setTimeout(() => {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const text = sel.toString()
    if (!text.trim()) return
    const range = sel.getRangeAt(0)
    selState = { mode: 'new', doc, index, range: range.cloneRange(), text }
    showSelPop(range.getBoundingClientRect(), doc, 'new')
  }, 10)
}
function onShowAnnotation(e) {
  annotationClicked = true
  const { value, range } = e.detail
  const a = annotations.find(x => x.value === value)
  if (!a || !range) return
  const doc = range.startContainer.ownerDocument
  selState = { mode: 'existing', annotation: a, doc, text: a.text, rect: range.getBoundingClientRect() }
  showSelPop(range.getBoundingClientRect(), doc, 'existing', a.color, a.note)
}
function showSelPop(rect, doc, mode, activeColor, note) {
  const pop = $('#sel-pop')
  pop.dataset.mode = mode
  pop.querySelector('[data-sel="remove"]').hidden = mode !== 'existing'
  pop.querySelector('[data-sel="note"]').textContent = note ? 'Edit note' : 'Add note'
  pop.querySelectorAll('.hl-color').forEach(b => b.classList.toggle('active', b.dataset.color === activeColor))
  const preview = pop.querySelector('.note-preview')
  preview.hidden = !note
  preview.textContent = note ?? ''
  pop.classList.toggle('has-note', !!note)
  pop.hidden = false
  const off = frameOffset(doc)
  const { width, height } = pop.getBoundingClientRect()
  let left = off.x + rect.left + rect.width / 2 - width / 2
  let top = off.y + rect.top - height - 10
  if (top < 60) top = off.y + rect.bottom + 10
  left = Math.max(8, Math.min(left, innerWidth - width - 8))
  top = Math.max(8, Math.min(top, innerHeight - height - 8))
  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
}
function hideSelPop() {
  $('#sel-pop').hidden = true
  $('#sel-pop').dataset.mode = ''
}
$('#sel-pop').addEventListener('pointerdown', e => e.preventDefault()) // keep the selection alive
$('#sel-pop').addEventListener('click', async e => {
  const btn = e.target.closest('button')
  if (!btn || !selState) return
  const st = selState
  if (btn.dataset.sel === 'note') {
    // keep selState: the editor takes it over
    hideSelPop()
    openNoteEditor(st)
    return
  }
  if (btn.dataset.color) {
    lastHighlightColor = btn.dataset.color
    if (st.mode === 'new') {
      await addHighlight(makeHighlight(st, btn.dataset.color))
      st.doc.getSelection()?.removeAllRanges()
    } else {
      st.annotation.color = btn.dataset.color
      await paintHighlight(st.annotation)
    }
    renderHighlights(); persistNotes()
  } else if (btn.dataset.sel === 'copy') {
    await navigator.clipboard.writeText(st.text)
    toast('Copied', '', 1200)
  } else if (btn.dataset.sel === 'search') {
    openSearch(st.text.trim().slice(0, 100), true)
  } else if (btn.dataset.sel === 'lookup') {
    const rect = st.range?.getBoundingClientRect?.() ?? st.rect
    hideSelPop()
    selState = null
    openLookup(st.text, rect, st.doc)
    return
  } else if (btn.dataset.sel === 'remove') {
    await removeHighlight(st.annotation)
  }
  hideSelPop()
  selState = null
})
let lastHighlightColor = 'yellow'
function locateSelection(st) {
  st.value ??= view.getCFI(st.index, st.range)
  st.chapter ??= view.getProgressOf(st.index, st.range)?.tocItem?.label?.trim() ?? ''
  st.fraction ??= lastLoc?.fraction ?? 0
}
function makeHighlight(st, color, note) {
  locateSelection(st)
  const a = {
    value: st.value, color, text: st.text.replace(/\s+/g, ' ').trim().slice(0, 2000),
    chapter: st.chapter, fraction: st.fraction, created: Date.now(), index: st.index,
  }
  if (note) { a.note = note; a.noteUpdated = Date.now() }
  return a
}
// keep annotations in reading order
function insertAnnotation(a) {
  annotations.push(a)
  annotations.sort((x, y) => (x.index - y.index) || CFI.compare(x.value, y.value))
}
async function addHighlight(a) {
  insertAnnotation(a)
  await paintHighlight(a)
}
async function removeHighlight(a) {
  await eraseHighlight(a)
  annotations.splice(annotations.indexOf(a), 1)
  renderHighlights(); persistNotes()
}

// ----- drawing highlights: reflowable pages use the engine's layer; PDF pages use ours
async function paintHighlight(a) {
  await view.addAnnotation(a)
  if (view?.isFixedLayout) for (const layer of liveFxlLayers()) if (layer.index === a.index) drawOnFxl(layer, a)
}
async function eraseHighlight(a) {
  await view.deleteAnnotation(a)
  if (view?.isFixedLayout) for (const layer of liveFxlLayers()) layer.overlayer.remove(a.value)
}

// PDF pages render text as a pdf.js text layer inside a document that is scaled by
// 1/devicePixelRatio, and the engine has no highlight layer for them. Draw our own,
// and redraw whenever pdf.js rebuilds the text layer (zoom, resize).
let fxlLayers = []
const liveFxlLayers = () => (fxlLayers = fxlLayers.filter(l => l.doc.defaultView))
function attachFxlLayer(doc, index) {
  const textLayer = doc.querySelector('.textLayer')
  if (!textLayer) return // comics: images only
  const overlayer = new Overlayer()
  Object.assign(overlayer.element.style, { overflow: 'visible', zIndex: '3' })
  doc.body.append(overlayer.element)
  const layer = { doc, index, overlayer }
  fxlLayers.push(layer)
  let timer
  const redraw = () => {
    clearTimeout(timer)
    // pdf.js rebuilds the text layer in several steps; draw once it has settled
    timer = setTimeout(() => { for (const a of annotations) if (a.index === index) drawOnFxl(layer, a) }, 150)
  }
  new MutationObserver(redraw).observe(textLayer, { childList: true })
  redraw()
  doc.addEventListener('click', e => {
    const [value, range] = overlayer.hitTest(e)
    if (value) onShowAnnotation({ detail: { value, range } })
  })
}
function drawOnFxl(layer, a) {
  try {
    const range = view.resolveNavigation(a.value)?.anchor?.(layer.doc)
    if (!range?.getClientRects) return
    const root = layer.doc.documentElement
    const k = root.offsetWidth / (root.getBoundingClientRect().width || root.offsetWidth) // undo the page's scale
    const scaled = rects => Array.from(rects, r => ({
      left: r.left * k, top: r.top * k, width: r.width * k, height: r.height * k,
      right: r.right * k, bottom: r.bottom * k,
    }))
    layer.overlayer.add(a.value, range, (rects, o) => drawAnnotation(scaled(rects), o),
      { color: HL[a.color] ?? HL.yellow, note: !!a.note })
  } catch { /* text layer mid-rebuild; the next mutation redraws it */ }
}

// highlight, plus a small marker and dotted underline when it carries a note
function drawAnnotation(rects, options) {
  const g = Overlayer.highlight(rects, options)
  if (!options.note || !rects.length) return g
  const ns = 'http://www.w3.org/2000/svg'
  const wrap = document.createElementNS(ns, 'g')
  wrap.append(g)
  for (const { left, top, height, width } of rects) {
    const line = document.createElementNS(ns, 'line')
    const y = top + height + 1
    Object.entries({ x1: left, x2: left + width, y1: y, y2: y, stroke: options.color, 'stroke-width': 1.6, 'stroke-dasharray': '2 3', 'stroke-linecap': 'round' })
      .forEach(([k, v]) => line.setAttribute(k, v))
    wrap.append(line)
  }
  const last = rects[rects.length - 1]
  const dot = document.createElementNS(ns, 'circle')
  Object.entries({ cx: last.left + last.width + 3, cy: last.top + 2, r: 4.2, fill: options.color, stroke: 'rgba(0,0,0,.35)', 'stroke-width': 0.8 })
    .forEach(([k, v]) => dot.setAttribute(k, v))
  wrap.append(dot)
  return wrap
}

function renderHighlights() {
  const host = $('#tab-highlights')
  host.replaceChildren()
  if (!annotations.length) return host.append(el('div', { class: 'empty-note', text: 'No highlights or notes yet.\nSelect text in the book, then pick a color or “Add note”.' }))
  const noted = annotations.filter(a => a.note).length
  const exportBtn = el('button', { class: 'btn ghost small', title: 'Save all highlights and notes as a Markdown file' }, 'Export…')
  exportBtn.onclick = exportNotes
  host.append(el('div', { class: 'notes-head' },
    el('span', { text: `${plural(annotations.length, 'highlight')} · ${plural(noted, 'note')}` }),
    exportBtn))
  for (const a of annotations) {
    const del = el('button', { class: 'icon-btn n-del', title: 'Delete highlight and note' }, icon('i-close'))
    del.onclick = async e => {
      e.stopPropagation()
      if (a.note && !confirm('Delete this highlight and its note?')) return
      await removeHighlight(a)
    }
    const edit = el('button', { class: 'n-edit', text: a.note ? 'Edit note' : '+ Add note' })
    edit.onclick = e => { e.stopPropagation(); openNoteEditor({ mode: 'existing', annotation: a, text: a.text }) }
    const item = el('div', { class: 'note-item hl', onclick: () => { view.goTo(a.value); closePanels() } },
      el('div', { class: 'n-meta' }, el('span', { text: a.chapter || '' }), el('span', { text: a.created ? dateFmt.format(a.created) : '' })),
      el('div', { class: 'n-text', text: a.text }),
      a.note ? el('div', { class: 'n-note', text: a.note }) : null,
      edit, del)
    item.style.setProperty('--c', HL[a.color])
    host.append(item)
  }
}

// ----- note editor
let noteEdit = null // { st, annotation?, value?, color, original }
function openNoteEditor(st) {
  const ed = $('#note-editor')
  const a = st.annotation
  if (st.mode === 'new') locateSelection(st)
  noteEdit = { st, annotation: a, color: a?.color ?? lastHighlightColor, original: a?.note ?? '' }
  ed.querySelector('.ne-quote').textContent = (st.text ?? '').replace(/\s+/g, ' ').trim()
  ed.querySelector('.ne-title').textContent = a?.note ? 'Edit note' : 'Add note'
  const ta = $('#note-text')
  ta.value = a?.note ?? ''
  syncNoteColors()
  ed.hidden = false
  // place it next to the passage when we know where that is, else centre it
  const { width, height } = ed.getBoundingClientRect()
  let left = (innerWidth - width) / 2, top = (innerHeight - height) / 2
  const rect = st.mode === 'new' ? st.range?.getBoundingClientRect() : st.rect
  if (rect && st.doc && rect.width) {
    const off = frameOffset(st.doc)
    left = off.x + rect.left + rect.width / 2 - width / 2
    top = off.y + rect.bottom + 12
    if (top + height > innerHeight - 8) top = off.y + rect.top - height - 12
  }
  ed.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) + 'px'
  ed.style.top = Math.max(8, Math.min(top, innerHeight - height - 8)) + 'px'
  autosizeNote()
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
}
function syncNoteColors() {
  $$('#note-editor .hl-color').forEach(b => b.classList.toggle('active', b.dataset.color === noteEdit?.color))
}
function autosizeNote() {
  const ta = $('#note-text')
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.5) + 'px'
}
// save = true keeps what was typed; an empty note on an existing highlight removes just the note
async function closeNoteEditor(save) {
  if (!noteEdit) return
  const { st, annotation, color, original } = noteEdit
  noteEdit = null
  $('#note-editor').hidden = true
  const text = $('#note-text').value.replace(/\s+$/, '')
  selState = null
  if (!save || !view) return
  // data is saved before the (async) redraw, so closing the book right after cannot lose it
  try {
    if (annotation) {
      const changed = text !== original || color !== annotation.color
      if (!changed) return
      if (text.trim()) { annotation.note = text; annotation.noteUpdated = Date.now() }
      else { delete annotation.note; delete annotation.noteUpdated }
      annotation.color = color
      renderHighlights()
      persistNotes()
      await paintHighlight(annotation)
    } else {
      if (!text.trim()) return
      lastHighlightColor = color
      const a = makeHighlight(st, color, text)
      insertAnnotation(a)
      renderHighlights()
      persistNotes()
      st.doc?.getSelection()?.removeAllRanges()
      toast('Note saved', '', 1200)
      await paintHighlight(a)
    }
  } catch (e) {
    console.error(e)
    toast('Could not save the note', 'error')
  }
}
$('#note-editor').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (!b) return
  if (b.dataset.color) { noteEdit.color = b.dataset.color; syncNoteColors() }
  else if (b.dataset.ne === 'save') closeNoteEditor(true)
  else if (b.dataset.ne === 'cancel') closeNoteEditor(false)
})
$('#note-text').addEventListener('input', autosizeNote)
$('#note-text').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNoteEditor(false) }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); closeNoteEditor(true) }
  else e.stopPropagation() // typing must never turn pages or trigger shortcuts
})

async function exportNotes() {
  if (!current || !annotations.length) return
  const lines = [`# ${current.title}`, '']
  if (current.author) lines.push(`*${current.author}*`, '')
  lines.push(`Highlights and notes exported from Simply Reader on ${dateFmt.format(Date.now())}.`, '')
  let chapter = null
  for (const a of annotations) {
    if (a.chapter && a.chapter !== chapter) { chapter = a.chapter; lines.push(`## ${chapter}`, '') }
    lines.push(`> ${a.text}`, '')
    if (a.note) lines.push(a.note, '')
    lines.push('---', '')
  }
  const saved = await api.saveText(`${current.title} - notes.md`, lines.join('\n'))
  if (saved) toast('Notes exported', '', 2000)
}

// ----- search
let searchGen = 0
async function runSearch(query) {
  const gen = ++searchGen
  const results = $('#search-results'), status = $('#search-status')
  view?.clearSearch()
  results.replaceChildren()
  if (!view || !query.trim()) { status.textContent = ''; return }
  let count = 0
  status.textContent = 'Searching…'
  try {
    for await (const r of view.search({ query: query.trim() })) {
      if (gen !== searchGen) return
      if (r === 'done') break
      if (r.progress != null) { status.textContent = `Searching… ${pct.format(r.progress)} · ${count} found`; continue }
      if (r.subitems) {
        results.append(el('div', { class: 'sr-group', text: r.label || 'Untitled section' }))
        for (const { cfi, excerpt } of r.subitems) {
          count++
          results.append(el('div', { class: 'sr-item', onclick: () => view.goTo(cfi) },
            excerpt.pre, el('mark', { text: excerpt.match }), excerpt.post))
        }
      }
    }
  } catch (e) { console.error(e) }
  if (gen === searchGen) status.textContent = count ? plural(count, 'result') : 'No results'
}
function openSearch(prefill, run) {
  hidePopovers()
  openPanel('search-panel')
  const input = $('#search-input')
  if (prefill != null) input.value = prefill
  input.focus(); input.select()
  if (run) runSearch(input.value)
}
$('#search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch(e.target.value)
  if (e.key === 'Escape') { closePanels(); e.stopPropagation() }
})
$('#search-input').addEventListener('search', e => { if (!e.target.value) runSearch('') })

// ----- panels & popovers
function openPanel(id) {
  closePanels(id)
  $('#' + id).classList.add('open')
  $('#scrim').classList.add('on')
  if (id === 'drawer') currentTocEl?.scrollIntoView({ block: 'center' })
}
function closePanels(except) {
  for (const p of $$('.panel.open')) {
    if (p.id === except) continue
    p.classList.remove('open')
    if (p.id === 'search-panel' && view) { searchGen++; view.clearSearch() }
  }
  if (!except) $('#scrim').classList.remove('on')
}
function hidePopovers() {
  $('#settings').hidden = true
  hideThemePop()
  $('#card-menu').hidden = true
  $('#coll-pop').hidden = true
  $('#chip-menu').hidden = true
  hideSelPop()
  closeFootnote()
  hideLookup()
  hideGoto()
  if (noteEdit) closeNoteEditor(true)
}
const anyOverlayOpen = () => !$('#settings').hidden || !$('#sel-pop').hidden || !$('#note-editor').hidden || !!$('.panel.open')
  || !$('#fn-pop').hidden || !$('#lookup-pop').hidden || !$('#goto-pop').hidden
$('#scrim').onclick = () => closePanels()
$$('[data-close]').forEach(b => b.onclick = () => closePanels())
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t))
  for (const id of ['toc', 'bookmarks', 'highlights']) $('#tab-' + id).hidden = id !== t.dataset.tab
})

// ----- toolbar
$('#btn-library').onclick = backToLibrary
$('#btn-toc').onclick = () => openPanel('drawer')
$('#btn-search').onclick = () => openSearch()
$('#btn-bookmark').onclick = toggleBookmark
$('#btn-settings').onclick = e => { e.stopPropagation(); const s = $('#settings'); const show = s.hidden; hidePopovers(); s.hidden = !show }
$('#btn-full').onclick = () => toggleFullscreen()
$('#nav-prev').onclick = () => turnPage('left')
$('#nav-next').onclick = () => turnPage('right')
$('#stage').addEventListener('wheel', handleWheel, { passive: false })

async function toggleFullscreen(force) {
  const full = await api.setFullscreen(force)
  if (document.body.dataset.view === 'reader') toggleImmersive(full)
}

const progress = $('#progress')
progress.addEventListener('input', () => {
  sliderDragging = true
  $('#loc-right').textContent = pct.format(+progress.value)
})
progress.addEventListener('change', async () => {
  sliderDragging = false
  await view?.goToFraction(+progress.value)
})

// theme picker in the library header (the same themes as the reader's settings)
function hideThemePop() {
  $('#theme-pop').hidden = true
  $('#lib-theme').setAttribute('aria-expanded', 'false')
}
$('#lib-theme').onclick = e => {
  e.stopPropagation()
  const pop = $('#theme-pop')
  if (!pop.hidden) return hideThemePop()
  hidePopovers()
  pop.hidden = false
  const r = $('#lib-theme').getBoundingClientRect(), w = pop.getBoundingClientRect().width
  pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
  pop.style.top = r.bottom + 6 + 'px'
  $('#lib-theme').setAttribute('aria-expanded', 'true')
  // opened from the keyboard (Enter/Space): move focus in so the arrows pick a theme
  if (e.detail === 0) (pop.querySelector('.tp-opt.active') ?? pop.querySelector('.tp-opt'))?.focus()
}
$('#theme-pop').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); hideThemePop(); $('#lib-theme').focus() }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const opts = [...$$('#theme-pop .tp-opt')], i = opts.indexOf(document.activeElement)
    opts[(i + (e.key === 'ArrowRight' ? 1 : opts.length - 1)) % opts.length]?.focus()
    e.preventDefault()
  }
})

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#theme-pop, #lib-theme')) hideThemePop()
  if (!e.target.closest('#settings, #btn-settings')) $('#settings').hidden = true
  if (!e.target.closest('#card-menu')) $('#card-menu').hidden = true
  if (!e.target.closest('#coll-pop, #card-menu')) $('#coll-pop').hidden = true
  if (!e.target.closest('#chip-menu')) $('#chip-menu').hidden = true
  if (!e.target.closest('#sel-pop')) hideSelPop()
  if (!e.target.closest('#fn-pop')) closeFootnote()
  if (!e.target.closest('#lookup-pop, #sel-pop')) hideLookup()
  if (!e.target.closest('#goto-pop, #loc-left')) hideGoto()
  if (noteEdit && !e.target.closest('#note-editor')) closeNoteEditor(true) // clicking away keeps the note
})

// ----- pop-up placement
// rect is relative to the book page `doc` (an iframe): place the pop-up below it, or above
function placePopover(pop, rect, doc) {
  const off = doc ? frameOffset(doc) : { x: 0, y: 0 }
  const r = { left: off.x + rect.left, right: off.x + rect.right, top: off.y + rect.top, bottom: off.y + rect.bottom }
  const { width, height } = pop.getBoundingClientRect()
  let top = r.bottom + 10
  if (top + height > innerHeight - 8 && r.top - height - 10 >= 8) top = r.top - height - 10
  const left = (r.left + r.right) / 2 - width / 2
  pop.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) + 'px'
  pop.style.top = Math.max(8, Math.min(top, innerHeight - height - 8)) + 'px'
}
$$('[data-close-pop]').forEach(b => b.onclick = () => { closeFootnote(); hideLookup() })

// ----- footnote pop-ups
// A note reference opens the note in a small pop-up instead of jumping away from the page.
const footnotes = new FootnoteHandler()
let fnView = null, fnLink = null, fnHref = null
const FN_TYPES = { footnote: 'Footnote', endnote: 'Endnote', note: 'Note', biblioentry: 'Reference', definition: 'Definition' }
const footnoteCSS = () => bookCSS(S) + `
html { font-size: ${Math.round(S.fontSize * 0.92)}px !important; }
html, body { background: transparent !important; }
body { margin: 0 !important; padding: 0 !important; }
p, li, blockquote, dd { text-align: start !important; }`

function onLink(e) {
  const { a, href } = e.detail
  const shown = footnotes.handle(view.book, e)
  if (!e.defaultPrevented) { linkFollowed = true; return }
  fnLink = { rect: a.getBoundingClientRect(), doc: a.ownerDocument }
  fnHref = href
  Promise.resolve(shown).catch(err => {
    // not something that can be shown in a pop-up: follow the link as usual
    console.warn('footnote', err)
    closeFootnote()
    linkFollowed = true
    view?.goTo(href)
  })
}
footnotes.addEventListener('before-render', e => {
  const v = e.detail.view
  closeFootnote(true)
  fnView = v
  const pop = $('#fn-pop')
  pop.hidden = false
  pop.style.visibility = 'hidden' // until it is sized and placed
  $('#fn-body').style.height = '60px'
  $('#fn-body').replaceChildren(v)
  const r = v.renderer
  r.setAttribute('flow', 'scrolled')
  r.setAttribute('margin', '0px')
  r.setAttribute('gap', '2%')
  r.setAttribute('max-inline-size', '2000px')
  r.setStyles?.(footnoteCSS())
  // links inside the note (e.g. "back to text") act on the main reader
  v.addEventListener('link', ev => {
    ev.preventDefault()
    closeFootnote()
    linkFollowed = true
    view?.goTo(ev.detail.href)
  })
  v.addEventListener('load', ({ detail: { doc } }) =>
    doc.addEventListener('keydown', k => { if (k.key === 'Escape') closeFootnote() }))
})
footnotes.addEventListener('render', async e => {
  const { view: v, type, hidden } = e.detail
  if (v !== fnView) return
  $('#fn-type').textContent = FN_TYPES[type] ?? 'Note'
  $('#fn-goto').hidden = !!hidden // notes the book hides from the text only exist as pop-ups
  await nextFrame(); await nextFrame()
  if (v !== fnView) return
  const doc = v.renderer.getContents?.()[0]?.doc
  const h = Math.ceil(doc?.documentElement?.scrollHeight ?? 60)
  $('#fn-body').style.height = Math.max(28, Math.min(340, h + 2)) + 'px'
  const pop = $('#fn-pop')
  if (fnLink) placePopover(pop, fnLink.rect, fnLink.doc)
  pop.style.visibility = ''
})
function closeFootnote(keepPop) {
  if (fnView) {
    try { fnView.close() } catch {}
    fnView.remove()
    fnView = null
  }
  if (!keepPop) { $('#fn-pop').hidden = true; fnLink = null }
}
$('#fn-goto').onclick = () => {
  const href = fnHref
  closeFootnote()
  if (view && href) { linkFollowed = true; view.goTo(href) }
}

// ----- dictionary and Wikipedia look-up
let lookupGen = 0
const htmlText = html => {
  const body = new DOMParser().parseFromString(html ?? '', 'text/html').body
  body.querySelectorAll('style, script, link, sup.reference').forEach(x => x.remove()) // Wiktionary embeds CSS
  return body.textContent.replace(/\s+/g, ' ').trim()
}
const bookLang = () => (view?.language?.canonical ?? 'en').split('-')[0].toLowerCase()

async function openLookup(text, rect, doc) {
  const term = text.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 120)
  if (!term) return
  const gen = ++lookupGen
  const pop = $('#lookup-pop'), body = $('#lookup-body')
  $('#lookup-word').textContent = 'Look up'
  body.replaceChildren(el('div', { class: 'lk-status', text: `Looking up “${term}”…` }))
  $('#lookup-links').replaceChildren()
  pop.hidden = false
  placePopover(pop, rect, doc)

  const lang = bookLang()
  const words = term.split(' ').length
  let failed = false
  const fail = e => { console.warn('look-up', e); failed = true; return null }
  const getDict = async () => {
    if (words > 3) return null
    // a capitalised word (e.g. at the start of a sentence) may only match another
    // language's entry ("Police" is German): then prefer the lower-case word
    const useful = d => d?.[lang] || d?.en
    let d = await api.lookupDefinition(term)
    if (!useful(d) && term !== term.toLowerCase()) d = (await api.lookupDefinition(term.toLowerCase())) ?? d
    return d
  }
  const getWiki = async () => {
    const ok = w => w && w.type !== 'disambiguation' && w.extract ? w : null
    const local = lang !== 'en' ? ok(await api.lookupWikipedia(term, lang).catch(() => null)) : null
    return local ?? ok(await api.lookupWikipedia(term, 'en'))
  }
  const [dict, wiki] = await Promise.all([getDict().catch(fail), getWiki().catch(fail)])
  if (gen !== lookupGen || pop.hidden) return

  // entries in the book's language first, then English, then whatever Wiktionary has
  const groups = (dict?.[lang] ?? dict?.en ?? Object.values(dict ?? {})[0] ?? [])
    .map(g => ({ ...g, defs: (g.definitions ?? []).map(d => ({ text: htmlText(d.definition), ex: htmlText(d.examples?.[0]) })).filter(d => d.text) }))
    .filter(g => g.defs.length)
    .slice(0, 3)
  // Wikipedia for names and phrases, or when the dictionary has nothing
  const showWiki = wiki && (words > 1 || !groups.length || /proper noun/i.test(groups[0].partOfSpeech ?? ''))
  const out = []
  if (groups.length) {
    out.push(el('div', { class: 'lk-word', text: term }))
    for (const g of groups) {
      out.push(el('div', { class: 'lk-pos', text: [g.partOfSpeech, g.language !== 'English' ? g.language : null].filter(Boolean).join(' · ') }))
      out.push(el('ol', { class: 'lk-defs' }, ...g.defs.slice(0, 4).map(d =>
        el('li', {}, d.text, d.ex && d.ex.length < 200 ? el('span', { class: 'lk-ex', text: d.ex }) : null))))
    }
  }
  if (showWiki) out.push(el('div', { class: 'lk-wiki' }, el('div', {},
    el('h4', { text: htmlText(wiki.displaytitle) || wiki.title }),
    el('p', { text: wiki.extract.length > 700 ? wiki.extract.slice(0, 700).replace(/\s\S*$/, '') + '…' : wiki.extract }))))
  if (!out.length) out.push(el('div', { class: 'lk-status', text: failed
    ? 'Couldn’t reach Wiktionary or Wikipedia. Check your internet connection.'
    : `No definition found for “${term}”.` }))
  const links = []
  if (words <= 3) {
    const section = groups[0]?.language ? '#' + groups[0].language.replace(/ /g, '_') : ''
    links.push(el('a', { href: `https://en.wiktionary.org/wiki/${encodeURIComponent(groups.length ? term : term.toLowerCase())}${section}`, target: '_blank', text: 'Wiktionary ↗' }))
  }
  links.push(el('a', { href: wiki?.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/w/index.php?search=${encodeURIComponent(term)}`, target: '_blank', text: 'Wikipedia ↗' }))
  $('#lookup-links').replaceChildren(...links) // outside the scrolling area, always visible
  $('#lookup-word').textContent = groups.length ? 'Dictionary' : showWiki ? 'Wikipedia' : 'Look up'
  body.replaceChildren(...out)
  body.scrollTop = 0
  placePopover(pop, rect, doc)
}
function hideLookup() {
  if ($('#lookup-pop').hidden) return
  lookupGen++
  $('#lookup-pop').hidden = true
}

// ----- reading speed and time left
// The engine estimates time from a fixed speed. Learn the reader's own speed from page
// turns instead: book text read (in the engine's size units) per minute of reading.
const ENGINE_SPEED = 1600 // size units per minute assumed by the engine's estimates
let speedStats = { size: 0, ms: 0 }
try { speedStats = { ...speedStats, ...JSON.parse(localStorage.getItem('readingSpeed') ?? '{}') } } catch {}
const saveSpeed = debounce(() => { try { localStorage.setItem('readingSpeed', JSON.stringify(speedStats)) } catch {} shareViewPrefs() }, 2000)
const speedLearned = () => speedStats.ms >= 3 * 60000
const readingSpeed = () => speedLearned() ? speedStats.size / (speedStats.ms / 60000) : ENGINE_SPEED
let speedMark = null // where and when the current page was reached

function sampleReadingSpeed(fraction) {
  const now = Date.now()
  const prev = speedMark
  const reset = () => { speedMark = { path: current?.path, fraction, t: now } }
  if (!prev || prev.path !== current?.path || view?.isFixedLayout || S.flow !== 'paginated' || !current?.length) return reset()
  const size = (fraction - prev.fraction) * current.length
  const ms = now - prev.t
  if (ms < 1500 && Math.abs(size) < 1) return // layout reflow, not a page turn
  reset()
  // only steady forward reading counts: no jumps, skimming, going back or long breaks
  if (size <= 0 || size > 15000 || ms < 2000 || ms > 6 * 60000) return
  const perMin = size / (ms / 60000)
  if (perMin < 200 || perMin > 15000) return
  // older pages count gradually less, so the estimate follows the current pace
  speedStats.size = speedStats.size * 0.97 + size
  speedStats.ms = speedStats.ms * 0.97 + ms
  saveSpeed()
}
document.addEventListener('visibilitychange', () => { if (document.hidden) speedMark = null })

function showTimeLeft(fraction, time) {
  const out = $('#loc-right')
  const p = pct.format(fraction)
  if (view?.isFixedLayout || !time) { out.textContent = p; out.title = ''; return }
  const k = ENGINE_SPEED / readingSpeed()
  const chapter = time.section * k, book = time.total * k
  out.textContent = [p, chapter >= 0.5 ? `${fmtMin(chapter)} left in chapter` : null, `${fmtMin(book)} left in book`].filter(Boolean).join(' · ')
  out.title = speedLearned()
    ? 'Time left is based on your own reading speed'
    : 'Time left is a rough estimate until you have read a few more pages'
}

// ----- go to page
function gotoInfo() {
  if (!view || !lastLoc) return null
  if (view.isFixedLayout) return { kind: 'sections', total: view.book.sections.length }
  if (pager?.complete && pager.key === layoutKey() && S.pageNumbers && S.flow === 'paginated')
    return { kind: 'pager', total: pager.total }
  if (view.book.pageList?.length) return { kind: 'print', total: view.book.pageList.length }
  return { kind: 'none', reason: pager && !pager.complete ? 'Page numbers are still being counted…'
    : 'Turn on “Page numbers” and the paginated layout in Settings to jump to a page.' }
}
function openGoto() {
  const info = gotoInfo()
  if (!info) return
  $('#reader').classList.add('footer-peek') // keep the hidden footer visible while this is open
  hideSelPop(); closeFootnote(); hideLookup()
  const pop = $('#goto-pop'), input = $('#goto-input')
  pop.classList.toggle('disabled', info.kind === 'none')
  $('#goto-note').textContent = info.kind === 'none' ? info.reason
    : info.kind === 'print' ? 'Uses the printed edition’s page numbers.' : ''
  $('#goto-of').textContent = info.kind === 'print' ? '' : `of ${info.total}`
  input.value = ''
  input.placeholder = info.kind === 'print' ? (lastLoc.pageItem?.label ?? '') : String(currentPageNumber() ?? '')
  pop.hidden = false
  if (info.kind !== 'none') input.focus()
}
function hideGoto() {
  $('#goto-pop').hidden = true
  $('#reader').classList.remove('footer-peek')
  // the page label is a button: keep Space for turning pages, not re-opening this
  if (document.activeElement?.closest?.('#goto-pop, #loc-left')) document.activeElement.blur()
}
function currentPageNumber() {
  const m = /Page (\d+)/.exec($('#loc-left').textContent)
  return m ? +m[1] : null
}
async function goToPage(value) {
  const info = gotoInfo()
  if (!info || info.kind === 'none') return
  const from = lastLoc?.cfi
  if (info.kind === 'print') {
    const item = view.book.pageList.find(p => String(p.label).trim().toLowerCase() === value.trim().toLowerCase())
    if (!item) return toast(`There is no page “${value}” in this book`, 'error')
    return jumpWithHistory(() => view.goTo(item.href), from)
  }
  const n = Math.round(+value)
  if (!Number.isFinite(n) || n < 1 || n > info.total) return toast(`Enter a page from 1 to ${info.total}`, 'error')
  if (info.kind === 'sections') return jumpWithHistory(() => view.goTo(n - 1), from)
  // page n lies in the last section starting before it; within that section, find the spread
  const perSpread = view.renderer.feet?.length || 1
  let i = 0
  pager.starts.forEach((s, j) => { if (pager.pages[j] > 0 && s < n) i = j })
  const spreads = Math.max(1, Math.ceil(pager.pages[i] / perSpread))
  const spread = Math.min(Math.floor((n - pager.starts[i] - 1) / perSpread), spreads - 1)
  await jumpWithHistory(() => view.renderer.goTo({ index: i, anchor: spreads > 1 ? spread / (spreads - 1) : 0 }), from)
}
// remember where the reader was, so "Back to where you were" / Alt+Left returns there
async function jumpWithHistory(go, from) {
  hideGoto()
  await go()
  if (!view) return
  if (from && view.lastLocation?.cfi && view.lastLocation.cfi !== from) {
    linkFollowed = true
    view.history.pushState(view.lastLocation.cfi)
  }
}
$('#loc-left').onclick = () => $('#goto-pop').hidden ? openGoto() : hideGoto()
$('#goto-pop').onsubmit = e => {
  e.preventDefault()
  const v = $('#goto-input').value.trim()
  if (v) goToPage(v); else hideGoto()
}

// ----- keyboard
function handleKey(e) {
  const k = e.key
  const ctrl = e.ctrlKey || e.metaKey
  const inField = e.target?.matches?.('input, select, textarea') && e.target.type !== 'range'
  if (ctrl && k.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return }
  if (k === 'F11') { e.preventDefault(); toggleFullscreen(); return }
  if (document.body.dataset.view !== 'reader' || !view) {
    const inDialog = !!document.querySelector('dialog[open]')
    if (libMode === 'list' && !inField && !inDialog) {
      if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); selectAllListed(); return }
      if (k === 'Delete' && listSel.size) { e.preventDefault(); removeSelected(); return }
      if (k === 'Escape' && listSel.size && !anyOverlayOpen() && $('#card-menu').hidden) { clearListSelection(); return }
    }
    if (k === 'Escape') hidePopovers()
    return
  }
  if (inField && k !== 'Escape') return
  const handled = () => e.preventDefault()
  if (k === 'Escape') {
    handled()
    if (anyOverlayOpen()) { hidePopovers(); closePanels() }
    else if ($('#reader').classList.contains('immersive')) toggleFullscreen(false)
    else backToLibrary()
  }
  else if (ctrl && k.toLowerCase() === 'f') { handled(); openSearch() }
  else if (ctrl && k.toLowerCase() === 'b') { handled(); toggleBookmark() }
  else if (ctrl && k.toLowerCase() === 'g') { handled(); openGoto() }
  else if (ctrl && (k === '=' || k === '+')) { handled(); zoomBy(1) }
  else if (ctrl && k === '-') { handled(); zoomBy(-1) }
  else if (ctrl && k === '0') { handled(); resetZoom() }
  else if (e.altKey && k === 'ArrowLeft') { handled(); view.history.back() }
  else if (e.altKey && k === 'ArrowRight') { handled(); view.history.forward() }
  else if (ctrl) return
  else if (k === 'ArrowLeft' || k === 'h') { handled(); turnPage('left') }
  else if (k === 'ArrowRight' || k === 'l') { handled(); turnPage('right') }
  else if (k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { handled(); turnNext(false) }
  else if (k === 'ArrowDown' || k === 'PageDown' || k === ' ') { handled(); turnNext(true) }
  else if (k === 'Home') { handled(); view.goToFraction(0) }
  else if (k === 'End') { handled(); view.goToFraction(0.9999) }
  else if (k === 't' || k === 'T') { handled(); openPanel('drawer') }
  else if (k === 'f' || k === 'F') { handled(); toggleFullscreen() }
  else if (k === 'i' || k === 'I') { handled(); toggleImmersive() }
}
document.addEventListener('keydown', handleKey)

// ----- open / drop
async function openDialog() {
  const paths = await api.chooseFiles()
  reportRejected(paths)
  if (paths.length) handlePaths(paths)
}
// Android imports files as they're picked; the ones it couldn't take come back as paths.rejected
function reportRejected(paths) {
  const bad = paths?.rejected ?? []
  if (bad.length) toast(bad.length === 1 ? `Couldn’t add ${bad[0].name}: ${bad[0].error}`
    : `Couldn’t add ${plural(bad.length, 'file')} (${bad[0].error})`, 'error', 6000)
}
async function importFolder() {
  showLoading('Scanning folder…')
  const paths = await api.chooseFolder()
  hideLoading()
  if (!paths.length) return
  importPaths(await storePaths(paths))
}
$('#lib-open').onclick = openDialog
$('#lib-import').onclick = importFolder
$('[data-action="open"]').onclick = openDialog
$('[data-action="import"]').onclick = importFolder
$('#lib-filter').oninput = debounce(renderLibrary, 150) // don't rebuild every card on each keystroke
$('#lib-sort').onchange = () => { renderLibrary(); try { localStorage.setItem('sort', $('#lib-sort').value) } catch {} shareViewPrefs() }

let dragDepth = 0
document.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging') } })
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging') } })
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', onDrop)
function onDrop(e) {
  e.preventDefault()
  dragDepth = 0
  document.body.classList.remove('dragging')
  const paths = [...(e.dataTransfer?.files ?? [])].map(f => api.pathForFile(f)).filter(Boolean)
  if (paths.length) handlePaths(paths)
}

api.onOpenFiles(paths => {
  reportRejected(paths)
  if (paths.length || !paths.rejected?.length) handlePaths(paths)
})

// ----- Android's Back: closes the topmost thing first, then the book, then leaves the app
function handleBack() {
  const dlg = $$('dialog[open]').at(-1)
  if (dlg) { if (!dlg.classList.contains('busy')) dlg.close(); return }
  const libPops = ['#card-menu', '#coll-pop', '#chip-menu', '#theme-pop'].some(s => $(s) && !$(s).hidden)
  if (anyOverlayOpen() || libPops) { hidePopovers(); closePanels(); return }
  if (document.body.dataset.view === 'reader' && view) {
    if ($('#reader').classList.contains('immersive')) toggleFullscreen(false)
    else backToLibrary()
    return
  }
  if (listSel.size) { clearListSelection(); return }
  flushAll().finally(() => api.exitApp?.())
}
api.onBackButton?.(handleBack)

// hide what this platform can't do (see CAN)
function applyCapabilities() {
  if (!CAN.folderImport) $$('#lib-import, [data-action="import"]').forEach(e => { e.hidden = true })
  if (!CAN.showInFolder) $$('#card-menu [data-cm="folder"]').forEach(e => { e.hidden = true })
  if (!CAN.autoBackup) $('#bk-auto').closest('.bk-sec').hidden = true
  if (!CAN.pageCapture) $('#set-pageTurn').closest('.set-row').hidden = true
  if (!CAN.dragDrop) $('#lib-empty p').textContent = 'Add EPUB, MOBI, AZW3, PDF, FB2 or CBZ books from this device, or'
  if (api.platform === 'android') {
    $('#edit-dialog .ed-hint').textContent = 'To change the cover, choose an image, or find one online.'
    $('#bk-safety').textContent = 'Save the copy made before the last restore…'
    $('#bk-safety').onclick = () => backupBusy('', async () => { await api.backup.show('safety'); $('#bk-status').textContent = '' })
    $('#bk-restore').closest('.bk-sec').querySelector('p').textContent =
      'Replaces the library on this device with the one in a backup file; nothing is merged. The library here is saved first, so you can go back to it.'
  }
}

// ---------------------------------------------------------------- boot
applyCapabilities()
;(async () => {
  try { const s = localStorage.getItem('sort'); if (s) $('#lib-sort').value = s } catch {}
  // fonts are only needed once a book opens, so they load alongside the library instead of before it
  const fontsReady = preloadBundledFonts()
  const [saved, savedGoals] = await Promise.all([api.settings.get(), api.goals.get().catch(() => null), refreshLibrary()])
  G = { ...DEFAULTS, ...saved }
  if (savedGoals) goals = savedGoals
  markGoalIfMet()
  renderGoalStrip()
  mergeSettings()
  initSettingsUI()
  applySettings()
  await fontsReady
  const pending = await api.getPendingFiles()
  reportRejected(pending)
  if (pending.length) handlePaths(pending)
  setTimeout(upgradeCovers, 3000) // after startup settles
  api.backup.setPrefs(uiPrefs()) // so automatic backups include the view choices
  try { // a restore reloads the window; say how it went
    const done = sessionStorage.getItem('restored')
    if (done) { sessionStorage.removeItem('restored'); toast(done, '', 5000) }
  } catch {}
})()
