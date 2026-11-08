import { makeBook } from '../../vendor/foliate-js/view.js'
import { Overlayer } from '../../vendor/foliate-js/overlayer.js'
import * as CFI from '../../vendor/foliate-js/epubcfi.js'

const api = window.api
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

const SUPPORTED = /\.(epub|mobi|azw3?|kf8|prc|fb2|fbz|cbz|pdf)$/i
const pct = new Intl.NumberFormat('en', { style: 'percent' })
const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  theme: 'dark', fontFamily: 'publisher', fontSize: 18, lineHeight: 1.5,
  gap: 6, maxWidth: 720, flow: 'paginated', columns: 2, pageTurn: 'flip',
  justify: true, hyphenate: true, override: true, pageNumbers: true,
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

let saveSettingsTimer
const saveSettings = () => {
  clearTimeout(saveSettingsTimer)
  saveSettingsTimer = setTimeout(() => api.settings.set(S), 300)
}

function applySettings() {
  document.body.dataset.theme = S.theme
  document.body.classList.toggle('pdf-dark', !!S.pdfDark)
  if (view?.isFixedLayout) view.renderer.setAttribute('zoom', String(S.pdfZoom))
  $('#reader').classList.toggle('scrolled', S.flow === 'scrolled')
  syncSettingsUI()
  if (!view?.renderer) return
  const r = view.renderer
  r.setAttribute('flow', S.flow)
  r.setAttribute('gap', S.gap + '%')
  r.setAttribute('margin', '28px')
  r.setAttribute('max-inline-size', S.maxWidth + 'px')
  r.setAttribute('max-column-count', String(S.columns))
  r.setStyles?.(bookCSS(S))
  schedulePagination()
}
const setSetting = (k, v) => { S[k] = v; applySettings(); saveSettings() }

function syncSettingsUI() {
  $$('[data-theme-btn]').forEach(b => b.classList.toggle('active', b.dataset.themeBtn === S.theme))
  $('#set-font').value = S.fontFamily
  $('#out-fontSize').value = S.fontSize + 'px'
  $('#set-lineHeight').value = S.lineHeight; $('#out-lineHeight').value = (+S.lineHeight).toFixed(2)
  $('#set-gap').value = S.gap; $('#out-gap').value = S.gap + '%'
  $('#set-maxWidth').value = S.maxWidth; $('#out-maxWidth').value = S.maxWidth
  $$('#set-flow button').forEach(b => b.classList.toggle('active', b.dataset.val === S.flow))
  $$('#set-columns button').forEach(b => b.classList.toggle('active', +b.dataset.val === +S.columns))
  $$('#set-pageTurn button').forEach(b => b.classList.toggle('active', b.dataset.val === S.pageTurn))
  $('#set-justify').checked = S.justify
  $('#set-hyphenate').checked = S.hyphenate
  $('#set-override').checked = S.override
  $('#set-pageNumbers').checked = S.pageNumbers
  $$('#set-pdfFit button').forEach(b => b.classList.toggle('active', b.dataset.val === S.pdfZoom))
  $('#out-zoom').value = typeof S.pdfZoom === 'number' ? `${Math.round(S.pdfZoom * 100)}%` : 'Fit'
  $('#set-pdfDark').checked = !!S.pdfDark
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
  $('#set-font').onchange = e => setSetting('fontFamily', e.target.value)
  $$('[data-step]').forEach(b => b.onclick = () => changeFontSize(+b.dataset.dir))
  for (const k of ['lineHeight', 'gap', 'maxWidth'])
    $('#set-' + k).oninput = e => setSetting(k, +e.target.value)
  $$('#set-flow button').forEach(b => b.onclick = () => setSetting('flow', b.dataset.val))
  $$('#set-columns button').forEach(b => b.onclick = () => setSetting('columns', +b.dataset.val))
  $$('#set-pageTurn button').forEach(b => b.onclick = () => setSetting('pageTurn', b.dataset.val))
  $$('#set-pdfFit button').forEach(b => b.onclick = () => setSetting('pdfZoom', b.dataset.val))
  $$('[data-zoom]').forEach(b => b.onclick = () => zoomStep(+b.dataset.zoom))
  $('#set-pdfDark').onchange = e => setSetting('pdfDark', e.target.checked)
  for (const k of ['justify', 'hyphenate', 'override', 'pageNumbers'])
    $('#set-' + k).onchange = e => setSetting(k, e.target.checked)
  $('#set-reset').onclick = () => { S = { ...DEFAULTS, theme: S.theme }; applySettings(); saveSettings() }
}
const changeFontSize = dir => setSetting('fontSize', Math.min(40, Math.max(10, S.fontSize + dir)))

