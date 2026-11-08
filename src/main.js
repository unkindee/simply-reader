'use strict'
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const SUPPORTED = ['.epub', '.mobi', '.azw3', '.azw', '.kf8', '.prc', '.fb2', '.fbz', '.cbz', '.pdf']
const APP_ROOT = path.join(__dirname, '..')
if (!app.isPackaged && process.env.INKLEAF_USER_DATA) app.setPath('userData', process.env.INKLEAF_USER_DATA)
const DATA_DIR = app.getPath('userData')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

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
const writeQueue = new Map()
const writeJSON = (file, data) => {
  // serialize writes per file; write to temp then rename so a crash never corrupts data
  const prev = writeQueue.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(data, null, 1))
    await fs.rename(tmp, file)
  }).catch(e => console.error('write failed', file, e))
  writeQueue.set(file, next)
  return next
}

let library = null // { books: { [id]: entry } }
const loadLibrary = async () => (library ??= await readJSON(LIBRARY_FILE, { books: {} }))
const saveLibrary = () => writeJSON(LIBRARY_FILE, library)
const bookId = p => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16)

// ---------- window ----------
let win = null
let pendingOpen = [] // files passed on the command line before the window is ready

const filesFromArgv = argv => argv.slice(1)
  .filter(a => !a.startsWith('-') && SUPPORTED.includes(path.extname(a).toLowerCase()))
  .map(a => path.resolve(a))

const createWindow = async () => {
  const settings = await readJSON(SETTINGS_FILE, {})
  const bounds = settings.windowBounds ?? { width: 1200, height: 850 }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#1d1d21',
    title: 'Inkleaf Reader',
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
    const s = await readJSON(SETTINGS_FILE, {})
    s.windowMaximized = maximized
    if (bounds) s.windowBounds = bounds
    await writeJSON(SETTINGS_FILE, s)
  }
  win.on('close', saveBounds)

  // never navigate the app window away; open web links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault()
      if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    }
  })
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged)
      win.webContents.toggleDevTools()
  })

  win.loadURL('app://reader/src/renderer/index.html')

  // development-only: run an external test driver script (never active in packaged builds)
  if (!app.isPackaged && process.env.INKLEAF_TEST_SCRIPT) {
    win.webContents.on('console-message', e => console.log(`[renderer:${e.level}] ${e.message}`))
    win.webContents.once('did-finish-load', () => {
      require(process.env.INKLEAF_TEST_SCRIPT)(win, app).catch(e => console.error(e)).finally(() => app.quit())
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
      const filePath = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)))
      if (!filePath.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 })
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
    await loadLibrary()
    await createWindow()
  })

  app.on('window-all-closed', () => app.quit())
}

// ---------- IPC ----------
const assertBookPath = p => {
  if (typeof p !== 'string' || !SUPPORTED.includes(path.extname(p).toLowerCase()))
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
      else if (SUPPORTED.includes(path.extname(ent.name).toLowerCase())) found.push(full)
    }
  }
  await walk(r.filePaths[0], 0)
  return found
})

ipcMain.handle('read-book', async (_e, p) => {
  const file = assertBookPath(p)
  const data = await fs.readFile(file)
  return { name: path.basename(file), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
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
  const prev = library.books[id] ?? { id, path: file, added: Date.now(), annotations: [], bookmarks: [] }
  const allowed = ['title', 'author', 'cover', 'cfi', 'fraction', 'lastOpened', 'annotations', 'bookmarks', 'chapter', 'format', 'length', 'spineColor', 'pagination']
  for (const k of allowed) if (k in data) prev[k] = data[k]
  prev.path = file
  library.books[id] = prev
  await saveLibrary()
  return prev
})

ipcMain.handle('library-remove', async (_e, id) => {
  await loadLibrary()
  delete library.books[id]
  await saveLibrary()
})

ipcMain.handle('book-id', (_e, p) => bookId(assertBookPath(p)))

ipcMain.handle('settings-get', async () => {
  const s = await readJSON(SETTINGS_FILE, {})
  return s.reader ?? {}
})
ipcMain.handle('settings-set', async (_e, reader) => {
  const s = await readJSON(SETTINGS_FILE, {})
  s.reader = reader
  await writeJSON(SETTINGS_FILE, s)
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
