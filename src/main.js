'use strict'
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const files = require('./files')

const SUPPORTED = ['.epub', '.mobi', '.azw3', '.azw', '.kf8', '.prc', '.fb2', '.fbz', '.cbz', '.pdf']
const isSupported = p => SUPPORTED.includes(path.extname(p).toLowerCase())
const APP_ROOT = path.join(__dirname, '..')
// development/testing only: run against a separate data folder
if (!app.isPackaged && process.env.SIMPLY_READER_APPDATA) {
  app.setPath('appData', process.env.SIMPLY_READER_APPDATA)
  app.setPath('userData', path.join(process.env.SIMPLY_READER_APPDATA, 'Simply Reader'))
} else if (!app.isPackaged && process.env.SIMPLY_READER_USER_DATA) app.setPath('userData', process.env.SIMPLY_READER_USER_DATA)
const DATA_DIR = app.getPath('userData')

// The app used to be called "Inkleaf Reader" and kept its data in a folder of that name.
// On the first start under the new name, move that folder here (or copy it, if the old
// app is still running and holds files open). Stored book paths are fixed up when the
// library loads (relocateLegacyPaths).
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'Inkleaf Reader')
const LEGACY_BOOKS_DIR = path.join(LEGACY_DATA_DIR, 'books')
;(function moveLegacyData() {
  if (!app.isPackaged && process.env.SIMPLY_READER_USER_DATA) return
  const fss = require('node:fs')
  if (fss.existsSync(path.join(DATA_DIR, 'library.json')) || !fss.existsSync(path.join(LEGACY_DATA_DIR, 'library.json'))) return
  try {
    if (fss.existsSync(DATA_DIR)) fss.rmdirSync(DATA_DIR) // only if empty; otherwise copy below
    fss.renameSync(LEGACY_DATA_DIR, DATA_DIR)
  } catch {
    try { fss.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true, force: false, errorOnExist: false }) }
    catch (e) { console.error('could not move the old Inkleaf Reader data', e) }
  }
})()
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const STATS_FILE = path.join(DATA_DIR, 'stats.json') // reading time per day and per book
// cover images live as files next to the library (not inside library.json, which is
// rewritten on every position save) and are served to the window as app://reader/__covers/<id>.jpg
const COVERS_DIR = path.join(DATA_DIR, 'covers')
const COVERS_ROUTE = '/__covers/'
// every book opened or imported is copied here, so the library keeps working after the
// original file is moved or deleted; removing a book from the library deletes its copy
const BOOKS_DIR = path.join(DATA_DIR, 'books')

// Content-Security-Policy: book content runs in same-origin iframes, so block all
// scripts that are not shipped with the app (inline or blob scripts inside books).
const CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
].join('; ')

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

// ---------- persistence ----------
const readJSON = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}
const writers = new Map() // file -> { running, next, data }
const writeJSON = (file, data) => {
  // serialize writes per file and coalesce bursts: calls made while a write is running
  // share one trailing write of the latest data. Temp file + rename so a crash never corrupts data.
  // The promise rejects if the write fails; saveJSON is for callers that only log that.
  let w = writers.get(file)
  if (!w) writers.set(file, w = { running: Promise.resolve(), next: null, data: null })
  w.data = data
  w.next ??= w.running.catch(() => {}).then(async () => {
    w.next = null
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(w.data))
    await files.rename(tmp, file)
  })
  return (w.running = w.next)
}
const logWriteError = file => e => console.error('write failed', file, e)
const saveJSON = (file, data) => writeJSON(file, data).catch(logWriteError(file))

// everything that reads the data folder waits for this first (see finishInterruptedRestore)
let startup = null
const ready = () => (startup ??= finishInterruptedRestore()
  .catch(e => console.error('could not finish an interrupted restore', e)))

let library = null // { books: { [id]: entry } }
let libraryLoad = null
const loadLibrary = () => (libraryLoad ??= ready()
  .then(() => readJSON(LIBRARY_FILE, { books: {} }))
  .then(l => (library = l))
  .then(relocateLegacyPaths)
  .then(migrateToStoredBooks)
  .then(() => library))
const saveLibrary = () => writeJSON(LIBRARY_FILE, library)
let settings = null // kept in memory; settings.json is only written, never re-read
let settingsLoad = null
const loadSettings = () => (settingsLoad ??= ready().then(() => readJSON(SETTINGS_FILE, {})).then(s => (settings = s)))
const bookId = p => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16)