// ---------------------------------------------------------------- helpers
const langMap = x => !x ? '' : typeof x === 'string' ? x : x[Object.keys(x)[0]] ?? ''
const formatAuthor = a => {
  const one = c => typeof c === 'string' ? c : langMap(c?.name)
  return Array.isArray(a) ? a.map(one).filter(Boolean).join(', ') : one(a)
}
const baseName = p => p.split(/[\\/]/).pop()
const stripExt = n => n.replace(/\.[^.]+$/, '')

function toast(msg, type = '', ms = 3500) {
  const t = el('div', { class: 'toast ' + type, text: msg })
  $('#toasts').append(t)
  setTimeout(() => t.remove(), ms)
}
const showLoading = text => { $('#loading-text').textContent = text; $('#loading').hidden = false }
const hideLoading = () => { $('#loading').hidden = true }

async function makeThumb(book) {
  try {
    const blob = await book.getCover?.()
    if (!blob) return null
    const bmp = await createImageBitmap(blob)
    const w = Math.min(360, bmp.width)
    const h = Math.round(bmp.height * w / bmp.width)
    const canvas = el('canvas', { width: w, height: h })
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
    bmp.close()
    return canvas.toDataURL('image/jpeg', 0.85)
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

const loadFile = async path => {
  const { name, data } = await api.readBook(path)
  const file = new File([data], name)
  return { name, file, book: await makeBook(file) }
}

// ---------------------------------------------------------------- library
let libCache = {}

async function refreshLibrary() {
  libCache = (await api.library.get()).books ?? {}
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
  $('#lib-filter').parentElement.hidden = total === 0

  // "continue reading" hero
  const cont = $('#continue')
  const last = !q && Object.values(libCache)
    .filter(b => b.lastOpened && !b.missing && (b.fraction ?? 0) < 0.995)
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

  const grid = $('#lib-grid')
  grid.replaceChildren()
  const label = $('#lib-label')
  label.hidden = total === 0
  label.textContent = q ? `${books.length} match${books.length === 1 ? '' : 'es'}` : `Library · ${total} book${total === 1 ? '' : 's'}`
  $$('#lib-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === libMode))
  hideShelfTip()
  if (libMode === 'shelf') { grid.className = ''; if (books.length) renderShelf(books); return }
  grid.className = 'grid'

  for (const b of books) {
    const f = b.fraction ?? 0
    const card = el('div', { class: 'card' + (b.missing ? ' missing' : ''), tabindex: '0', title: b.missing ? `File not found:\n${b.path}` : b.path })
    const badge = b.missing ? 'MISSING' : !b.lastOpened ? 'NEW' : f >= 0.995 ? 'FINISHED' : null
    if (badge) card.append(el('span', { class: 'badge' + (badge === 'NEW' ? ' new' : ''), text: badge }))
    const more = el('button', { class: 'more', title: 'More', 'aria-label': 'More options' }, icon('i-dots'))
    more.onclick = e => { e.stopPropagation(); showCardMenu(b, more.getBoundingClientRect()) }
    card.append(more, coverEl(b),
      el('div', { class: 'title', text: b.title }),
      el('div', { class: 'author', text: b.author || b.format || '' }))
    if (b.lastOpened && f > 0 && f < 0.995)
      card.append(el('div', { class: 'pbar' }, el('i', { style: `width:${f * 100}%` })))
    card.onclick = () => openBook(b.path)
    card.onkeydown = e => { if (e.key === 'Enter') openBook(b.path) }
    card.oncontextmenu = e => { e.preventDefault(); showCardMenu(b, { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX }) }
    grid.append(card)
  }
}

// ----- bookshelf view
let libMode = 'covers'
try { libMode = localStorage.getItem('libMode') === 'shelf' ? 'shelf' : 'covers' } catch {}
$$('#lib-mode button').forEach(b => b.onclick = () => {
  libMode = b.dataset.mode
  try { localStorage.setItem('libMode', libMode) } catch {}
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
makeShelfTextures()

const BINDINGS = ['leather', 'cloth', 'label', 'paperback']
const EMBLEMS = ['❦', '✦', '◆', '✻', '❧', '✢', '●']
const hslParts = c => (/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(c) ?? [0, 20, 35, 30]).slice(1).map(Number)

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
    b.lastOpened && f > 0 && f < 0.995 ? el('span', { class: 'bookmark' }) : null,
    f >= 0.995 ? el('span', { class: 'done-mark', text: '✦' }) : null)
  book.style.setProperty('--w', w + 'px')
  book.style.setProperty('--h', height + 'px')
  book.style.setProperty('--fs', fs.toFixed(1) + 'px')
  book.style.setProperty('--tilt', ((h >>> 7) % 5 - 2) * 0.6 + 'deg') // bookmarks never sit perfectly straight
  setSpineColor(book, color)
  Object.assign(book.dataset, { w, h: height, hash: h })
  book.onclick = () => openBook(b.path)
  book.onkeydown = e => { if (e.key === 'Enter') openBook(b.path) }
  book.oncontextmenu = e => { e.preventDefault(); hideShelfTip(); showCardMenu(b, { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX }) }
  book.onmouseenter = book.onfocus = () => showShelfTip(b, book)
  book.onmouseleave = book.onblur = hideShelfTip
  // older library entries: derive the binding color from the cover once and remember it
  if (!b.spineColor && b.cover) spineColorFrom(b.cover).then(c => {
    if (!c) return
    b.spineColor = c
    setSpineColor(book, c)
    api.library.upsert(b.path, { spineColor: c })
  })
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
  const grid = $('#lib-grid')
  const inner = el('div', { class: 'bc-inner' })
  grid.append(el('div', { class: 'bookcase' },
    el('div', { class: 'bc-crown' }),
    el('div', { class: 'bc-body' }, el('div', { class: 'bc-post' }), inner, el('div', { class: 'bc-post' })),
    el('div', { class: 'bc-plinth' })))
  const avail = inner.clientWidth - 28 - 12
  const GAP = 3
  const rows = [[]]
  let used = 0
  for (const book of books.map(spineEl)) {
    const w = +book.dataset.w + GAP
    if (used + w > avail && rows.at(-1).length) { rows.push([]); used = 0 }
    rows.at(-1).push(book)
    used += w
  }
  rows.forEach((row, r) => {
    const isLast = r === rows.length - 1
    let free = avail - row.reduce((s, b) => s + +b.dataset.w + GAP, 0)
    const items = [...row]
    // the last shelf gets a little pile of books lying flat when there's room
    if (isLast && row.length >= 5 && free > 270) {
      const pile = []
      let thick = 0
      while (pile.length < 3 && items.length > 3 && thick + +items.at(-1).dataset.w <= 150) {
        const b = items.pop()
        thick += +b.dataset.w
        pile.unshift(b)
      }
      if (pile.length >= 2) {
        const len = Math.max(...pile.map(b => +b.dataset.h))
        for (const b of pile) {
          b.classList.add('flat')
          b.style.setProperty('--shift', ((+b.dataset.hash >>> 9) % 13 - 6) + 'px')
        }
        free += thick + pile.length * GAP - (len + 18)
        items.push(el('div', { class: 'pile' }, ...pile.reverse()))
      } else items.push(...pile)
    }
    // a book leaning against its neighbours where a shelf isn't full
    const lastBook = items.findLast(x => x.classList.contains('book'))
    if (lastBook && items.length > 2 && free > 70) {
      const deg = 3 + (+lastBook.dataset.hash >>> 13) % 6
      const gap = Math.ceil(+lastBook.dataset.h * Math.sin(deg * Math.PI / 180)) + 2
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
    : !b.lastOpened ? 'Not started' : f >= 0.995 ? 'Finished' : `${pct.format(f)} read${b.chapter ? ' · ' + b.chapter : ''}`
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

let lastLibWidth = 0, libResizeTimer
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width)
  if (w === lastLibWidth) return
  lastLibWidth = w
  if (libMode !== 'shelf' || document.body.dataset.view !== 'library') return
  clearTimeout(libResizeTimer)
  libResizeTimer = setTimeout(renderLibrary, 120)
}).observe($('#library'))

let menuBook = null
function showCardMenu(b, rect) {
  menuBook = b
  const m = $('#card-menu')
  m.hidden = false
  const { width, height } = m.getBoundingClientRect()
  m.style.left = Math.min(rect.left, innerWidth - width - 8) + 'px'
  m.style.top = (rect.bottom + height + 8 > innerHeight ? rect.top - height - 4 : rect.bottom + 4) + 'px'
}
$('#card-menu').addEventListener('click', async e => {
  const action = e.target.closest('button')?.dataset.cm
  const b = menuBook
  $('#card-menu').hidden = true
  if (!b || !action) return
  if (action === 'open') openBook(b.path)
  else if (action === 'folder') api.showInFolder(b.path).catch(() => toast('File not found', 'error'))
  else if (action === 'reset') { await api.library.upsert(b.path, { cfi: null, fraction: 0, lastOpened: null, chapter: null }); refreshLibrary() }
  else if (action === 'remove') { await api.library.remove(b.id); refreshLibrary(); toast(`Removed “${b.title}” (the file was not deleted)`) }
})

async function importPaths(paths) {
  const ids = await Promise.all(paths.map(p => api.bookId(p).catch(() => null)))
  const todo = paths.filter((p, i) => ids[i] && !libCache[ids[i]])
  let ok = 0, failed = 0
  for (const [i, p] of todo.entries()) {
    showLoading(`Importing ${i + 1} of ${todo.length}…\n${baseName(p)}`)
    try {
      const { name, book } = await loadFile(p)
      const cover = await makeThumb(book)
      await api.library.upsert(p, { ...bookInfo(book, name), cover, spineColor: cover ? await spineColorFrom(cover) : null })
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
  toast([`Added ${ok} book${ok === 1 ? '' : 's'}`, skipped && `${skipped} already in library`, failed && `${failed} couldn't be read`]
    .filter(Boolean).join(' · '), failed ? 'error' : '')
}

async function handlePaths(paths) {
  paths = paths.filter(p => SUPPORTED.test(p))
  if (!paths.length) return toast('No supported files (EPUB, MOBI, AZW3, PDF, FB2, CBZ)', 'error')
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
  if (name === 'library') document.title = 'Inkleaf Reader'
}

async function openBook(path) {
  if (current?.path === path && view) return showView('reader')
  await closeBook()
  showLoading('Opening…')
  try {
    const id = await api.bookId(path)
    const { name, file, book } = await loadFile(path)
    const info = bookInfo(book, name)
    const prev = libCache[id]
    const extra = {}
    if (!prev?.cover) extra.cover = await makeThumb(book)
    const coverForColor = extra.cover ?? prev?.cover
    if (!prev?.spineColor && coverForColor) extra.spineColor = await spineColorFrom(coverForColor)
    const entry = await api.library.upsert(path, { ...info, lastOpened: Date.now(), ...extra })
    libCache[entry.id] = entry
    current = { path, id: entry.id, file, ...info }
    pagerCache = new Map()
    pager = null
    if (entry.pagination?.key) pagerCache.set(entry.pagination.key, entry.pagination.pages)
    annotations = (entry.annotations ?? []).map(a => ({ ...a }))
    bookmarks = entry.bookmarks ?? []

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
    view.addEventListener('link', () => { linkFollowed = true })
    view.history.addEventListener('index-change', () => {
      $('#history-back').hidden = !(linkFollowed && view.history.canGoBack)
    })
    for (const a of annotations) {
      try { a.index = view.resolveNavigation(a.value)?.index } catch { a.index = -1 }
    }

    // header / drawer
    document.title = `${info.title} — Inkleaf Reader`
    $('#book-title').textContent = info.title
    $('#chapter-title').textContent = info.author
    $('#drawer-title').textContent = info.title
    $('#drawer-author').textContent = info.author
    const cover = libCache[entry.id]?.cover
    if (cover) $('#drawer-cover').src = cover; else $('#drawer-cover').removeAttribute('src')
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
  hidePopovers(); closePanels()
  if (!view) return
  pageAnim?.finish()
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
let posTimer = null
let pendingPos = null
function queuePosition(data) {
  pendingPos = { path: current.path, data }
  clearTimeout(posTimer)
  posTimer = setTimeout(flushPosition, 700)
}
async function flushPosition() {
  clearTimeout(posTimer)
  if (!pendingPos) return
  const { path, data } = pendingPos
  pendingPos = null
  const entry = await api.library.upsert(path, data)
  libCache[entry.id] = entry
}
const persistNotes = () => current && api.library.upsert(current.path, {
  annotations: annotations.map(({ index, ...a }) => a),
  bookmarks,
})
window.addEventListener('beforeunload', () => { if (pendingPos) api.library.upsert(pendingPos.path, pendingPos.data) })

// ----- relocation
let sliderDragging = false
const fmtMin = m => m < 1 ? '< 1 min' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`

function onRelocate(e) {
  const d = e.detail
  lastLoc = d
  const { fraction = 0, location, tocItem, pageItem, time } = d
  if (!sliderDragging) $('#progress').value = fraction
  $('#chapter-title').textContent = tocItem?.label?.trim() || current?.author || ''
  updatePageNumbers()
  $('#loc-right').textContent = !view?.isFixedLayout && time && S.flow === 'paginated' && time.section > 0
    ? `${pct.format(fraction)} · ${fmtMin(time.section)} left in chapter` : pct.format(fraction)
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
let pagerSaveTimer = null
const wait = ms => new Promise(r => setTimeout(r, ms))

function layoutKey() {
  const r = $('#stage').getBoundingClientRect()
  return JSON.stringify([Math.round(r.width), Math.round(r.height), S.fontFamily, S.fontSize,
    S.lineHeight, S.gap, S.maxWidth, S.columns, S.justify, S.hyphenate])
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
    p.setAttribute('flow', 'paginated')
    p.setAttribute('gap', S.gap + '%')
    p.setAttribute('margin', '28px')
    p.setAttribute('max-inline-size', S.maxWidth + 'px')
    p.setAttribute('max-column-count', String(S.columns))
    host.append(p)
    p.open(book)
    p.setStyles(bookCSS(S))
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
      pages[i] = Math.max(1, p.pages - 2) * perSpread
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
  const actual = textSpreads * perSpread
  if (pager.pages[index] !== actual && pager.pages[index] > 0) {
    pager.pages[index] = actual
    setPager(pager.key, pager.pages, true)
    pagerCache.set(pager.key, pager.pages)
    clearTimeout(pagerSaveTimer)
    const { path } = current, saved = { key: pager.key, pages: pager.pages }
    pagerSaveTimer = setTimeout(() => api.library.upsert(path, { pagination: saved }), 2000)
  }
  const spread = Math.min(Math.max(0, r.page - 1), textSpreads - 1)
  const first = pager.starts[index] + spread * perSpread + 1
  feet.forEach((f, c) => { f.textContent = first + c <= pager.total ? String(first + c) : '' })
  const last = Math.min(first + perSpread - 1, pager.total)
  left.textContent = `Page ${first}${last > first ? '–' + last : ''} of ${pager.total}`
}

new ResizeObserver(() => { if (view) schedulePagination(700) }).observe($('#stage'))

// ----- per-section document hooks
function frameOffset(doc) {
  const r = doc.defaultView?.frameElement?.getBoundingClientRect()
  return r ? { x: r.left, y: r.top } : { x: 0, y: 0 }
}

function onDocLoad({ detail: { doc, index } }) {
  if (view?.isFixedLayout) attachFxlLayer(doc, index)
  doc.addEventListener('keydown', handleKey)
  doc.addEventListener('wheel', handleWheel, { passive: false })
  doc.addEventListener('click', e => handleDocClick(e, doc))
  doc.addEventListener('pointerup', () => checkSelection(doc, index))
  doc.addEventListener('keyup', e => { if (e.shiftKey) checkSelection(doc, index) })
  doc.addEventListener('pointerdown', () => {
    if (noteEdit) closeNoteEditor(true)
    const sel = doc.getSelection()
    suppressClick = anyOverlayOpen() || !!(sel && !sel.isCollapsed)
    hideSelPop()
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
    const dir = e.deltaY < 0 ? 1 : -1
    return view.isFixedLayout ? zoomStep(dir) : changeFontSize(dir)
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

function isSpread(stageRect) {
  if (view.isFixedLayout || S.columns < 2 || stageRect.width <= stageRect.height) return false
  const doc = view.renderer.getContents?.()[0]?.doc
  const colW = doc ? parseFloat(getComputedStyle(doc.documentElement).columnWidth) : NaN
  return colW > 0 ? stageRect.width >= colW * 2 : stageRect.width * (1 - S.gap / 100) > S.maxWidth
}

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
  if (effect === 'none' || S.flow !== 'paginated' || matchMedia('(prefers-reduced-motion: reduce)').matches)
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
  const spread = isSpread(r)
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
  } else if (btn.dataset.sel === 'remove') {
    await eraseHighlight(st.annotation)
    annotations.splice(annotations.indexOf(st.annotation), 1)
    renderHighlights(); persistNotes()
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
async function addHighlight(a) {
  annotations.push(a)
  annotations.sort((x, y) => (x.index - y.index) || CFI.compare(x.value, y.value))
  await paintHighlight(a)
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
    el('span', { text: `${annotations.length} highlight${annotations.length === 1 ? '' : 's'} · ${noted} note${noted === 1 ? '' : 's'}` }),
    exportBtn))
  for (const a of annotations) {
    const del = el('button', { class: 'icon-btn n-del', title: 'Delete highlight and note' }, icon('i-close'))
    del.onclick = async e => {
      e.stopPropagation()
      if (a.note && !confirm('Delete this highlight and its note?')) return
      await eraseHighlight(a)
      annotations.splice(annotations.indexOf(a), 1)
      renderHighlights(); persistNotes()
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
      annotations.push(a)
      annotations.sort((x, y) => (x.index - y.index) || CFI.compare(x.value, y.value))
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
  lines.push(`Highlights and notes exported from Inkleaf Reader on ${dateFmt.format(Date.now())}.`, '')
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
  if (gen === searchGen) status.textContent = count ? `${count} result${count === 1 ? '' : 's'}` : 'No results'
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
  $('#card-menu').hidden = true
  hideSelPop()
  if (noteEdit) closeNoteEditor(true)
}
const anyOverlayOpen = () => !$('#settings').hidden || !$('#sel-pop').hidden || !$('#note-editor').hidden || !!$('.panel.open')
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

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#settings, #btn-settings')) $('#settings').hidden = true
  if (!e.target.closest('#card-menu')) $('#card-menu').hidden = true
  if (!e.target.closest('#sel-pop')) hideSelPop()
  if (noteEdit && !e.target.closest('#note-editor')) closeNoteEditor(true) // clicking away keeps the note
})

// ----- keyboard
function handleKey(e) {
  const k = e.key
  const ctrl = e.ctrlKey || e.metaKey
  const inField = e.target?.matches?.('input, select, textarea') && e.target.type !== 'range'
  if (ctrl && k.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return }
  if (k === 'F11') { e.preventDefault(); toggleFullscreen(); return }
  if (document.body.dataset.view !== 'reader' || !view) {
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
  else if (ctrl && (k === '=' || k === '+')) { handled(); view.isFixedLayout ? zoomStep(1) : changeFontSize(1) }
  else if (ctrl && k === '-') { handled(); view.isFixedLayout ? zoomStep(-1) : changeFontSize(-1) }
  else if (ctrl && k === '0') { handled(); view.isFixedLayout ? setSetting('pdfZoom', 'fit-page') : setSetting('fontSize', DEFAULTS.fontSize) }
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
  if (paths.length) handlePaths(paths)
}
async function importFolder() {
  showLoading('Scanning folder…')
  const paths = await api.chooseFolder()
  hideLoading()
  if (!paths.length) return
  importPaths(paths)
}
$('#lib-open').onclick = openDialog
$('#lib-import').onclick = importFolder
$('[data-action="open"]').onclick = openDialog
$('[data-action="import"]').onclick = importFolder
$('#lib-filter').oninput = renderLibrary
$('#lib-sort').onchange = () => { renderLibrary(); localStorage.setItem('sort', $('#lib-sort').value) }

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

api.onOpenFiles(paths => handlePaths(paths))

// ---------------------------------------------------------------- boot
;(async () => {
  try { const s = localStorage.getItem('sort'); if (s) $('#lib-sort').value = s } catch {}
  S = { ...DEFAULTS, ...(await api.settings.get()) }
  await preloadBundledFonts()
  initSettingsUI()
  applySettings()
  await refreshLibrary()
  const pending = await api.getPendingFiles()
  if (pending.length) handlePaths(pending)
})()
