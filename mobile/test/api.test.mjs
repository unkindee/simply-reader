// Runs the Android window.api adapter (mobile/web/api.js) in Node against a fake native plugin
// that keeps its files in a temporary folder. ZIP files are written and read with the desktop
// app's own src/zip.js, so backups are checked against the desktop format.
// Run with: npm test (after npm ci; it builds www/ first).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as rules from '../../src/shared/rules.mjs'

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { writeZip, openZip } = require('../../src/zip.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-android-test-'))
const FILES = path.join(TMP, 'files'), CACHE = path.join(TMP, 'cache'), OUT = path.join(TMP, 'saved')
for (const d of [FILES, CACHE, OUT]) fs.mkdirSync(d, { recursive: true })
const sha16 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

// ---------------------------------------------------------------- the fake plugin
const fake = { picks: [], pickFile: null, failWrites: false, saved: [] }
const resolve = (root, rel) => {
  assert.ok(typeof rel === 'string' && rel && !rel.startsWith('/') && !rel.split('/').some(p => !p || p === '.' || p === '..'), `bad path ${rel}`)
  return path.join(root === 'cache' ? CACHE : FILES, rel)
}
const at = (o, key) => resolve(o[key + 'Root'] ?? o.root ?? 'files', o[key])
const SR = {
  info: async () => ({ filesDir: FILES.replaceAll('\\', '/'), cacheDir: CACHE.replaceAll('\\', '/'), sdk: 35 }),
  readText: async o => { const f = at(o, 'path'); return { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null } },
  writeText: async o => {
    if (fake.failWrites) throw new Error('disk full')
    const f = at(o, 'path'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', o.text); fs.renameSync(f + '.tmp', f)
  },
  writeBase64: async o => { const f = at(o, 'path'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(o.data, 'base64')) },
  stat: async o => { const f = at(o, 'path'); const s = fs.existsSync(f) && fs.statSync(f); return { exists: !!s, dir: !!s && s.isDirectory(), size: s && s.isFile() ? s.size : 0 } },
  list: async o => { const f = at(o, 'path'); const names = fs.existsSync(f) ? fs.readdirSync(f) : []; return { names, sizes: names.map(() => 0) } },
  mkdir: async o => { fs.mkdirSync(at(o, 'path'), { recursive: true }) },
  remove: async o => { fs.rmSync(at(o, 'path'), { recursive: true, force: true }) },
  rename: async o => {
    const from = at(o, 'from'), to = at(o, 'to')
    if (!fs.existsSync(from)) { if (o.ifExists) return; throw new Error('Not found') }
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to)
  },
  freeSpace: async () => ({ bytes: 1e12 }),
  pickBooks: async () => { const r = fake.picks; fake.picks = []; return { refs: r, errors: [] } },
  takeOpenedFiles: async () => ({ refs: [], errors: [] }),
  pickFile: async o => {
    if (!fake.pickFile) return { cancelled: true }
    const dest = at(o, 'dest'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(fake.pickFile, dest)
    return { cancelled: false, name: path.basename(fake.pickFile), size: fs.statSync(dest).size }
  },
  saveDocument: async o => {
    const dest = path.join(OUT, o.name)
    if (o.text != null) fs.writeFileSync(dest, o.text); else fs.copyFileSync(at(o, 'path'), dest)
    fake.saved.push(dest)
    return { saved: true, name: o.name }
  },
  zipCreate: async o => {
    const entries = o.entries.map(e => e.text != null ? { name: e.name, data: Buffer.from(e.text) } : { name: e.name, file: resolve(e.root ?? 'files', e.path) })
    const dest = at(o, 'dest'); fs.mkdirSync(path.dirname(dest), { recursive: true })
    return { size: await writeZip(dest, entries) }
  },
  zipList: async o => { const z = await openZip(at(o, 'path')); return { names: z.names, sizes: z.names.map(() => 0) } },
  zipReadText: async o => { const z = await openZip(at(o, 'path')); return { text: z.has(o.name) ? (await z.read(o.name)).toString('utf8') : null } },
  zipExtract: async o => {
    const z = await openZip(at(o, 'path'))
    for (const it of o.items) { const d = resolve(o.destRoot ?? 'files', it.dest); fs.mkdirSync(path.dirname(d), { recursive: true }); await z.extract(it.name, d) }
    return { bytes: 0 }
  },
  setChrome: async () => {}, setImmersive: async o => ({ on: o.on }), httpGet: async () => ({ status: 404 }),
  addListener: () => ({ remove() {} }),
}
const App = { addListener: () => ({ remove() {} }), exitApp: () => {} }

globalThis.window = globalThis
globalThis.document = { documentElement: { classList: { add() {} } } }
globalThis.Capacitor = {
  registerPlugin: name => name === 'App' ? App : SR,
  convertFileSrc: p => 'https://localhost/_capacitor_file_' + p,
}
// readBook fetches the converted URL: serve it from the temporary folder
globalThis.fetch = async url => {
  const p = decodeURIComponent(new URL(url).pathname.slice('/_capacitor_file_'.length).replace(/^\/([A-Za-z]:)/, '$1'))
  if (!fs.existsSync(p)) return { ok: false, status: 404 }
  const data = fs.readFileSync(p)
  return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) }
}