// ---------- stored book copies ----------
const isStored = p => path.dirname(path.resolve(p)).toLowerCase() === BOOKS_DIR.toLowerCase()
const exists = p => fs.access(p).then(() => true, () => false)
const fileHash = async p => crypto.createHash('sha1').update(await fs.readFile(p)).digest('hex')
const sameFile = async (a, b) => {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])
  return sa.size === sb.size && await fileHash(a) === await fileHash(b)
}
// copy a book into BOOKS_DIR (or find its existing copy) and return the stored path
// Each destination name is claimed while it's checked and written, so parallel imports never
// write the same file (e.g. two different "Book.epub" files and a "Book (2).epub").
const claimedNames = new Map() // lower-case destination path -> promise that settles when it's free
async function storeBook(src) {
  src = path.resolve(src)
  if (isStored(src)) return src
  await fs.mkdir(BOOKS_DIR, { recursive: true })
  const ext = path.extname(src), stem = path.basename(src, ext)
  for (let n = 1; ; n++) {
    const dest = path.join(BOOKS_DIR, n === 1 ? stem + ext : `${stem} (${n})${ext}`)
    const key = dest.toLowerCase()
    while (claimedNames.has(key)) await claimedNames.get(key)
    let release
    claimedNames.set(key, new Promise(r => (release = r))) // no await between the check and the claim
    try {
      if (!await exists(dest)) {
        const tmp = dest + '.part'
        try {
          await fs.copyFile(src, tmp)
          await files.rename(tmp, dest)
        } catch (e) { await fs.rm(tmp, { force: true }); throw e }
        return dest
      }
      if (await sameFile(src, dest)) return dest // already stored
    } finally {
      claimedNames.delete(key)
      release()
    }
  }
}

// Books stored by "Inkleaf Reader" point into its old data folder. After that folder moved
// here, point them at the new place. A book's id comes from its path, so the entry, its
// cover file and its reading time are re-keyed to the new id.
async function relocateLegacyPaths() {
  const legacy = LEGACY_BOOKS_DIR.toLowerCase() + path.sep
  const moved = []
  for (const [id, b] of Object.entries(library.books ?? {})) {
    if (!b?.path || !b.path.toLowerCase().startsWith(legacy)) continue
    const dest = path.join(BOOKS_DIR, b.path.slice(legacy.length))
    if (!await exists(dest)) continue // not moved: it still opens from the old folder
    const newId = bookId(dest)
    delete library.books[id]
    b.path = dest
    b.id = newId
    if (b.cover?.includes(COVERS_ROUTE)) {
      try {
        await fs.rename(path.join(COVERS_DIR, id + '.jpg'), path.join(COVERS_DIR, newId + '.jpg'))
        b.cover = `app://reader${COVERS_ROUTE}${newId}.jpg?v=${Date.now()}`
      } catch { delete b.cover; delete b.coverRes } // regenerated from the book on the next start
    }
    library.books[newId] = b
    moved.push([id, newId])
  }
  if (!moved.length) return
  await saveLibrary().catch(logWriteError(LIBRARY_FILE))
  await loadStats()
  for (const [from, to] of moved) {
    if (stats.books[from] == null) continue
    stats.books[to] = (stats.books[to] ?? 0) + stats.books[from]
    delete stats.books[from]
  }
  await saveJSON(STATS_FILE, stats)
}

// library entries from before books were stored: copy the file in and re-key the entry
async function migrateToStoredBooks() {
  let changed = false
  for (const [id, b] of Object.entries(library.books ?? {})) {
    if (!b?.path || isStored(b.path) || !await exists(b.path)) continue
    try {
      const dest = await storeBook(b.path)
      const newId = bookId(dest)
      delete library.books[id]
      if (library.books[newId]) continue // same book already in the library under its stored copy
      b.originalPath = b.path
      b.path = dest
      b.id = newId
      if (b.cover?.includes(COVERS_ROUTE)) {
        const from = path.join(COVERS_DIR, id + '.jpg'), to = path.join(COVERS_DIR, newId + '.jpg')
        try { await fs.rename(from, to); b.cover = `app://reader${COVERS_ROUTE}${newId}.jpg?v=${Date.now()}` }
        catch { delete b.cover; delete b.coverRes } // regenerated on the next start
      }
      library.books[newId] = b
      changed = true
    } catch (e) { console.error('could not store', b.path, e) }
  }
  if (changed) await saveLibrary().catch(logWriteError(LIBRARY_FILE))
}

// ---------- window ----------
let win = null
let pendingOpen = [] // files passed on the command line before the window is ready

const filesFromArgv = argv => argv.slice(1)
  .filter(a => !a.startsWith('-') && isSupported(a))
  .map(a => path.resolve(a))

const openExternalIfWeb = url => { if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url) }

