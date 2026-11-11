// Library rules shared by the desktop main process (src/main.js, through require()) and the
// Android adapter (mobile/web/api.js, through import). Plain ESM: no Node, no DOM.

export const SUPPORTED_EXTS = ['.epub', '.mobi', '.azw3', '.azw', '.kf8', '.prc', '.fb2', '.fbz', '.cbz', '.pdf']

// The extension of a file name, the way Node's path.extname sees it: from the last dot, unless
// that dot starts the name (".epub" has none) or the name is "..".
export const extname = name => {
  const base = String(name).split(/[/\\]/).pop()
  const i = base.lastIndexOf('.')
  if (i <= 0 || base === '..') return ''
  return base.slice(i)
}
export const isSupportedName = name => SUPPORTED_EXTS.includes(extname(name).toLowerCase())

// Every key the window may write to a library entry; anything else is dropped
export const LIBRARY_FIELDS = ['title', 'author', 'custom', 'customCover', 'collections', 'finishedAt', 'cover', 'coverRes',
  'originalPath', 'cfi', 'fraction', 'lastOpened', 'annotations', 'bookmarks', 'chapter', 'format', 'length', 'spineColor',
  'pagination', 'prefs', 'info']

// reading goals: minutes a day and books a year (null = no goal)
const goalNum = (v, max) => Number.isInteger(v) && v >= 1 && v <= max ? v : null
export const cleanGoals = g => ({ dailyMinutes: goalNum(g?.dailyMinutes, 1440), yearBooks: goalNum(g?.yearBooks, 1000) })

// One stats.add call, clamped (at most 6 hours and 10,000 pages); null when there's nothing to add
export function cleanStatsAdd(add) {
  const day = String(add?.day ?? '')
  const ms = Math.max(0, Math.min(Number(add?.ms) || 0, 6 * 3600e3))
  const pages = Math.max(0, Math.min(Math.round(Number(add?.pages) || 0), 10000))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (!ms && !pages)) return null
  const bookId = typeof add.bookId === 'string' && /^[0-9a-f]{16}$/.test(add.bookId) ? add.bookId : null
  return { day, ms, pages, bookId }
}
export function applyStatsAdd(stats, add) {
  const a = cleanStatsAdd(add)
  if (!a) return false
  const d = (stats.days[a.day] ??= { ms: 0, pages: 0 })
  d.ms += a.ms
  d.pages += a.pages
  if (a.bookId) stats.books[a.bookId] = (stats.books[a.bookId] ?? 0) + a.ms
  return true
}

// A book's file name inside a backup, chosen so the backup restores on any system: Windows
// forbids <>:"/\|?* and control characters, and device names such as CON or NUL, which
// Linux allows. Names that come from Windows never contain these, so they don't change.
export const portableName = name => {
  const ext = extname(name)
  let stem = name.slice(0, name.length - ext.length).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  if (!stem || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(stem)) stem = '_' + stem
  return stem + ext
}
export const numbered = (name, n) => { const ext = extname(name); return `${name.slice(0, name.length - ext.length)} (${n})${ext}` }
// a backup's book entry is one plain file name, never a path
export const isPlainName = n => typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !/[/\\\x00]/.test(n)

const pad2 = n => String(n).padStart(2, '0')
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
export const ymdhm = (d = new Date()) => `${ymd(d)} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`

// ---------- look-ups and book details (the network calls themselves are platform-specific)
export const lookupTerm = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
export const definitionURL = word => `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}?redirect=true`
export const wikipediaURL = (title, lang) => {
  lang = /^[a-z]{2,3}$/.test(lang) ? lang : 'en'
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`
}
// cover images for the results: only from the two services below
export const coverURLAllowed = url => {
  const u = new URL(String(url))
  return u.protocol === 'https:' && /^(is\d+-ssl\.mzstatic\.com|covers\.openlibrary\.org)$/.test(u.hostname)
}

// Book details search (Edit details → Find online). Apple Books has large, clean covers;
// Open Library adds other editions and older books. fetchJSON(url) returns the parsed JSON,
// or null for a 404, and throws for other failures.
const enc = encodeURIComponent
const appleArt = (url, size) => url?.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}bb.jpg`) ?? null
const fromApple = r => ({
  source: 'Apple Books', title: r.trackName, author: r.artistName, year: r.releaseDate?.slice(0, 4),
  thumb: appleArt(r.artworkUrl100, '300x300'), cover: appleArt(r.artworkUrl100, '1600x1600'),
})
const OL_FIELDS = 'key,title,author_name,cover_i,first_publish_year'
const fromOpenLibrary = d => ({
  source: 'Open Library', title: d.title, author: d.author_name?.slice(0, 2).join(', '), year: d.first_publish_year,
  thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg?default=false` : null,
  cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg?default=false` : null,
})
const normText = t => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export async function searchBookInfo(opts = {}, fetchJSON) {
  const title = lookupTerm(opts.title), author = lookupTerm(opts.author)
  const query = lookupTerm(opts.query) || `${title} ${author}`.trim()
  if (!query) return []
  const tasks = [
    fetchJSON(`https://itunes.apple.com/search?media=ebook&entity=ebook&limit=15&term=${enc(query)}`)
      .then(r => (r?.results ?? []).map(fromApple)),
    fetchJSON(`https://openlibrary.org/search.json?q=${enc(query)}&limit=12&fields=${OL_FIELDS}`)
      .then(r => (r?.docs ?? []).map(fromOpenLibrary)),
  ]
  if (title && author) tasks.push(
    fetchJSON(`https://openlibrary.org/search.json?title=${enc(title)}&author=${enc(author)}&limit=8&fields=${OL_FIELDS}`)
      .then(r => (r?.docs ?? []).map(fromOpenLibrary)))
  const settled = await Promise.allSettled(tasks)
  if (settled.every(s => s.status === 'rejected')) throw new Error('offline')
  // best matches first: how many of the searched words appear in the title and author
  const words = normText(query).split(' ').filter(w => w.length > 1)
  const seen = new Set()
  return settled.flatMap(s => s.status === 'fulfilled' ? s.value : [])
    .filter(r => r.title)
    .map((r, i) => {
      const text = normText(`${r.title} ${r.author ?? ''}`)
      return { ...r, score: words.filter(w => text.includes(w)).length + (r.cover ? 0.5 : 0), order: i }
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter(r => {
      const k = `${normText(r.title)}|${normText(r.author)}|${r.cover ?? ''}`
      return !seen.has(k) && seen.add(k)
    })
    .slice(0, 24)
    .map(({ score, order, ...r }) => r)
}
