// window.api for Android: the same contract as src/preload.js + src/main.js on desktop, built on
// the SimplyReader native plugin (mobile/android/.../SimplyReaderPlugin.java). The library
// rules are shared with desktop (src/shared/rules.mjs); the data files have the same shapes,
// so backups move between desktop and Android.
//
// Books are referred to as "sr-book:<file name>", the file being filesDir/books/<file name>.
// A book's id is sha1(ref).slice(0, 16), the desktop formula applied to the ref.
import {
  LIBRARY_FIELDS, cleanGoals, applyStatsAdd, portableName, numbered, isPlainName, isSupportedName, ymd, ymdhm,
  lookupTerm, definitionURL, wikipediaURL, coverURLAllowed, searchBookInfo,
} from '../shared/rules.mjs'

const Cap = window.Capacitor
const SR = Cap.registerPlugin('SimplyReader')
const App = Cap.registerPlugin('App')
document.documentElement.classList.add('android')

// ---------------------------------------------------------------- storage
let dirs = null // { filesDir, cacheDir }
const info = () => (dirs ??= SR.info())
const fileURL = async rel => Cap.convertFileSrc(`${(await info()).filesDir}/${rel}`)

// a file that exists but can't be parsed is set aside (not overwritten by the next save)
async function readJSON(path, fallback) {
  const { text } = await SR.readText({ path })
  if (text == null) return fallback
  try { return JSON.parse(text) } catch (e) {
    console.error('unreadable', path, e)
    await SR.rename({ from: path, to: `${path}.unreadable-${Date.now()}`, ifExists: true }).catch(() => {})
    return fallback
  }
}
// Writes to one file are serialized and coalesced (as on desktop): calls made while a write
// runs share one trailing write of the latest data. Natively: temp file, fsync, rename. The
// promise rejects when the write fails, so callers can keep what they meant to save.
const writers = new Map()
function writeJSON(path, data) {
  let w = writers.get(path)
  if (!w) writers.set(path, w = { running: Promise.resolve(), next: null, data: null })
  w.data = data
  w.next ??= w.running.catch(() => {}).then(async () => {
    w.next = null
    await SR.writeText({ path, text: JSON.stringify(w.data) })
  })
  return (w.running = w.next)
}
const exists = async (path, root = 'files') => (await SR.stat({ path, root })).exists
const listDir = async (path, root = 'files') => (await SR.list({ path, root })).names
const removePath = (path, root = 'files') => SR.remove({ path, root, recursive: true })

// ---------------------------------------------------------------- book references and ids
const REF = /^sr-book:(.+)$/
function refName(ref) {
  const m = typeof ref === 'string' && REF.exec(ref)
  if (!m || !isPlainName(m[1]) || /[\x00-\x1f]/.test(m[1]) || !isSupportedName(m[1])) throw new Error('Unsupported file type')
  return m[1]
}
const bookFile = ref => 'books/' + refName(ref)
const isRef = p => { try { refName(p); return true } catch { return false } }
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const bookId = async ref => hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ref))).slice(0, 16)

// Covers: library.json keeps the desktop form (app://reader/__covers/<id>.jpg?v=…) so it and
// backups look the same everywhere; the window gets a URL it can load here.
const COVERS_ROUTE = '/__covers/'
const STORED_COVER = /^app:\/\/reader\/__covers\/([0-9a-f]{16})\.jpg(\?.*)?$/
let shownCoverBase = null // https://localhost/_capacitor_file_/…/files/covers/
const coverBase = async () => (shownCoverBase ??= await fileURL('covers/'))
const shownCover = (cover, base) => {
  const m = typeof cover === 'string' && STORED_COVER.exec(cover)
  return m ? `${base}${m[1]}.jpg${m[2] ?? ''}` : cover
}
const storedCover = (cover, base) => typeof cover === 'string' && cover.startsWith(base)
  ? `app://reader${COVERS_ROUTE}${cover.slice(base.length)}` : cover
const forWindow = async entry => {
  const e = structuredClone(entry)
  e.cover = shownCover(e.cover, await coverBase())
  if (e.cover === undefined) delete e.cover
  return e
}

// ---------------------------------------------------------------- startup: finish an interrupted restore
let startup = null
const ready = () => (startup ??= finishInterruptedRestore().catch(e => console.error('could not finish an interrupted restore', e)))