const createWindow = async () => {
  await loadSettings()
  const bounds = settings.windowBounds ?? { width: 1200, height: 850 }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#1d1d21',
    title: 'Simply Reader',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  Menu.setApplicationMenu(null)
  if (settings.windowMaximized) win.maximize()

  const saveBounds = async () => {
    if (!win || win.isDestroyed()) return
    // capture synchronously: the window is gone after the first await
    const maximized = win.isMaximized()
    const bounds = !maximized && !win.isFullScreen() ? win.getBounds() : null
    settings.windowMaximized = maximized
    if (bounds) settings.windowBounds = bounds
    await saveJSON(SETTINGS_FILE, settings)
  }
  win.on('close', saveBounds)

  // never navigate the app window away; open web links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault()
      openExternalIfWeb(url)
    }
  })
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged)
      win.webContents.toggleDevTools()
  })

  win.loadURL('app://reader/src/renderer/index.html')

  // development-only: run an external test driver script (never active in packaged builds)
  if (!app.isPackaged && process.env.SIMPLY_READER_TEST_SCRIPT) {
    win.webContents.on('console-message', e => console.log(`[renderer:${e.level}] ${e.message}`))
    win.webContents.once('did-finish-load', () => {
      require(process.env.SIMPLY_READER_TEST_SCRIPT)(win, app).catch(e => console.error(e)).finally(() => app.quit())
    })
  }
}

// single instance: a second launch (e.g. double-clicking a book) opens it in the existing window
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      if (files.length) win.webContents.send('open-files', files)
    }
  })

  app.whenReady().then(async () => {
    protocol.handle('app', async request => {
      const { pathname } = new URL(request.url)
      if (pathname.startsWith(COVERS_ROUTE)) {
        const name = path.basename(decodeURIComponent(pathname))
        if (!/^[0-9a-f]{16}\.jpg$/.test(name)) return new Response('Not found', { status: 404 })
        try {
          return new Response(await fs.readFile(path.join(COVERS_DIR, name)),
            { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } })
        } catch { return new Response('Not found', { status: 404 }) }
      }
      const filePath = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)))
      // inside APP_ROOT only (a plain prefix test would also let through siblings such as
      // "app.asar.unpacked" or "simply-reader-old")
      const rel = path.relative(APP_ROOT, filePath)
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return new Response('Forbidden', { status: 403 })
      const res = await net.fetch(pathToFileURL(filePath).toString())
      if (filePath.endsWith('.html')) {
        const headers = new Headers(res.headers)
        headers.set('Content-Security-Policy', CSP)
        headers.set('Content-Type', 'text/html; charset=utf-8')
        return new Response(res.body, { status: res.status, headers })
      }
      return res
    })
    pendingOpen = filesFromArgv(process.argv)
    // the window needs no browser permissions except writing to the clipboard (Copy in the
    // selection pop-up); camera, location, notifications and the rest are refused
    const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
    loadLibrary() // start reading now; IPC handlers await the same promise
    await createWindow()
    // weekly automatic backup (if turned on): shortly after start, then every few hours
    setTimeout(() => autoBackupIfDue().catch(e => console.error(e)), 60e3)
    setInterval(() => autoBackupIfDue().catch(e => console.error(e)), 6 * 3600e3)
  })

  app.on('window-all-closed', () => app.quit())
}

// ---------- IPC ----------
const assertBookPath = p => {
  if (typeof p !== 'string' || !isSupported(p))
    throw new Error('Unsupported file type')
  return path.resolve(p)
}

ipcMain.handle('get-pending-files', () => {
  const files = pendingOpen
  pendingOpen = []
  return files
})

ipcMain.handle('choose-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open e-books',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'E-books and PDFs', extensions: SUPPORTED.map(e => e.slice(1)) },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return r.canceled ? [] : r.filePaths
})

// a cover image for "Edit details": returns its bytes, since the window can't read local files
ipcMain.handle('choose-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a cover image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  const file = r.filePaths[0]
  if ((await fs.stat(file)).size > 40 * 1024 * 1024) throw new Error('Image is too large')
  return { name: path.basename(file), data: await fs.readFile(file) }
})

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import a folder of e-books', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return []
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 8 || found.length > 5000) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full, depth + 1)
      else if (isSupported(ent.name)) found.push(full)
    }
  }
  await walk(r.filePaths[0], 0)
  return found
})

ipcMain.handle('read-book', async (_e, p) => {
  const file = assertBookPath(p)
  // a Buffer arrives in the renderer as a Uint8Array; no extra copy needed here
  return { name: path.basename(file), data: await fs.readFile(file) }
})

ipcMain.handle('library-get', async () => {
  await loadLibrary()
  // flag books whose file no longer exists
  await Promise.all(Object.values(library.books).map(async b => {
    try { await fs.access(b.path); b.missing = false } catch { b.missing = true }
  }))
  return library
})

