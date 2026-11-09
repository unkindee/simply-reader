# CLAUDE.md: how Simply Reader works

Notes for an AI (or a developer) working on this codebase. The user-facing feature list is in `README.md`; this file explains the inner workings, where things live, and the rules to follow when changing them.

## What it is

Simply Reader is a Windows desktop e-book reader built with **Electron 45**:

- No framework, no bundler and no build step for the app code. The renderer is a single ES-module script loaded directly by `index.html`.
- The book engine is **foliate-js**, vendored in `vendor/foliate-js` and imported straight from the renderer. It parses EPUB, MOBI/AZW3/KF8, FB2, CBZ and PDF (PDF through the pdf.js bundled in `vendor/foliate-js/vendor/pdfjs`).
- The app was renamed from *Inkleaf Reader*. Migration code for the old name exists on purpose; don't remove it.

## Commands

```
npm install
npm start        # electron .
npm run dist     # electron-builder --win nsis portable → dist/Simply Reader Setup 1.0.0.exe, dist/SimplyReader-Portable-1.0.0.exe
```

- `npm run dist` fails or hangs if Simply Reader (installed or portable) is running, because it locks files. Ask the user to close it first. If electron-builder is left hanging, kill its processes.
- There's no test suite or linter. Verify changes by driving the real app (see [Testing](#testing)).
- After a user-visible change the user expects `npm run dist` to be run, so both exes are up to date.

## Files