let generation = 0
const loadApi = async () => {
  delete globalThis.api
  await import(pathToFileURL(path.join(MOBILE, 'www/src/android/api.js')).href + `?gen=${++generation}`)
  return globalThis.api
}
const addBook = (name, text = 'book ' + name) => { fs.mkdirSync(path.join(FILES, 'books'), { recursive: true }); fs.writeFileSync(path.join(FILES, 'books', name), text) }
const readLib = () => JSON.parse(fs.readFileSync(path.join(FILES, 'library.json'), 'utf8'))
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64')

before(() => { execFileSync(process.execPath, [path.join(MOBILE, 'scripts/prepare-web.mjs')], { stdio: 'ignore' }) })
after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

// ---------------------------------------------------------------- shared rules
test('extname matches Node for odd names', () => {
  for (const n of ['a.epub', '.epub', '..epub', 'a.', '..', '.', 'x.tar.gz', 'Book (2).EPUB', '....'])
    assert.equal(rules.extname(n), path.posix.extname(n), n)
})
test('portableName makes names every system accepts', () => {
  assert.equal(rules.portableName('a:b?.epub'), 'a_b_.epub')
  assert.equal(rules.portableName('CON.epub'), '_CON.epub')
  assert.equal(rules.portableName('Plain name.epub'), 'Plain name.epub')
  assert.equal(rules.numbered('Book.epub', 2), 'Book (2).epub')
})
test('stats additions are clamped', () => {
  const st = { days: {}, books: {} }
  assert.equal(rules.applyStatsAdd(st, { day: 'bad', ms: 5 }), false)
  rules.applyStatsAdd(st, { day: '2026-01-02', ms: 1e12, pages: 1e9, bookId: '0123456789abcdef' })
  assert.deepEqual(st.days['2026-01-02'], { ms: 6 * 3600e3, pages: 10000 })
  assert.equal(st.books['0123456789abcdef'], 6 * 3600e3)
})

// ---------------------------------------------------------------- the adapter
test('book references are validated', async () => {
  const api = await loadApi()
  for (const bad of ['../x.epub', 'sr-book:a/b.epub', 'sr-book:..', 'sr-book:x.txt', 'C:\\books\\x.epub', 'sr-book:a\nb.epub'])
    await assert.rejects(api.bookId(bad), /Unsupported/, bad)
  assert.equal(await api.bookId('sr-book:A.epub'), sha16('sr-book:A.epub')) // the desktop formula, on the ref
})

test('import, upsert, covers and library.get', async () => {
  const api = await loadApi()
  addBook('Moby Dick.epub')
  fake.picks = ['sr-book:Moby Dick.epub']
  const refs = await api.chooseFiles()
  assert.deepEqual([...refs], ['sr-book:Moby Dick.epub'])
  assert.deepEqual(refs.rejected, [])
  assert.deepEqual(await api.storeBooks(refs), [...refs])
  const e = await api.library.upsert(refs[0], { title: 'Moby Dick', cover: JPEG, notAllowed: 1, annotations: [{ value: 'epubcfi(/6/2)', color: 'yellow' }] })
  const id = sha16('sr-book:Moby Dick.epub')
  assert.equal(e.id, id)
  assert.match(e.cover, /^https:\/\/localhost\/_capacitor_file_.*\/covers\/[0-9a-f]{16}\.jpg\?v=\d+$/)
  assert.equal(e.notAllowed, undefined)
  const disk = readLib().books[id]
  assert.match(disk.cover, /^app:\/\/reader\/__covers\/[0-9a-f]{16}\.jpg\?v=\d+$/) // desktop form on disk
  assert.ok(fs.existsSync(path.join(FILES, 'covers', id + '.jpg')))
  // sending the shown URL back keeps the stored form
  await api.library.upsert(refs[0], { cover: e.cover })
  assert.equal(readLib().books[id].cover, disk.cover)
  // the window's objects are copies
  e.annotations.push({ value: 'x' })
  assert.equal(readLib().books[id].annotations.length, 1)
  const lib = await api.library.get()
  assert.equal(lib.books[id].missing, false)
  const { data, name } = await api.readBook(refs[0])
  assert.equal(name, 'Moby Dick.epub')
  assert.equal(Buffer.from(data).toString(), 'book Moby Dick.epub')
  await assert.rejects(api.library.upsert('sr-book:Not there.epub', { title: 'x' }), /not found/i)
})