ipcMain.handle('library-upsert', async (_e, p, data) => {
  const file = assertBookPath(p)
  await loadLibrary()
  const id = bookId(file)
  // never create an entry for a file that isn't there (e.g. a late save for a book that a
  // restore has just replaced)
  if (!library.books[id] && !await exists(file)) throw new Error('File not found')
  const prev = library.books[id] ?? { id, path: file, added: Date.now(), annotations: [], bookmarks: [] }
  // a new cover arrives as a JPEG data URL: store it as a file, keep only its URL
  if (typeof data.cover === 'string' && data.cover.startsWith('data:image/jpeg;base64,')) {
    await fs.mkdir(COVERS_DIR, { recursive: true })
    await fs.writeFile(path.join(COVERS_DIR, id + '.jpg'), Buffer.from(data.cover.slice(data.cover.indexOf(',') + 1), 'base64'))
    data = { ...data, cover: `app://reader${COVERS_ROUTE}${id}.jpg?v=${Date.now()}` }
  }
  const allowed = ['title', 'author', 'custom', 'customCover', 'collections', 'finishedAt', 'cover', 'coverRes', 'originalPath', 'cfi', 'fraction', 'lastOpened', 'annotations', 'bookmarks', 'chapter', 'format', 'length', 'spineColor', 'pagination', 'prefs', 'info']
  for (const k of allowed) if (k in data) prev[k] = data[k]
  prev.path = file
  library.books[id] = prev
  await saveLibrary().catch(logWriteError(LIBRARY_FILE))
  return prev
})

ipcMain.handle('library-remove', async (_e, id) => {
  await loadLibrary()
  const removed = library.books[id]
  delete library.books[id]
  try { await saveLibrary() }
  catch (e) { // the entry (and its stored copy) stay if the library couldn't be saved
    if (removed) library.books[id] = removed
    throw e
  }
  // the stored copy belongs to the library: delete it with the entry (never the user's original)
  if (removed?.path && isStored(removed.path) && !Object.values(library.books).some(b => b.path === removed.path))
    await fs.rm(removed.path, { force: true })
  if (/^[0-9a-f]{16}$/.test(id)) await fs.rm(path.join(COVERS_DIR, id + '.jpg'), { force: true })
})

// ---------- dictionary / Wikipedia look-up ----------
// Done here rather than in the window, whose content policy blocks all network access.
// Only these two fixed Wikimedia endpoints can be reached.
const LOOKUP_UA = 'SimplyReader/1.0 (desktop e-book reader; Electron)'
async function fetchJSON(url) {
  const res = await net.fetch(url, { headers: { 'Api-User-Agent': LOOKUP_UA, 'User-Agent': LOOKUP_UA, Accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
const lookupTerm = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
ipcMain.handle('lookup-definition', async (_e, word) => {
  word = lookupTerm(word)
  if (!word) return null
  return fetchJSON(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}?redirect=true`)
})
ipcMain.handle('lookup-wikipedia', async (_e, title, lang) => {
  title = lookupTerm(title)
  if (!title) return null
  lang = /^[a-z]{2,3}$/.test(lang) ? lang : 'en'
  return fetchJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`)
})

// ---------- book details search (Edit details → Find online) ----------
// Apple Books has large, clean covers; Open Library adds other editions and older books.
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
ipcMain.handle('search-book-info', async (_e, opts = {}) => {
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
})
// cover images for the results: only from the two services above
ipcMain.handle('fetch-cover-image', async (_e, url) => {
  const u = new URL(String(url))
  if (u.protocol !== 'https:' || !/^(is\d+-ssl\.mzstatic\.com|covers\.openlibrary\.org)$/.test(u.hostname))
    throw new Error('Image host not allowed')
  const res = await net.fetch(u.href, { headers: { 'User-Agent': LOOKUP_UA } })
  if (!res.ok) return null
  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) return null
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length < 200 || data.length > 20 * 1024 * 1024) return null // empty placeholders / oversized
  return { type, data }
})

// ---------- reading statistics ----------
// { days: { 'YYYY-MM-DD': { ms, pages } }, books: { [bookId]: ms } }
let stats = null
let statsLoad = null
const loadStats = () => (statsLoad ??= ready().then(() => readJSON(STATS_FILE, {})).then(s => {
  stats = { days: {}, books: {}, ...s }
  return stats
}))
ipcMain.handle('stats-get', () => loadStats())
ipcMain.handle('stats-add', async (_e, add) => {
  await loadStats()
  const day = String(add?.day ?? '')
  const ms = Math.max(0, Math.min(Number(add?.ms) || 0, 6 * 3600e3))
  const pages = Math.max(0, Math.min(Math.round(Number(add?.pages) || 0), 10000))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (!ms && !pages)) return stats
  const d = (stats.days[day] ??= { ms: 0, pages: 0 })
  d.ms += ms
  d.pages += pages
  if (typeof add.bookId === 'string' && /^[0-9a-f]{16}$/.test(add.bookId))
    stats.books[add.bookId] = (stats.books[add.bookId] ?? 0) + ms
  await saveJSON(STATS_FILE, stats)
  return stats
})