let library = null, libraryLoad = null
const loadLibrary = () => (libraryLoad ??= ready().then(() => readJSON('library.json', { books: {} })).then(l => {
  library = l && typeof l === 'object' ? l : { books: {} }
  library.books ??= {}
  return library
}))
const saveLibrary = () => writeJSON('library.json', library)
let settings = null, settingsLoad = null
const loadSettings = () => (settingsLoad ??= ready().then(() => readJSON('settings.json', {})).then(s => (settings = s && typeof s === 'object' ? s : {})))
const saveSettings = () => writeJSON('settings.json', settings)
let stats = null, statsLoad = null
const loadStats = () => (statsLoad ??= ready().then(() => readJSON('stats.json', {})).then(s => (stats = { days: {}, books: {}, ...s })))

// ---------------------------------------------------------------- library
async function libraryGet() {
  await loadLibrary()
  const stored = new Set(await listDir('books'))
  const base = await coverBase()
  const books = {}
  for (const [id, b] of Object.entries(library.books)) {
    b.missing = !isRef(b.path) || !stored.has(refName(b.path))
    const e = structuredClone(b)
    e.cover = shownCover(e.cover, base)
    if (e.cover === undefined) delete e.cover
    books[id] = e
  }
  return { ...structuredClone({ ...library, books: {} }), books }
}

async function libraryUpsert(ref, data) {
  const name = refName(ref)
  await loadLibrary()
  const id = await bookId(ref)
  // never create an entry for a file that isn't there
  if (!library.books[id] && !await exists('books/' + name)) throw new Error('File not found')
  const prev = library.books[id] ?? { id, path: ref, added: Date.now(), annotations: [], bookmarks: [] }
  data = { ...data }
  if (typeof data.cover === 'string' && data.cover.startsWith('data:image/jpeg;base64,')) {
    await SR.writeBase64({ path: `covers/${id}.jpg`, data: data.cover.slice(data.cover.indexOf(',') + 1) })
    data.cover = `app://reader${COVERS_ROUTE}${id}.jpg?v=${Date.now()}`
  } else if (typeof data.cover === 'string') data.cover = storedCover(data.cover, await coverBase())
  // copies, as IPC would make: the window keeps changing its own objects
  for (const k of LIBRARY_FIELDS) if (k in data) prev[k] = structuredClone(data[k])
  prev.path = ref
  library.books[id] = prev
  await saveLibrary() // rejects if it couldn't be saved, so the window keeps the change pending
  return forWindow(prev)
}

async function libraryRemove(id) {
  await loadLibrary()
  const removed = library.books[id]
  delete library.books[id]
  try { await saveLibrary() } catch (e) {
    if (removed) library.books[id] = removed
    throw e
  }
  if (removed?.path && isRef(removed.path) && !Object.values(library.books).some(b => b.path === removed.path))
    await removePath(bookFile(removed.path)).catch(console.error)
  if (/^[0-9a-f]{16}$/.test(id)) await removePath(`covers/${id}.jpg`).catch(console.error)
}

async function readBook(ref) {
  const name = refName(ref)
  const res = await fetch(await fileURL('books/' + encodeURIComponent(name)))
  if (!res.ok) throw new Error(res.status === 404 ? 'File not found' : `Couldn’t read the book (${res.status})`)
  return { name, data: new Uint8Array(await res.arrayBuffer()) }
}

// ---------------------------------------------------------------- importing
const rejected = (refs, errors) => Object.defineProperty(refs, 'rejected', { value: errors ?? [] })
async function chooseFiles() {
  const r = await SR.pickBooks()
  return rejected(r.refs ?? [], r.errors)
}
async function getPendingFiles() {
  const r = await SR.takeOpenedFiles()
  return rejected(r.refs ?? [], r.errors)
}
function onOpenFiles(cb) {
  SR.addListener('openFiles', r => cb(rejected(r.refs ?? [], r.errors)))
}

async function chooseImage() {
  const r = await SR.pickFile({ types: ['image/*'], dest: 'picked/cover', destRoot: 'cache', maxBytes: 40 * 1024 * 1024 })
  if (r.cancelled) return null
  const res = await fetch(Cap.convertFileSrc(`${(await info()).cacheDir}/picked/cover`) + `?t=${Date.now()}`)
  const data = new Uint8Array(await res.arrayBuffer())
  await removePath('picked', 'cache').catch(() => {})
  return { name: r.name || 'cover', data }
}