test('a failed write rejects (so the window keeps it pending) and the next save writes it', async () => {
  const api = await loadApi()
  const ref = 'sr-book:Moby Dick.epub', id = sha16(ref)
  fake.failWrites = true
  await assert.rejects(api.library.upsert(ref, { cfi: 'epubcfi(/6/4)', fraction: 0.5 }), /disk full/)
  fake.failWrites = false
  assert.notEqual(readLib().books[id].cfi, 'epubcfi(/6/4)')
  await api.library.upsert(ref, { cfi: 'epubcfi(/6/4)', fraction: 0.5 })
  assert.equal(readLib().books[id].cfi, 'epubcfi(/6/4)')
})

test('stats.get returns a copy', async () => {
  const api = await loadApi()
  const a = await api.stats.get()
  a.days['2000-01-01'] = { ms: 1, pages: 1 }
  await api.stats.add({ day: '2026-03-01', ms: 60000, pages: 2, bookId: sha16('sr-book:Moby Dick.epub') })
  const b = await api.stats.get()
  assert.equal(b.days['2000-01-01'], undefined)
  assert.deepEqual(b.days['2026-03-01'], { ms: 60000, pages: 2 })
})

test('a backup has the desktop layout', async () => {
  const api = await loadApi()
  await api.backup.setPrefs({ libMode: 'list' })
  const r = await api.backup.create({ libMode: 'list' })
  assert.equal(r.books, 1)
  const file = fake.saved.at(-1)
  const z = await openZip(file)
  const manifest = JSON.parse((await z.read('manifest.json')).toString())
  assert.equal(manifest.app, 'Simply Reader')
  const id = sha16('sr-book:Moby Dick.epub')
  assert.equal(manifest.books[id], 'Moby Dick.epub')
  assert.ok(z.has('books/Moby Dick.epub') && z.has(`covers/${id}.jpg`) && z.has('stats.json') && z.has('settings.json'))
  assert.deepEqual(JSON.parse((await z.read('prefs.json')).toString()), { libMode: 'list' })
  assert.ok(!fs.existsSync(path.join(CACHE, 'backup')), 'the temporary copy is removed')
})

// a backup as the Windows app writes it
async function desktopBackup(file, { damaged = false } = {}) {
  const winPath = 'C:\\Users\\someone\\AppData\\Roaming\\Simply Reader\\books\\Pride: and Prejudice.epub'
  const oldId = sha16(winPath.toLowerCase())
  const missingId = 'aaaaaaaaaaaaaaaa'
  const lib = { books: {
    [oldId]: { id: oldId, path: winPath, title: 'Pride and Prejudice', cfi: 'epubcfi(/6/8)', fraction: 0.3,
      cover: `app://reader/__covers/${oldId}.jpg?v=1`, pagination: { key: 'k', pages: [1, 2] }, missing: false },
    [missingId]: { id: missingId, path: 'C:\\elsewhere\\Gone.epub', title: 'Gone' },
  } }
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'Simply Reader', format: 1, created: 1700000000000, books: { [oldId]: 'Pride: and Prejudice.epub' } })) },
    { name: 'library.json', data: Buffer.from(JSON.stringify(lib)) },
    { name: 'stats.json', data: Buffer.from(JSON.stringify({ days: { '2026-01-01': { ms: 5, pages: 1 } }, books: { [oldId]: 1234, ffffffffffffffff: 9 } })) },
    { name: 'settings.json', data: Buffer.from(JSON.stringify({ reader: { theme: 'sepia', fontFamily: 'Georgia, serif' }, goals: { dailyMinutes: 30, yearBooks: 99999 } })) },
    { name: 'prefs.json', data: Buffer.from(JSON.stringify({ sort: 'title' })) },
    { name: 'books/Pride: and Prejudice.epub', data: Buffer.from('pride text') },
    { name: `covers/${oldId}.jpg`, data: Buffer.from('cover bytes') },
  ]
  await writeZip(file, entries)
  if (damaged) { // flip a byte of the stored book: its CRC no longer matches
    const buf = fs.readFileSync(file)
    const i = buf.indexOf(Buffer.from('pride text'))
    buf[i] ^= 0xff
    fs.writeFileSync(file, buf)
  }
  return { oldId }
}

test('a damaged backup leaves the library as it was', async () => {
  const api = await loadApi()
  const before = fs.readFileSync(path.join(FILES, 'library.json'), 'utf8')
  fake.pickFile = path.join(TMP, 'damaged.zip')
  await desktopBackup(fake.pickFile, { damaged: true })
  const pick = await api.backup.pick()
  assert.equal(pick.books, 2)
  await assert.rejects(api.backup.restore(pick.path), /wasn’t changed/)
  assert.equal(fs.readFileSync(path.join(FILES, 'library.json'), 'utf8'), before)
  assert.ok(fs.existsSync(path.join(FILES, 'books', 'Moby Dick.epub')))
  assert.ok(!fs.existsSync(path.join(FILES, 'restore-staging')))
})