// ---------- backup & restore ----------
// A backup is one .zip: manifest.json, library.json, stats.json, settings.json (reading
// settings), prefs.json (view choices kept by the window), books/<file> and covers/<id>.jpg.
const { writeZip, openZip } = require('./zip')
const BACKUPS_DIR = path.join(DATA_DIR, 'backups') // copies saved automatically before a restore
const AUTO_EVERY = 7 * 24 * 3600e3
const AUTO_KEEP = 5
const AUTO_NAME = /^Simply Reader auto-backup \d{4}-\d{2}-\d{2}\.zip$/
let uiPrefs = null // the window's view preferences, included in backups
const pad2 = n => String(n).padStart(2, '0')
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const ymdhm = (d = new Date()) => `${ymd(d)} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`
const backupConfig = () => (settings.backup ??= {})

// one backup or restore at a time: the weekly timer, "Back up now" and "Restore" never read
// files that another job is writing or deleting (or write the same .part file)
let backupJob = Promise.resolve()
const exclusive = job => {
  const run = backupJob.then(job)
  backupJob = run.catch(() => {})
  return run
}

async function createBackup(dest) {
  await Promise.all([loadLibrary(), loadStats(), loadSettings()])
  const lib = JSON.parse(JSON.stringify(library)) // a snapshot: saves may continue meanwhile
  const manifest = { app: 'Simply Reader', format: 1, created: Date.now(), books: {} }
  const entries = []
  const used = new Set()
  for (const b of Object.values(lib.books ?? {})) {
    delete b.missing
    if (!b?.id || !b.path || !await exists(b.path)) continue // a missing file: keep the entry only
    const ext = path.extname(b.path), stem = path.basename(b.path, ext)
    let name = stem + ext
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`
    used.add(name.toLowerCase())
    manifest.books[b.id] = name
    entries.push({ name: 'books/' + name, file: b.path })
    const cover = path.join(COVERS_DIR, b.id + '.jpg')
    if (b.cover?.includes(COVERS_ROUTE) && await exists(cover)) entries.push({ name: `covers/${b.id}.jpg`, file: cover })
  }
  const json = o => Buffer.from(JSON.stringify(o))
  entries.unshift(
    { name: 'manifest.json', data: json(manifest) },
    { name: 'library.json', data: json(lib) },
    { name: 'stats.json', data: json(stats) },
    { name: 'settings.json', data: json({ reader: settings.reader ?? {}, goals: settings.goals ?? {} }) },
    ...(uiPrefs ? [{ name: 'prefs.json', data: json(uiPrefs) }] : []))
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const size = await writeZip(dest, entries)
  return { path: dest, size, books: Object.keys(lib.books ?? {}).length }
}

const backupFileOk = n => /^(manifest|library|stats|settings|prefs)\.json$/.test(n)
  || /^covers\/[0-9a-f]{16}\.jpg$/.test(n)
  || (/^books\/[^/\\:*?"<>|]+$/.test(n) && !n.includes('..') && isSupported(n))
async function openBackup(file) {
  if (typeof file !== 'string' || !/\.zip$/i.test(file)) throw new Error('Choose a .zip backup file')
  const zip = await openZip(file) // reads only the archive's index; books are extracted one by one
  // a damaged file throws; one that isn't valid JSON counts as missing
  const parse = async n => {
    if (!zip.has(n)) return null
    const text = (await zip.read(n)).toString('utf8')
    try { return JSON.parse(text) } catch { return null }
  }
  const [manifest, lib, statsData, settingsData, prefs] =
    await Promise.all(['manifest', 'library', 'stats', 'settings', 'prefs'].map(n => parse(n + '.json')))
  if (manifest?.app !== 'Simply Reader' || !lib?.books || typeof lib.books !== 'object')
    throw new Error('This file is not a Simply Reader backup')
  return { zip, manifest, lib, stats: statsData, settings: settingsData, prefs }
}

// A restore first unpacks the backup into STAGING_DIR, so a damaged backup or a full disk
// leaves the library as it was. Then the staged books and covers swap places with the
// library's (which move to REPLACED_DIR) and the JSON files are written. RESTORE_JOURNAL
// exists during the swap: if the app stops half-way, the next start completes it.
const STAGING_DIR = path.join(DATA_DIR, 'restore-staging')
const REPLACED_DIR = path.join(DATA_DIR, 'restore-replaced')
const RESTORE_JOURNAL = path.join(DATA_DIR, 'restore-journal.json')
const SWAPPED_DIRS = ['books', 'covers'] // BOOKS_DIR and COVERS_DIR
const STAGED_JSON = ['library.json', 'stats.json', 'settings.json']
const rmDir = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
const writeFileAtomic = async (file, text) => { await fs.writeFile(file + '.tmp', text); await files.rename(file + '.tmp', file) }
const unchanged = e => new Error(`${e.code === 'ENOSPC' ? 'There isn’t enough free disk space to restore this backup'
  : String(e.message).replace(/\.$/, '')}. Your library wasn’t changed.`, { cause: e })

// unpack a backup next to the library without touching it; returns what the library becomes
async function stageRestore(bk) {
  await Promise.all([rmDir(STAGING_DIR), rmDir(REPLACED_DIR)])
  const stagedBooks = path.join(STAGING_DIR, 'books'), stagedCovers = path.join(STAGING_DIR, 'covers')
  await fs.mkdir(stagedBooks, { recursive: true })
  await fs.mkdir(stagedCovers, { recursive: true })
  const books = {}, idMap = new Map(), staged = new Set(), keep = new Set()
  for (const [oldId, entry] of Object.entries(bk.lib.books)) {
    if (!entry || typeof entry !== 'object') continue
    const zipName = bk.manifest.books?.[oldId]
    let p = entry.path
    if (typeof zipName === 'string' && backupFileOk('books/' + zipName) && bk.zip.has('books/' + zipName)) {
      p = path.join(BOOKS_DIR, zipName) // books live in this computer's library folder
      await bk.zip.extract('books/' + zipName, path.join(stagedBooks, zipName))
      staged.add(zipName.toLowerCase())
    } else if (typeof p === 'string' && p && isStored(p)) keep.add(path.basename(p)) // not in the backup: keep this computer's copy, if any
    if (typeof p !== 'string' || !p) continue
    const id = bookId(p)
    const e = { ...entry, id, path: p }
    delete e.missing
    const cover = `covers/${oldId}.jpg`
    if (/^[0-9a-f]{16}$/.test(oldId) && bk.zip.has(cover)) {
      await bk.zip.extract(cover, path.join(stagedCovers, id + '.jpg'))
      e.cover = `app://reader${COVERS_ROUTE}${id}.jpg?v=${Date.now()}`
    } else if (typeof e.cover === 'string' && e.cover.includes(COVERS_ROUTE)) {
      delete e.cover; delete e.coverRes // made again from the book
    }
    books[id] = e
    idMap.set(oldId, id)
  }
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
  await fs.writeFile(path.join(STAGING_DIR, 'library.json'), JSON.stringify(next.library))
  await fs.writeFile(path.join(STAGING_DIR, 'stats.json'), JSON.stringify(next.stats))
  await fs.writeFile(path.join(STAGING_DIR, 'settings.json'), JSON.stringify({ ...settings, reader: next.reader, goals: next.goals }))
  return next
}