// ---------------------------------------------------------------- stats, goals, settings
async function statsAdd(add) {
  await loadStats()
  if (applyStatsAdd(stats, add)) await writeJSON('stats.json', stats)
  return structuredClone(stats)
}

// ---------------------------------------------------------------- network (native, fixed hosts)
async function fetchJSON(url) {
  const r = await SR.httpGet({ url, kind: 'json' })
  if (r.status === 404) return null
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`)
  return JSON.parse(r.text)
}
async function fetchCoverImage(url) {
  if (!coverURLAllowed(url)) throw new Error('Image host not allowed')
  const r = await SR.httpGet({ url: new URL(String(url)).href, kind: 'image' })
  if (r.status < 200 || r.status >= 300 || !r.base64) return null
  const type = r.type ?? ''
  if (!type.startsWith('image/')) return null
  const data = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0))
  if (data.length < 200 || data.length > 20 * 1024 * 1024) return null
  return { type, data }
}

// ---------------------------------------------------------------- backup & restore
// A backup is the same .zip as on desktop. It's written to the cache, then saved where the user
// chooses with Android's file picker. Restoring copies the chosen file to the cache first.
const BACKUP_TMP = 'backup' // in the cache
const SAFETY_DIR = 'backups' // "Before restore …" copies, in private storage
const SAFETY_KEEP = 3 // phones have less room than computers: older copies are deleted
let uiPrefs = null
const setPrefs = p => { if (p && typeof p === 'object' && JSON.stringify(p).length < 10000) uiPrefs = p }
let backupJob = Promise.resolve()
const exclusive = job => {
  const run = backupJob.then(job)
  backupJob = run.catch(() => {})
  return run
}

// writes the archive to `dest` (relative to `root`); returns { size, books }
async function createBackup(dest, root) {
  await Promise.all([loadLibrary(), loadStats(), loadSettings()])
  const lib = structuredClone(library)
  const manifest = { app: 'Simply Reader', format: 1, created: Date.now(), books: {} }
  const stored = new Set(await listDir('books'))
  const covers = new Set(await listDir('covers'))
  const entries = [], used = new Set()
  for (const b of Object.values(lib.books ?? {})) {
    delete b.missing
    if (!b?.id || !isRef(b.path) || !stored.has(refName(b.path))) continue // a missing file: keep the entry only
    const safe = portableName(refName(b.path))
    let name = safe
    for (let n = 2; used.has(name.toLowerCase()); n++) name = numbered(safe, n)
    used.add(name.toLowerCase())
    manifest.books[b.id] = name
    entries.push({ name: 'books/' + name, path: bookFile(b.path) })
    if (b.cover?.includes(COVERS_ROUTE) && covers.has(b.id + '.jpg')) entries.push({ name: `covers/${b.id}.jpg`, path: `covers/${b.id}.jpg` })
  }
  entries.unshift(
    { name: 'manifest.json', text: JSON.stringify(manifest) },
    { name: 'library.json', text: JSON.stringify(lib) },
    { name: 'stats.json', text: JSON.stringify(stats) },
    { name: 'settings.json', text: JSON.stringify({ reader: settings.reader ?? {}, goals: settings.goals ?? {} }) },
    ...(uiPrefs ? [{ name: 'prefs.json', text: JSON.stringify(uiPrefs) }] : []))
  const { size } = await SR.zipCreate({ dest, root, entries })
  return { size, books: Object.keys(lib.books ?? {}).length }
}

async function backupCreate(prefs) {
  setPrefs(prefs)
  await loadSettings()
  const name = `Simply Reader backup ${ymd()}.zip`
  const tmp = `${BACKUP_TMP}/${name}`
  try {
    const r = await exclusive(() => createBackup(tmp, 'cache'))
    const saved = await SR.saveDocument({ path: tmp, root: 'cache', name, mime: 'application/zip' })
    if (!saved.saved) return null
    const c = (settings.backup ??= {})
    Object.assign(c, { lastAt: Date.now(), lastPath: saved.name || name })
    await saveSettings().catch(console.error)
    return { path: saved.name || name, size: r.size, books: r.books }
  } finally {
    await removePath(BACKUP_TMP, 'cache').catch(() => {})
  }
}

// ----- restore
const INCOMING = 'restore/incoming.zip' // in the cache
const STAGING = 'restore-staging', REPLACED = 'restore-replaced', JOURNAL = 'restore-journal.json'
const SWAPPED = ['books', 'covers']
const STAGED_JSON = ['library.json', 'stats.json', 'settings.json']
const unchanged = e => new Error(`${String(e?.message ?? e).replace(/\.$/, '')}. Your library wasn’t changed.`, { cause: e })

async function openBackup(path, root) {
  const { names, sizes } = await SR.zipList({ path, root })
  const size = new Map(names.map((n, i) => [n, sizes[i]]))
  const parse = async n => {
    if (!size.has(n)) return null
    const { text } = await SR.zipReadText({ path, root, name: n, maxBytes: 256 * 1024 * 1024 })
    try { return JSON.parse(text) } catch { return null }
  }
  // a damaged file throws; one that isn't valid JSON counts as missing
  const [manifest, lib, statsData, settingsData, prefs] =
    await Promise.all(['manifest', 'library', 'stats', 'settings', 'prefs'].map(n => parse(n + '.json')))
  const bk = { path, root, has: n => size.has(n), size: n => size.get(n) ?? 0,
    manifest, lib, stats: statsData, settings: settingsData, prefs }
  if (bk.manifest?.app !== 'Simply Reader' || !bk.lib?.books || typeof bk.lib.books !== 'object')
    throw new Error('This file is not a Simply Reader backup')
  return bk
}

async function backupPick() {
  await ready() // its clean-up empties the folder the backup is copied to
  const r = await SR.pickFile({ types: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], dest: INCOMING, destRoot: 'cache' })
  if (r.cancelled) return null
  try {
    const bk = await openBackup(INCOMING, 'cache')
    return { path: 'cache:' + INCOMING, name: r.name, created: bk.manifest.created ?? null, books: Object.keys(bk.lib.books).length }
  } catch (e) {
    await removePath('restore', 'cache').catch(() => {})
    throw e
  }
}

// unpack next to the library without touching it; returns what the library becomes
async function stageRestore(bk) {
  await Promise.all([removePath(STAGING), removePath(REPLACED)])
  await SR.mkdir({ path: `${STAGING}/books` })
  await SR.mkdir({ path: `${STAGING}/covers` })
  const live = new Set(await listDir('books'))
  const books = {}, idMap = new Map(), staged = new Set(), keep = new Set(), extract = []
  for (const [oldId, entry] of Object.entries(bk.lib.books)) {
    if (!entry || typeof entry !== 'object') continue
    const zipName = bk.manifest.books?.[oldId]
    let p = entry.path
    if (isPlainName(zipName) && isSupportedName(zipName) && bk.has('books/' + zipName)) {
      // stored under a name every system accepts (a backup made elsewhere may use others)
      const safe = portableName(zipName)
      let fileName = safe
      for (let n = 2; staged.has(fileName.toLowerCase()); n++) fileName = numbered(safe, n)
      p = 'sr-book:' + fileName
      extract.push({ name: 'books/' + zipName, dest: `${STAGING}/books/${fileName}` })
      staged.add(fileName.toLowerCase())
    } else if (isRef(p) && live.has(refName(p))) keep.add(refName(p)) // not in the backup: keep this device's copy
    if (typeof p !== 'string' || !p) continue
    const id = await bookId(p)
    const e = { ...entry, id, path: p }
    delete e.missing
    delete e.pagination // page counts depend on the fonts and screen of the device that made them
    const cover = `covers/${oldId}.jpg`
    if (/^[0-9a-f]{16}$/.test(oldId) && bk.has(cover)) {
      extract.push({ name: cover, dest: `${STAGING}/covers/${id}.jpg` })
      e.cover = `app://reader${COVERS_ROUTE}${id}.jpg?v=${Date.now()}`
    } else if (typeof e.cover === 'string' && e.cover.includes(COVERS_ROUTE)) {
      delete e.cover; delete e.coverRes // made again from the book
    }
    books[id] = e
    idMap.set(oldId, id)
  }
  // enough room for everything unpacked, plus some to spare
  const need = extract.reduce((n, x) => n + bk.size(x.name), 0) + 50e6
  const { bytes } = await SR.freeSpace({ root: 'files' })
  if (bytes < need) throw new Error(`There isn’t enough free storage on this device (about ${Math.ceil(need / 1e6)} MB needed)`)
  await SR.zipExtract({ path: bk.path, root: bk.root, items: extract, destRoot: 'files' })
  const statBooks = {}
  for (const [oldId, ms] of Object.entries(bk.stats?.books ?? {}))
    if (idMap.has(oldId) && Number.isFinite(ms)) statBooks[idMap.get(oldId)] = ms
  const next = {
    library: { ...bk.lib, books },
    stats: { days: bk.stats?.days && typeof bk.stats.days === 'object' ? bk.stats.days : {}, books: statBooks },
    reader: bk.settings?.reader && typeof bk.settings.reader === 'object' ? bk.settings.reader : settings.reader,
    goals: bk.settings?.goals && typeof bk.settings.goals === 'object' ? cleanGoals(bk.settings.goals) : settings.goals,
    keep: [...keep].filter(n => !staged.has(n.toLowerCase())),
  }
  // what the next start writes if the app stops before the restore is complete
  await SR.writeText({ path: `${STAGING}/library.json`, text: JSON.stringify(next.library) })
  await SR.writeText({ path: `${STAGING}/stats.json`, text: JSON.stringify(next.stats) })
  await SR.writeText({ path: `${STAGING}/settings.json`, text: JSON.stringify({ ...settings, reader: next.reader, goals: next.goals }) })
  return next
}