test('restoring a desktop backup re-keys books, covers and stats', async () => {
  const api = await loadApi()
  fake.pickFile = path.join(TMP, 'desktop.zip')
  const { oldId } = await desktopBackup(fake.pickFile)
  const pick = await api.backup.pick()
  const r = await api.backup.restore(pick.path)
  assert.equal(r.books, 2)
  assert.deepEqual(r.prefs, { sort: 'title' })
  assert.match(r.safety, /^Before restore .*\.zip$/)
  assert.ok(fs.existsSync(path.join(FILES, 'backups', r.safety)), 'safety copy kept')
  const lib = readLib()
  const ref = 'sr-book:Pride_ and Prejudice.epub', id = sha16(ref)
  const e = lib.books[id]
  assert.ok(e, 'entry re-keyed by its new reference')
  assert.equal(e.path, ref)
  assert.equal(e.cfi, 'epubcfi(/6/8)')
  assert.equal(e.pagination, undefined, 'page counts are dropped')
  assert.equal(e.missing, undefined)
  assert.match(e.cover, new RegExp(`^app://reader/__covers/${id}\\.jpg\\?v=`))
  assert.equal(fs.readFileSync(path.join(FILES, 'covers', id + '.jpg'), 'utf8'), 'cover bytes')
  assert.equal(fs.readFileSync(path.join(FILES, 'books', 'Pride_ and Prejudice.epub'), 'utf8'), 'pride text')
  assert.ok(!fs.existsSync(path.join(FILES, 'books', 'Moby Dick.epub')), 'the replaced library is gone (it is in the safety copy)')
  assert.ok(lib.books.aaaaaaaaaaaaaaaa === undefined && Object.values(lib.books).some(b => b.title === 'Gone'), 'a book without its file keeps its entry')
  const st = JSON.parse(fs.readFileSync(path.join(FILES, 'stats.json'), 'utf8'))
  assert.deepEqual(st.books, { [id]: 1234 })
  assert.equal(st.books[oldId], undefined)
  const settings = JSON.parse(fs.readFileSync(path.join(FILES, 'settings.json'), 'utf8'))
  assert.equal(settings.reader.theme, 'sepia')
  assert.deepEqual(settings.goals, { dailyMinutes: 30, yearBooks: null })
  for (const left of ['restore-staging', 'restore-replaced', 'restore-journal.json']) assert.ok(!fs.existsSync(path.join(FILES, left)), left)
  // after the reload the window does, the restored library shows
  const api2 = await loadApi()
  const shown = await api2.library.get()
  assert.equal(shown.books[id].missing, false)
  assert.equal(Object.values(shown.books).find(b => b.title === 'Gone').missing, true)
})

test('an interrupted restore is completed on the next start', async () => {
  // as if the app stopped right after the journal was written
  const staging = path.join(FILES, 'restore-staging')
  fs.mkdirSync(path.join(staging, 'books'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'books', 'New.epub'), 'new')
  const ref = 'sr-book:New.epub', id = sha16(ref)
  fs.writeFileSync(path.join(staging, 'library.json'), JSON.stringify({ books: { [id]: { id, path: ref, title: 'New' } } }))
  fs.writeFileSync(path.join(staging, 'stats.json'), JSON.stringify({ days: {}, books: {} }))
  fs.writeFileSync(path.join(staging, 'settings.json'), JSON.stringify({ reader: { theme: 'light' } }))
  fs.writeFileSync(path.join(FILES, 'restore-journal.json'), JSON.stringify({ started: Date.now(), keep: [] }))
  const api = await loadApi()
  const lib = await api.library.get()
  assert.deepEqual(Object.keys(lib.books), [id])
  assert.equal(lib.books[id].missing, false)
  assert.equal((await api.settings.get()).theme, 'light')
  for (const left of ['restore-staging', 'restore-replaced', 'restore-journal.json']) assert.ok(!fs.existsSync(path.join(FILES, left)), left)
})

test('removing a book deletes its stored copy and cover', async () => {
  const api = await loadApi()
  const ref = 'sr-book:New.epub', id = sha16(ref)
  await api.library.upsert(ref, { cover: JPEG })
  await api.library.remove(id)
  assert.ok(!fs.existsSync(path.join(FILES, 'books', 'New.epub')))
  assert.ok(!fs.existsSync(path.join(FILES, 'covers', id + '.jpg')))
  assert.deepEqual(readLib().books, {})
})