// Put the staged books and covers in place of the library's. Every step checks what's
// already done, so it can run again after an interruption.
async function swapInStaged(keep) {
  await fs.mkdir(REPLACED_DIR, { recursive: true })
  for (const dir of SWAPPED_DIRS) {
    const live = path.join(DATA_DIR, dir), staged = path.join(STAGING_DIR, dir), replaced = path.join(REPLACED_DIR, dir)
    if (!await exists(staged)) continue // already in place
    if (await exists(live)) {
      if (await exists(replaced)) throw new Error(`Unexpected folder: ${replaced}`)
      await files.rename(live, replaced)
    }
    await files.rename(staged, live)
  }
  // books missing from the backup that this computer still has (see stageRestore)
  for (const name of keep) {
    const from = path.join(REPLACED_DIR, 'books', name), to = path.join(BOOKS_DIR, name)
    if (await exists(from) && !await exists(to)) await files.rename(from, to)
  }
}
// undo a swapInStaged that failed half-way
async function swapBack(keep) {
  for (const name of keep) {
    const from = path.join(BOOKS_DIR, name), to = path.join(REPLACED_DIR, 'books', name)
    if (await exists(from) && !await exists(to)) await files.rename(from, to)
  }
  for (const dir of SWAPPED_DIRS) {
    const live = path.join(DATA_DIR, dir), staged = path.join(STAGING_DIR, dir), replaced = path.join(REPLACED_DIR, dir)
    if (await exists(replaced)) { // the library's folder was moved away
      if (await exists(live)) await files.rename(live, staged)
      await files.rename(replaced, live)
    } else if (!await exists(staged) && await exists(live)) await files.rename(live, staged) // there was none: take the staged one back out
  }
}