// put the staged books and covers in place; every step checks what's done, so it can run again
async function swapInStaged(keep) {
  await SR.mkdir({ path: REPLACED })
  for (const dir of SWAPPED) {
    const staged = `${STAGING}/${dir}`, replaced = `${REPLACED}/${dir}`
    if (!await exists(staged)) continue // already in place
    if (await exists(dir)) {
      if (await exists(replaced)) throw new Error(`Unexpected folder: ${replaced}`)
      await SR.rename({ from: dir, to: replaced })
    }
    await SR.rename({ from: staged, to: dir })
  }
  for (const name of keep) {
    const from = `${REPLACED}/books/${name}`, to = `books/${name}`
    if (await exists(from) && !await exists(to)) await SR.rename({ from, to })
  }
}
async function swapBack(keep) {
  for (const name of keep) {
    const from = `books/${name}`, to = `${REPLACED}/books/${name}`
    if (await exists(from) && !await exists(to)) await SR.rename({ from, to })
  }
  for (const dir of SWAPPED) {
    const staged = `${STAGING}/${dir}`, replaced = `${REPLACED}/${dir}`
    if (await exists(replaced)) {
      if (await exists(dir)) await SR.rename({ from: dir, to: staged })
      await SR.rename({ from: replaced, to: dir })
    } else if (!await exists(staged) && await exists(dir)) await SR.rename({ from: dir, to: staged })
  }
}
async function finishInterruptedRestore() {
  const job = await readJSON(JOURNAL, null)
  if (job) {
    const keep = (Array.isArray(job.keep) ? job.keep : []).filter(n => isPlainName(n))
    await swapInStaged(keep)
    for (const name of STAGED_JSON)
      await SR.rename({ from: `${STAGING}/${name}`, to: name, ifExists: true })
    await removePath(JOURNAL)
    console.log('completed an interrupted restore')
  }
  await Promise.all([removePath(STAGING), removePath(REPLACED), removePath('restore', 'cache')])
}