| Path | Role |
|---|---|
| `src/main.js` (~760 lines) | Main process: window, `app://` protocol, CSP, all disk I/O (library, settings, stats, covers, stored books), backup/restore, network look-ups, IPC handlers |
| `src/preload.js` | `contextBridge` exposing `window.api` (the only bridge between renderer and main) |
| `src/zip.js` | Dependency-free zip writer/reader used by backups (`writeZip(dest, entries)`, `readZip(file)` → `Map<name, Buffer>`; CRC-checked, UTF-8 names, stores already-compressed files and deflates the rest) |
| `src/renderer/index.html` | All markup: library, reader, popovers, `<dialog>`s, and the inline SVG icon sprite (`<symbol id="i-…">`) |
| `src/renderer/app.js` (~3,650 lines) | All renderer logic, split into commented sections (see below) |
| `src/renderer/styles.css` | All styles. Theme tokens are on `body[data-theme=…]`; newer features append their own block at the end |
| `src/renderer/fonts/` | Atkinson Hyperlegible (OFL) |
| `vendor/foliate-js/` | Third-party engine, with three small local patches (see [Vendor patches](#vendor-patches)) |
| `dist/` | Build output (exes, `win-unpacked/`) |

## Process model and security

- **Main** (`src/main.js`) does all file and network access.
- **Renderer** runs with `contextIsolation`, has no Node, and is served from the custom privileged scheme **`app://reader/…`**, which maps onto the project root (`APP_ROOT`). Paths that escape the root get 403. `app://reader/__covers/<16-hex id>.jpg` is served from `COVERS_DIR`.
- **CSP** is attached to every `.html` response. Only the app's own scripts may run (book content runs in same-origin iframes, so scripts inside books are blocked). `img/font/media/style` also allow `blob:` and `data:`. There is **no `connect-src` to the internet**: the renderer cannot reach the network.
- **All network calls go through IPC to main, and only to fixed hosts:**
  - Wiktionary and Wikipedia REST (`lookup-definition`, `lookup-wikipedia`).
  - Apple iTunes Search and Open Library (`search-book-info`).
  - Cover images only from `is\d+-ssl.mzstatic.com` and `covers.openlibrary.org` (`fetch-cover-image`).
  - All of them use the User-Agent `SimplyReader/1.0 (desktop e-book reader; Electron)`. Never put the user's email or other personal data in requests.
- **Path checks:** `assertBookPath()` guards every IPC that takes a book path: it rejects unsupported extensions and resolves the path.
- **Single instance:** a second launch sends `open-files` to the existing window. Files passed on the command line at start are read by the renderer through `get-pending-files`.

## IPC surface (`window.api`)

| API | Main handler | Notes |
|---|---|---|
| `chooseFiles`, `chooseFolder` | `choose-files`, `choose-folder` | The folder import walks subfolders |
| `readBook(path)` | `read-book` | Returns `{ name, data }`. The renderer wraps it in a `File` and calls foliate's `makeBook` |
| `storeBooks(paths)` | `store-books` | Copies each book into `books/` and returns the stored paths. A byte-identical existing copy is reused; a different file with the same name becomes `name (2).epub`. Copies go through a `.part` temp file and are queued per name |
| `bookId(path)` | `book-id` | See [Ids](#ids) |
| `library.get / upsert(path, data) / remove(id)` | `library-*` | `upsert` only copies **allowed fields** (list in main.js); a JPEG data-URL `cover` is written to `covers/<id>.jpg` and replaced by its `app://` URL. `remove` deletes the stored copy (only if it's inside `books/`) and the cover file |
| `settings.get / set` | `settings-*` | Reads and writes `settings.reader` (the renderer's default settings `G`) |
| `goals.get / set` | `goals-*` | `{ dailyMinutes, yearBooks }`, integers or null, sanitized by `cleanGoals` |
| `stats.get / add({ day, bookId, ms, pages })` | `stats-*` | `add` is clamped (≤ 6 h, ≤ 10,000 pages per call) |
| `backup.info / create(prefs) / pick / restore(file) / auto(opts) / setPrefs / show(which)` | `backup-*` | See [Backup and restore](#backup-and-restore) |
| `searchBookInfo`, `fetchCoverImage`, `chooseImage` | | Edit-details suggestions and custom covers (bytes come back to the renderer) |
| `lookupDefinition`, `lookupWikipedia` | | |
| `showInFolder`, `saveText`, `setFullscreen`, `capture(rect)` | | `capture` snapshots part of the window for the page-turn animation |
| `onOpenFiles(cb)`, `getPendingFiles`, `pathForFile(file)` | | Drag-and-drop uses `webUtils.getPathForFile` |

## Data on disk (`%APPDATA%\Simply Reader\` = `app.getPath('userData')`)

- **`library.json`**: `{ books: { [id]: entry } }`. Rewritten on every position save, so keep big data out of it (covers are files).
- **`settings.json`**: `{ reader: G, goals, backup: { auto, folder, lastAt, lastPath, lastAutoAt, lastError }, windowBounds, windowMaximized }`.
- **`stats.json`**: `{ days: { 'YYYY-MM-DD': { ms, pages } }, books: { [id]: ms } }`.
- **`books/`**: stored copies. **`covers/<id>.jpg`**: covers, up to 800 px wide. **`backups/`**: automatic "Before restore …zip" safety copies.
- **Renderer `localStorage`** (per-machine view choices, also carried in backups as `prefs.json`): `libMode` (`covers|shelf|list`), `libFilter` (`all|reading|unread|finished|c:<collection>`), `sort`, `readingSpeed` (`{ size, ms }`). **`sessionStorage.restored`** holds the toast text shown after a restore reloads the window.

### Library entry fields

Every key the renderer may write must be in main's `allowed` list in `library-upsert`, or it is silently dropped.

| Field | Meaning |
|---|---|
| `id`, `path`, `added` | Set by main. `path` is the stored copy in `books/` |
| `originalPath` | Where the user's file was |
| `title`, `author`, `format`, `length` | From the book. `length` = the sum of section sizes in foliate "size units", used for time estimates and shelf thickness |
| `custom: { title, author }`, `customCover` | The user's edits; they win over file metadata on reopen |
| `cover`, `coverRes`, `spineColor` | Cover URL, its resolution (old low-res covers are upgraded by `upgradeCovers`), and the shelf spine colour |
| `cfi`, `fraction`, `chapter`, `lastOpened`, `finishedAt` | Reading position and state. "Finished" = `fraction ≥ 0.995` (`FINISHED`) |
| `annotations: [{ value: cfi, color, note, created, … }]`, `bookmarks: [{ cfi, label, created }]` | |
| `collections: string[]` | |
| `pagination: { key, pages: number[] }` | Cached page counts per section for one layout key |
| `prefs` | The book's own reading settings (only `BOOK_KEYS` that differ from the defaults) |
| `info` | Cached Book-info details: `{ v: INFO_V, description, publisher, published, language, subjects, series, isbn, sections, fixedPages, words }`. Bump `INFO_V` in app.js to force recomputation |
| `missing` | Recomputed by main on every `library.get` (true when the file is gone). It can end up in library.json but is never trusted from there, and backups strip it |

### Ids

`bookId = sha1(path.resolve(p).toLowerCase()).slice(0, 16)`, which means **ids are derived from the stored path**. Anything that changes a book's path (legacy migration, restore) must re-key the entry, its `covers/<id>.jpg` and `stats.books[id]`. See `relocateLegacyPaths`, `migrateToStoredBooks` and `restoreBackup`.

### Loading the library in main

`loadLibrary()` = `readJSON` → `relocateLegacyPaths` (Inkleaf paths) → `migrateToStoredBooks` (entries from before books were copied in). It is memoized; IPC handlers await the same promise.

## Renderer (`src/renderer/app.js`)

### Helpers at the top

- `$`, `$$` (querySelectorAll as an array).
- `el(tag, props, ...children)`: `class`, `text`, `on*` listeners, other attributes; `null` children are skipped. Don't pass `false`: it would render as text.
- `icon(id)`, `plural(n, word)`, `debounce(fn, ms)` (with `.cancel()`), `perFrame(fn)`, `wait(ms)`, `toast(msg, type, ms)`.

### Sections, in file order

Search for the `// -----` headers:

- **settings** (`DEFAULTS`, themes, `bookCSS`, per-book layering)
- **library**: renderLibrary, Continue reading, cards; **list view** and its multi-select; **bookshelf** (spines, generated textures); **book info**; **edit details** and online suggestions; **filters and collections**; **reading statistics**; **reading goals**; **backup & restore**
- **reader**: openBook/closeBook; position persistence; relocation; **page numbers**; **image viewer**; per-section document hooks; progress footer; **page turn animation**; immersive mode; TOC; bookmarks; highlights and the selection pop-up; drawing highlights; note editor; search; panels and popovers; toolbar (including the library theme picker); pop-up placement; **footnote pop-ups**; **look-up**; **reading speed and time left**; **go to page**; keyboard; open/drop; **boot**

### Key globals

| Global | Meaning |
|---|---|
| `libCache` | `{ [id]: entry }` from `library.get()` |
| `current` | The open book `{ path, id, file, title, author, format, length }` or null |
| `view` | The `<foliate-view>` element, or null |
| `S`, `G`, `bookPrefs` | Effective, default and per-book settings (see below) |
| `statsCache` | Local copy of `stats.json`, updated immediately as you read |
| `goals` | `{ dailyMinutes, yearBooks }` |
| `pager` / `pagerCache` | Page-count state |
| `annotations`, `bookmarks` | The open book's working copies |
| `libMode`, `libFilter` | Library view state |

### Settings layering (per-book settings)

- `G` holds the defaults (persisted via `settings.set`). `bookPrefs` holds the open book's overrides (persisted as `entry.prefs`). The effective settings are `S = { ...G, ...bookPrefs }`, rebuilt by `mergeSettings()`.
- `BOOK_KEYS` lists the per-book keys: font, size, spacing, margins, width, flow, columns, justify, hyphenate, override, pdfZoom, pdfDark. Theme, pageTurn, pageNumbers and footerAuto are always global.
- **Always change settings through `setSetting(k, v)`** (or `assignSetting` + `applySettings`/`applySettingsPerFrame` for sliders). Never write `S[k]` directly. With a book open, a `BOOK_KEYS` change goes to `bookPrefs` (and is removed if it equals the default); otherwise it goes to `G`.
- Saving is debounced. `closeBook()` and backup creation call `flushBookPrefs()`.
- **Adding a new setting:** add it to `DEFAULTS`, decide whether it belongs in `BOOK_KEYS`, wire the UI in `initSettingsUI`/`syncSettingsUI`, and apply it in `applySettings`/`bookCSS`.
- Every element with `data-theme-btn` (the reader settings and the library theme picker) is wired and highlighted automatically.

### Opening a book (`openBook(path)`)

1. `closeBook()` (flushes position, reading time and per-book settings).
2. `api.bookId` and `loadFile`, in parallel. `loadFile` = `readBook` → `makeBook(File)` → `fixBookLanguage`.
3. Upsert metadata, cover fields and `lastOpened`.
4. Set `current`, load annotations and bookmarks, `bookPrefs = pickBookPrefs(entry.prefs)`, `mergeSettings()`.
5. Create the `<foliate-view>`, call `view.open(book)`, attach listeners (`relocate`, `load` → `onDocLoad`, annotation events, `link`), render TOC, bookmarks and highlights.
6. `applySettings()`, `showView('reader')`, then `view.init({ lastLocation: entry.cfi })`.

Each section of a reflowable book is its own same-origin iframe document. `onDocLoad` attaches keyboard, wheel, click (page-turn zones, immersive toggle), selection and image-zoom handlers to each one. Fixed-layout books (PDF, CBZ, pre-paginated EPUB) use `attachFxlLayer` and our own highlight layer instead.

### Page numbers

- `runPagination()` lays the whole book out off-screen in a hidden `foliate-paginator`, using a separate `makeBook` instance and the same `configureRenderer` and styles. It counts pages per section with `sectionPages()`, which ignores a trailing blank column.
- The result is cached per `layoutKey()` (stage size and every text setting) in `entry.pagination`.
- Page numbers are only shown in paginated flow for reflowable books. PDFs use the section index.
- Two-page spreads: the left page is the lower number.

### Page-turn animation

The current view is captured through `api.capture(rect)`, overlaid as an image, the book moves underneath (`navigateAndSettle`), and the overlay animates away (flip or slide). Pagination waits while `pageAnim` or `pageCapturing` is set.

### Reading time, speed and goals

- A 10 s ticker calls `addReading(READ_TICK)` while a book is open, the window is visible, the reader view is shown, and there was input in the last 5 min (`IDLE_LIMIT`).
- Pages are counted from page-number differences on forward turns.
- `flushReading()` sends accumulated time to `stats.add` every minute, on hide and on close.
- The reading speed (`readingSpeed` in localStorage) is learned from page turns in size units per minute and drives "time left".
- Goals: `goalStatus(which)` is the single source for ring maths. It's used by `renderGoals()` (stats dialog) and `renderGoalStrip()` (library row beside `#continue`). `checkDailyGoal()` shows a toast once a day; `markGoalIfMet()` suppresses it if the goal was already met.

### Book info

`openBookInfo(b)` renders immediately from `entry.info` if `info.v === INFO_V`. Otherwise it reads the file (or uses `view.book` if that book is open), runs `readBookDetails()` (metadata plus a word count over each section's `createDocument()`), saves `info` with `library.upsert`, and re-renders. Pages come from (in order) fixed pages, the cached pagination sum for the current layout, or words ÷ 275.

### Image viewer

`hookBookImages(doc)` (reflowable books only) intercepts clicks on `img`, an SVG `image`, or inline `svg` that is at least 64 px and not inside a link. It calls `preventDefault()` so `handleDocClick` doesn't turn the page. The viewer is `<dialog id="img-viewer">`; zoom and pan are done by sizing the `<img>` and translating it (state in `iv`). Inline SVGs are serialized to a blob URL, which is revoked on close.

### Dialogs and popovers

- Modal features use `<dialog>` + `showModal()`: stats, backup, edit details, book info, picture viewer. Each dialog's `keydown` **stops propagation** so the global `handleKey` (on `document`) doesn't turn pages underneath.
- Lightweight popovers (`.popover`, `hidden` attribute) are closed by `hidePopovers()` and the global `pointerdown` handler. Register new ones in both places, and in `anyOverlayOpen()` if they should block page-turn clicks.
- foliate-view gets `position:absolute; inset:0` globally. The footnote pop-up overrides this for its embedded view.

## Backup and restore (`src/main.js`)

- **Zip layout:** `manifest.json` (`{ app: 'Simply Reader', format: 1, created, books: { [id]: zipFileName } }`), `library.json`, `stats.json`, `settings.json` (`{ reader, goals }`), `prefs.json` (renderer localStorage view prefs), `books/<file>`, `covers/<id>.jpg`.
- **`createBackup(dest)`** snapshots the library. Books whose file is missing keep their entry without a file.
- **`restoreBackup(file)`:**
  1. Validates the zip (only whitelisted names; `backupFileOk`).
  2. Saves a safety backup to `backups/Before restore <date time>.zip`, but only if the current library has books. With an empty library the renderer also skips the confirmation. The header backup button is always visible and the empty-library screen has a "Restore a backup" button, so a fresh install can restore.
  3. Writes the books into `books/` and re-keys every entry by its new path, along with its cover and per-book stats.
  4. Deletes stored books and covers that belonged only to the replaced library.
  5. Replaces `library`, `stats`, `settings.reader` and `settings.goals`.
  6. The renderer then restores `prefs.json` into localStorage and calls `location.reload()`.
- **Automatic backup:** `autoBackupIfDue()` runs 60 s after start and every 6 h, at most weekly, into `settings.backup.folder`. It keeps the 5 newest files named `Simply Reader auto-backup YYYY-MM-DD.zip` and never touches other files.
- **When you add persistent data**, make sure it travels: library entry fields do automatically. A new `settings.json` key must be added to `createBackup` and `restoreBackup`. New files need zip entries.

## Vendor patches

Keep these when updating foliate-js. Each is marked `(Simply Reader patch)` where it has a comment.

1. `paginator.js` `setStylesImportant`: return early if the element is gone (a document torn down mid-render).
2. `pdf.js` `createDocument` per page: a plain-text document from `getTextContent()`, so in-book search, word counts and language detection work for PDFs.
3. `pdf.js` `renderPage` cover render: scale to about 800 px wide (capped at 4×) for sharp library covers.

## Testing

Never test against the user's real library (`%APPDATA%\Simply Reader`) unless they ask. Use a sandbox:

- `SIMPLY_READER_APPDATA=<dir>` (dev builds only, ignored when packaged) makes `appData` = `<dir>` and `userData` = `<dir>\Simply Reader`. `SIMPLY_READER_USER_DATA` sets only `userData`.
- `SIMPLY_READER_TEST_SCRIPT=<file.js>` (dev only) `require`s a module `async (win, app) => { … }` after the window loads, then quits the app when it resolves. Inside it:
  - Drive the UI with `win.webContents.executeJavaScript('(async () => { … })()')`.
  - Send real input with `win.webContents.sendInputEvent(...)`.
  - Take screenshots with `win.webContents.capturePage()`.
  - Replace native dialogs by assigning `dialog.showSaveDialog` / `dialog.showOpenDialog`.
  - Print lines with a prefix and grep for them.
- Example (Git Bash): `SIMPLY_READER_APPDATA="$SB" SIMPLY_READER_TEST_SCRIPT="$SB/test.js" timeout 120 npx electron . 2>&1 | grep '^TEST'`.
- You can also run `npx electron . --remote-debugging-port=9339` and drive the page over CDP.
- Module-scope `let`/`const` in app.js aren't on `window`. Reach state through the DOM, `window.api`, or the files on disk.
- Always look at screenshots after UI changes (light and dark themes, narrow widths).

## Conventions

- Plain modern JS (ES2023+, optional chaining, `Object.groupBy`, etc.); Chromium-only CSS is fine (`:has()`, `color-mix()`).
- Comments explain *why*, briefly. UI text is short, sentence case, and uses typographic quotes (“ ” ’) and ellipses (…).
- Styles use theme tokens (`--bg --surface --surface-2 --line --text --muted --accent --accent-text --shadow`). Never hard-code theme colours, except deliberately theme-independent surfaces such as the picture viewer's backdrop.
- Icons are `<symbol>`s in `index.html`, used as `<svg class="ic"><use href="#i-name"/></svg>` or `icon('i-name')`.
- Don't add npm dependencies to the app; small utilities (like the zip code) are written in-house.
- Keep the renderer offline. Anything that needs the network goes through a narrowly scoped IPC handler in main with a fixed host list.
- Library writes go through `api.library.upsert(path, partial)`, keyed by **path**, not id. Update `libCache[id]` too if the UI needs it before the next `refreshLibrary()`.