// Runs before anything reads the data folder: completes a restore that was interrupted
// while it replaced the library, and removes what's left of one that never got that far.
async function finishInterruptedRestore() {
  const job = await readJSON(RESTORE_JOURNAL, null)
  if (job) {
    const keep = (Array.isArray(job.keep) ? job.keep : []).filter(n => typeof n === 'string' && n && n === path.basename(n))
    await swapInStaged(keep)
    for (const name of STAGED_JSON) {
      const staged = path.join(STAGING_DIR, name)
      if (await exists(staged)) await files.rename(staged, path.join(DATA_DIR, name))
    }
    await fs.rm(RESTORE_JOURNAL, { force: true })
    console.log('completed an interrupted restore')
  }
  await Promise.all([rmDir(STAGING_DIR), rmDir(REPLACED_DIR)])
}

// replace the library with a backup; what was there is saved to BACKUPS_DIR first
async function restoreBackup(file) {
  const bk = await openBackup(file)
  await Promise.all([loadLibrary(), loadStats(), loadSettings()])
  let safety = null, next
  try {
    // keep what's being replaced (an empty library has nothing worth keeping)
    if (Object.keys(library.books ?? {}).length)
      safety = await createBackup(path.join(BACKUPS_DIR, `Before restore ${ymdhm()}.zip`))
    next = await stageRestore(bk)
  } catch (e) {
    await rmDir(STAGING_DIR).catch(() => {})
    throw unchanged(e)
  }
  // from here on, a restore that's interrupted is completed on the next start
  await writeFileAtomic(RESTORE_JOURNAL, JSON.stringify({ started: Date.now(), keep: next.keep }))
  try {
    await swapInStaged(next.keep)
  } catch (e) {
    console.error('restore: could not put the backup in place', e)
    try {
      await swapBack(next.keep)
      await fs.rm(RESTORE_JOURNAL, { force: true })
    } catch (e2) {
      console.error('restore: could not undo', e2)
      throw new Error(`The restore couldn’t finish (${e.message}). Restart Simply Reader to complete it.`, { cause: e })
    }
    await rmDir(STAGING_DIR).catch(() => {})
    throw unchanged(e)
  }
  library = next.library
  stats = next.stats
  settings.reader = next.reader
  settings.goals = next.goals
  try {
    await Promise.all([saveLibrary(), writeJSON(STATS_FILE, stats), writeJSON(SETTINGS_FILE, settings)])
  } catch (e) {
    throw new Error(`The restore couldn’t finish (${e.message}). Restart Simply Reader to complete it.`, { cause: e })
  }
  await fs.rm(RESTORE_JOURNAL, { force: true }).catch(e => console.error('restore: journal', e))
  // the replaced books and covers are in the safety copy
  await Promise.all([rmDir(STAGING_DIR), rmDir(REPLACED_DIR)]).catch(e => console.error('restore: cleanup', e))
  return { books: Object.keys(next.library.books).length, prefs: bk.prefs, safety: safety?.path ?? null }
}

function autoBackupIfDue(force) { return exclusive(() => autoBackup(force)) }
async function autoBackup(force) {
  await loadSettings()
  const cfg = backupConfig()
  if (!cfg.auto || !cfg.folder) return
  if (!force && Date.now() - (cfg.lastAutoAt ?? 0) < AUTO_EVERY) return
  if (!Object.keys((await loadLibrary()).books ?? {}).length) return
  try {
    const r = await createBackup(path.join(cfg.folder, `Simply Reader auto-backup ${ymd()}.zip`))
    Object.assign(cfg, { lastAutoAt: Date.now(), lastAt: Date.now(), lastPath: r.path })
    delete cfg.lastError
    // keep only the newest automatic backups in that folder (never touches other files)
    const old = (await fs.readdir(cfg.folder)).filter(n => AUTO_NAME.test(n)).sort().reverse().slice(AUTO_KEEP)
    for (const n of old) await fs.rm(path.join(cfg.folder, n), { force: true })
  } catch (e) {
    cfg.lastError = String(e?.message ?? e)
    console.error('automatic backup failed', e)
  }
  await saveJSON(SETTINGS_FILE, settings)
}

const backupInfo = async () => {
  await loadSettings()
  const c = backupConfig()
  return { lastAt: c.lastAt ?? null, lastPath: c.lastPath ?? null, auto: !!c.auto, folder: c.folder ?? null, lastAutoAt: c.lastAutoAt ?? null, error: c.lastError ?? null }
}
const setPrefs = p => { if (p && typeof p === 'object' && JSON.stringify(p).length < 10000) uiPrefs = p }