async function restoreBackup(file) {
  if (file !== 'cache:' + INCOMING) throw new Error('Choose a backup first')
  const bk = await openBackup(INCOMING, 'cache')
  await Promise.all([loadLibrary(), loadStats(), loadSettings()])
  let safety = null, next
  try {
    // keep what's being replaced (an empty library has nothing worth keeping)
    if (Object.keys(library.books ?? {}).length) {
      const name = `Before restore ${ymdhm()}.zip`
      await createBackup(`${SAFETY_DIR}/${name}`, 'files')
      safety = name
      const old = (await listDir(SAFETY_DIR)).filter(n => /^Before restore .*\.zip$/.test(n)).sort().reverse().slice(SAFETY_KEEP)
      for (const n of old) await removePath(`${SAFETY_DIR}/${n}`).catch(() => {})
    }
    next = await stageRestore(bk)
  } catch (e) {
    await removePath(STAGING).catch(() => {})
    throw unchanged(e)
  }
  await SR.writeText({ path: JOURNAL, text: JSON.stringify({ started: Date.now(), keep: next.keep }) })
  try {
    await swapInStaged(next.keep)
  } catch (e) {
    console.error('restore: could not put the backup in place', e)
    try {
      await swapBack(next.keep)
      await removePath(JOURNAL)
    } catch (e2) {
      console.error('restore: could not undo', e2)
      throw new Error(`The restore couldn’t finish (${e.message}). Restart Simply Reader to complete it.`, { cause: e })
    }
    await removePath(STAGING).catch(() => {})
    throw unchanged(e)
  }
  library = next.library
  stats = next.stats
  settings.reader = next.reader
  settings.goals = next.goals
  try {
    await Promise.all([saveLibrary(), writeJSON('stats.json', stats), saveSettings()])
  } catch (e) {
    throw new Error(`The restore couldn’t finish (${e.message}). Restart Simply Reader to complete it.`, { cause: e })
  }
  await removePath(JOURNAL).catch(e => console.error('restore: journal', e))
  await Promise.all([removePath(STAGING), removePath(REPLACED), removePath('restore', 'cache')]).catch(e => console.error('restore: cleanup', e))
  return { books: Object.keys(next.library.books).length, prefs: bk.prefs, safety }
}