ipcMain.handle('backup-info', backupInfo)
ipcMain.handle('backup-create', async (_e, prefs) => {
  setPrefs(prefs)
  await loadSettings()
  const c = backupConfig()
  const r = await dialog.showSaveDialog(win, {
    title: 'Save a backup of your library',
    defaultPath: path.join(c.lastPath ? path.dirname(c.lastPath) : app.getPath('documents'), `Simply Reader backup ${ymd()}.zip`),
    filters: [{ name: 'Backup', extensions: ['zip'] }],
  })
  if (r.canceled || !r.filePath) return null
  const res = await exclusive(() => createBackup(r.filePath))
  Object.assign(c, { lastAt: Date.now(), lastPath: res.path })
  await saveJSON(SETTINGS_FILE, settings)
  return res
})
ipcMain.handle('backup-pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a backup to restore',
    defaultPath: (await backupInfo()).lastPath ?? app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'Backup', extensions: ['zip'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  const bk = await openBackup(r.filePaths[0])
  return { path: r.filePaths[0], created: bk.manifest.created ?? null, books: Object.keys(bk.lib.books).length }
})
ipcMain.handle('backup-restore', (_e, file) => exclusive(() => restoreBackup(file)))
ipcMain.handle('backup-auto', async (_e, opts = {}) => {
  await loadSettings()
  const c = backupConfig()
  if (opts.chooseFolder) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for automatic backups', properties: ['openDirectory', 'createDirectory'],
      defaultPath: c.folder ?? app.getPath('documents'),
    })
    if (r.canceled || !r.filePaths[0]) return backupInfo()
    c.folder = r.filePaths[0]
    if (opts.enable !== false) c.auto = true
  } else if (typeof opts.enable === 'boolean') c.auto = opts.enable
  await saveJSON(SETTINGS_FILE, settings)
  if (c.auto && c.folder) await autoBackupIfDue(!c.lastAutoAt || opts.chooseFolder) // first backup right away
  return backupInfo()
})
ipcMain.handle('backup-prefs', (_e, prefs) => { setPrefs(prefs) })
ipcMain.handle('backup-show', async (_e, which) => {
  const c = (await backupInfo())
  if (which === 'last' && c.lastPath && await exists(c.lastPath)) return shell.showItemInFolder(c.lastPath)
  if (which === 'folder' && c.folder) return shell.openPath(c.folder)
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  return shell.openPath(BACKUPS_DIR)
})

// copy books into the library folder; returns the stored paths (the original if copying fails)
ipcMain.handle('store-books', (_e, paths) => Promise.all((Array.isArray(paths) ? paths : []).map(async p => {
  const file = assertBookPath(p)
  try { return await storeBook(file) } catch (e) { console.error('could not store', file, e); return file }
})))

ipcMain.handle('book-id', (_e, p) => bookId(assertBookPath(p)))

ipcMain.handle('settings-get', async () => (await loadSettings()).reader ?? {})
ipcMain.handle('settings-set', async (_e, reader) => {
  await loadSettings()
  settings.reader = reader
  await saveJSON(SETTINGS_FILE, settings)
})

// reading goals: minutes a day and books a year (null = no goal)
const goalNum = (v, max) => Number.isInteger(v) && v >= 1 && v <= max ? v : null
const cleanGoals = g => ({ dailyMinutes: goalNum(g?.dailyMinutes, 1440), yearBooks: goalNum(g?.yearBooks, 1000) })
ipcMain.handle('goals-get', async () => cleanGoals((await loadSettings()).goals))
ipcMain.handle('goals-set', async (_e, goals) => {
  await loadSettings()
  settings.goals = cleanGoals(goals)
  await saveJSON(SETTINGS_FILE, settings)
  return settings.goals
})

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(assertBookPath(p)))
// export notes: the user picks where the text file goes
ipcMain.handle('save-text', async (_e, suggestedName, text) => {
  const safe = String(suggestedName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150)
  const r = await dialog.showSaveDialog(win, {
    title: 'Export notes',
    defaultPath: path.join(app.getPath('documents'), safe),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  })
  if (r.canceled || !r.filePath) return false
  await fs.writeFile(r.filePath, String(text), 'utf8')
  return true
})

// snapshot of part of the window, used for the page-turn animation
ipcMain.handle('capture', async (_e, rect) => {
  const r = {
    x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
  }
  const img = await win.webContents.capturePage(r)
  return img.toJPEG(88)
})

ipcMain.handle('set-fullscreen', (_e, on) => {
  const next = typeof on === 'boolean' ? on : !win.isFullScreen()
  win.setFullScreen(next)
  return next
})