// "Copies saved before a restore": save the newest one where the user chooses
async function exportSafetyCopy() {
  const names = (await listDir(SAFETY_DIR)).filter(n => /\.zip$/.test(n)).sort()
  const name = names.at(-1)
  if (!name) throw new Error('There are no copies saved before a restore')
  await SR.saveDocument({ path: `${SAFETY_DIR}/${name}`, root: 'files', name, mime: 'application/zip' })
}

// ---------------------------------------------------------------- window
let immersive = false
async function setFullscreen(on) {
  immersive = typeof on === 'boolean' ? on : !immersive
  await SR.setImmersive({ on: immersive })
  return immersive
}

const unavailable = what => () => Promise.reject(new Error(`${what} isn’t available on Android`))

window.api = {
  platform: 'android',
  // what this platform can do; the window hides the rest (desktop has everything)
  capabilities: { folderImport: false, showInFolder: false, dragDrop: false, pageCapture: false, autoBackup: false },
  chooseFiles,
  chooseFolder: async () => [],
  readBook,
  getPendingFiles,
  onOpenFiles,
  pathForFile: () => null,
  library: { get: libraryGet, upsert: libraryUpsert, remove: libraryRemove },
  bookId: async ref => bookId((refName(ref), ref)),
  storeBooks: async refs => (Array.isArray(refs) ? refs : []).map(ref => (refName(ref), ref)), // already stored when picked
  chooseImage,
  backup: {
    info: async () => {
      const c = (await loadSettings()).backup ?? {}
      return { lastAt: c.lastAt ?? null, lastPath: c.lastPath ?? null, auto: false, folder: null, lastAutoAt: null, error: null }
    },
    create: backupCreate,
    pick: backupPick,
    restore: file => exclusive(() => restoreBackup(file)),
    auto: unavailable('Automatic backup'),
    setPrefs: async p => setPrefs(p),
    show: async which => { if (which === 'safety') await exportSafetyCopy() },
  },
  stats: { get: async () => structuredClone(await loadStats()), add: statsAdd },
  goals: {
    get: async () => cleanGoals((await loadSettings()).goals),
    set: async g => { await loadSettings(); settings.goals = cleanGoals(g); await saveSettings(); return settings.goals },
  },
  searchBookInfo: opts => searchBookInfo(opts, fetchJSON),
  fetchCoverImage,
  lookupDefinition: async word => { word = lookupTerm(word); return word ? fetchJSON(definitionURL(word)) : null },
  lookupWikipedia: async (title, lang) => { title = lookupTerm(title); return title ? fetchJSON(wikipediaURL(title, lang)) : null },
  settings: {
    get: async () => (await loadSettings()).reader ?? {},
    set: async reader => { await loadSettings(); settings.reader = reader; await saveSettings() },
  },
  showInFolder: unavailable('Show in folder'),
  setFullscreen,
  capture: unavailable('Page capture'),
  saveText: async (name, text) => {
    const safe = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150)
    return (await SR.saveDocument({ name: safe, text: String(text), mime: 'text/markdown' })).saved
  },
  // Android only
  onBackButton: cb => App.addListener('backButton', () => cb()),
  onPause: cb => App.addListener('pause', () => cb()),
  exitApp: () => App.exitApp(),
  setChrome: ({ bg, dark }) => SR.setChrome({ bg, dark }).catch(() => {}),
}

// test hooks for the debug build (driven over the DevTools protocol; harmless otherwise)
window.__srAndroid = { info: () => info(), version: () => SR.info() }
