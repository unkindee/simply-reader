'use strict'
// Minimal .zip writer and reader for library backups (no dependencies).
// Files that are already compressed (books, images) are stored as they are; JSON and other
// text is deflated. Files are streamed in and out, so a backup never has to fit in memory,
// and archives past 4 GB or 65,535 files get ZIP64 records.
const fs = require('node:fs/promises')
const { createReadStream, createWriteStream } = require('node:fs')
const { Readable, Transform, Writable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const zlib = require('node:zlib')
const { promisify } = require('node:util')
const { rename } = require('./files')

const deflateRaw = promisify(zlib.deflateRaw)
const inflateRaw = promisify(zlib.inflateRaw)

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
// crc32(data, crcSoFar): continues a checksum over several chunks
const crc32 = zlib.crc32 ?? ((buf, prev = 0) => {
  let c = prev ^ -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
})

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50
const ZIP64_END = 0x06064b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_EXTRA = 0x0001
const UTF8 = 0x0800, ENCRYPTED = 0x0001
const MAX16 = 0xFFFF, MAX32 = 0xFFFFFFFF
// a deflated file's final size is only known at the end; this close to 4 GB, plan for ZIP64
const DEFLATE_ZIP64_AT = 0xFF000000
const READ_LIMIT = 512 * 1024 * 1024 // read() is for the JSON files; books are extracted to disk
const CHUNK = 1024 * 1024
const ALREADY_COMPRESSED = /\.(epub|zip|cbz|fbz|jpe?g|png|webp|gif|avif|mobi|azw3?|kf8|prc|pdf)$/i
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff
const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
const damaged = name => new Error(`The backup file is damaged${name ? ` (${name})` : ''}`)

async function readAt(fh, length, position, name) {
  const buf = Buffer.alloc(length)
  for (let done = 0; done < length;) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done)
    if (!bytesRead) throw damaged(name)
    done += bytesRead
  }
  return buf
}
async function writeAt(fh, buf, position) {
  for (let done = 0; done < buf.length;) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, position + done)
    done += bytesWritten
  }
}
// counts the bytes passing through and keeps a running CRC of them
const checker = limit => {
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.crc = crc32(chunk, t.crc)
      t.bytes += chunk.length
      cb(t.bytes > limit ? new Error('too much data') : null, chunk)
    },
  })
  t.crc = 0
  t.bytes = 0
  return t
}

// Local header. With ZIP64 both sizes live in an extra field, so the header is the same
// length before the data is written (sizes and CRC unknown) and after (when it's patched).
function localHeader(r) {
  const extra = Buffer.alloc(r.zip64 ? 20 : 0)
  if (r.zip64) {
    extra.writeUInt16LE(ZIP64_EXTRA, 0); extra.writeUInt16LE(16, 2)
    extra.writeBigUInt64LE(BigInt(r.size), 4); extra.writeBigUInt64LE(BigInt(r.csize), 12)
  }
  const h = Buffer.alloc(30)
  h.writeUInt32LE(LOCAL, 0); h.writeUInt16LE(r.zip64 ? 45 : 20, 4); h.writeUInt16LE(UTF8, 6); h.writeUInt16LE(r.method, 8)
  h.writeUInt16LE(r.time, 10); h.writeUInt16LE(r.date, 12); h.writeUInt32LE(r.crc, 14)
  h.writeUInt32LE(r.zip64 ? MAX32 : r.csize, 18); h.writeUInt32LE(r.zip64 ? MAX32 : r.size, 22)
  h.writeUInt16LE(r.name.length, 26); h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, r.name, extra])
}
// Central directory record: values that don't fit in 32 bits go into a ZIP64 extra field
// (in the order size, compressed size, offset) and the field itself says 0xFFFFFFFF.
function centralHeader(r) {
  const bigSize = r.zip64 || r.size >= MAX32, bigCsize = r.zip64 || r.csize >= MAX32, bigOffset = r.offset >= MAX32
  const values = [bigSize && r.size, bigCsize && r.csize, bigOffset && r.offset].filter(v => v !== false)
  const extra = Buffer.alloc(values.length ? 4 + 8 * values.length : 0)
  if (values.length) {
    extra.writeUInt16LE(ZIP64_EXTRA, 0); extra.writeUInt16LE(8 * values.length, 2)
    values.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i))
  }
  const version = values.length ? 45 : 20
  const h = Buffer.alloc(46)
  h.writeUInt32LE(CENTRAL, 0); h.writeUInt16LE(version, 4); h.writeUInt16LE(version, 6); h.writeUInt16LE(UTF8, 8)
  h.writeUInt16LE(r.method, 10); h.writeUInt16LE(r.time, 12); h.writeUInt16LE(r.date, 14)
  h.writeUInt32LE(r.crc, 16); h.writeUInt32LE(bigCsize ? MAX32 : r.csize, 20); h.writeUInt32LE(bigSize ? MAX32 : r.size, 24)
  h.writeUInt16LE(r.name.length, 28); h.writeUInt16LE(extra.length, 30)
  h.writeUInt32LE(bigOffset ? MAX32 : r.offset, 42)
  return Buffer.concat([h, r.name, extra])
}

// entries: [{ name, data: Buffer } | { name, file: path }]; written to `dest` via a temp file.
// Returns the archive's size.
async function writeZip(dest, entries) {
  const tmp = dest + '.part'
  const fh = await fs.open(tmp, 'w')
  const now = new Date(), time = dosTime(now), date = dosDate(now)
  const central = []
  let pos = 0
  const put = async buf => { await writeAt(fh, buf, pos); pos += buf.length }
  try {
    for (const e of entries) {
      const r = { name: Buffer.from(e.name, 'utf8'), time, date, offset: pos, method: 0, crc: 0, size: 0, csize: 0, zip64: false }
      if (e.data) {
        let body = e.data
        if (!ALREADY_COMPRESSED.test(e.name) && e.data.length > 64) {
          const z = await deflateRaw(e.data, { level: 6 })
          if (z.length < e.data.length) { body = z; r.method = 8 }
        }
        Object.assign(r, { crc: crc32(e.data) >>> 0, size: e.data.length, csize: body.length })
        r.zip64 = r.size >= MAX32 || r.csize >= MAX32
        await put(localHeader(r))
        await put(body)
      } else {
        // streamed from disk, so a book of any size never has to fit in memory
        const { size } = await fs.stat(e.file)
        r.method = ALREADY_COMPRESSED.test(e.name) ? 0 : 8
        r.size = size
        r.zip64 = size >= (r.method === 8 ? DEFLATE_ZIP64_AT : MAX32)
        await put(localHeader(r)) // CRC and compressed size are filled in once the data is written
        const dataAt = pos
        const check = checker(size)
        const out = new Writable({ write(chunk, _enc, cb) { put(chunk).then(() => cb(), cb) } })
        await pipeline(createReadStream(e.file, { highWaterMark: CHUNK }), check,
          ...(r.method === 8 ? [zlib.createDeflateRaw({ level: 6 })] : []), out)
        if (check.bytes !== size) throw new Error(`${e.name} changed while it was being backed up`)
        r.crc = check.crc >>> 0
        r.csize = pos - dataAt
        if (r.csize >= MAX32 && !r.zip64) throw new Error(`${e.name} is too large to back up`)
        await writeAt(fh, localHeader(r), r.offset)
      }
      central.push(r)
    }
    const cdAt = pos
    for (const r of central) await put(centralHeader(r))
    const cdSize = pos - cdAt
    if (central.length >= MAX16 || cdAt >= MAX32 || cdSize >= MAX32) {
      const recAt = pos
      const rec = Buffer.alloc(56)
      rec.writeUInt32LE(ZIP64_END, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14)
      rec.writeBigUInt64LE(BigInt(central.length), 24); rec.writeBigUInt64LE(BigInt(central.length), 32)
      rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdAt), 48)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(ZIP64_LOCATOR, 0); loc.writeBigUInt64LE(BigInt(recAt), 8); loc.writeUInt32LE(1, 16)
      await put(rec)
      await put(loc)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END, 0)
    end.writeUInt16LE(Math.min(central.length, MAX16), 8); end.writeUInt16LE(Math.min(central.length, MAX16), 10)
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12); end.writeUInt32LE(Math.min(cdAt, MAX32), 16)
    await put(end)
    await fh.close()
  } catch (e) {
    await fh.close().catch(() => {})
    await fs.rm(tmp, { force: true })
    throw e
  }
  await rename(tmp, dest)
  return pos
}

// Opens an archive by reading only its central directory. Returns
// { names, has(name), read(name) → Buffer, extract(name, destFile) }; read and extract check
// every file's size and checksum, and extract streams to disk.
async function openZip(file) {
  const entries = new Map() // name -> { method, crc, csize, size, at }
  let size
  const fh = await fs.open(file, 'r')
  try {
    size = (await fh.stat()).size
    if (size < 22) throw new Error('This file is not a zip archive')
    const tailAt = Math.max(0, size - 22 - MAX16)
    const tail = await readAt(fh, size - tailAt, tailAt)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === END) { eocd = i; break }
    if (eocd < 0) throw new Error('This file is not a zip archive')
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdAt = tail.readUInt32LE(eocd + 16)
    const locAt = tailAt + eocd - 20
    const loc = locAt >= 0 ? await readAt(fh, 20, locAt) : null
    if (loc?.readUInt32LE(0) === ZIP64_LOCATOR) {
      const recAt = Number(loc.readBigUInt64LE(8))
      if (recAt + 56 > size) throw damaged()
      const rec = await readAt(fh, 56, recAt)
      if (rec.readUInt32LE(0) !== ZIP64_END) throw damaged()
      count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdAt = Number(rec.readBigUInt64LE(48))
    } else if (count === MAX16 || cdSize === MAX32 || cdAt === MAX32) throw damaged()
    if (cdAt + cdSize > size) throw damaged()
    const cd = await readAt(fh, cdSize, cdAt)
    for (let n = 0, p = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw damaged()
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16)
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), at = cd.readUInt32LE(p + 42)
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32)
      const next = p + 46 + nlen + xlen + clen
      if (next > cd.length) throw damaged()
      const name = cd.toString(flags & UTF8 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen)
      for (let x = p + 46 + nlen, xEnd = x + xlen; x + 4 <= xEnd;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2)
        if (x + 4 + len > xEnd) throw damaged(name)
        if (id === ZIP64_EXTRA) {
          let q = x + 4
          const big = () => {
            if (q + 8 > x + 4 + len) throw damaged(name)
            const v = Number(cd.readBigUInt64LE(q)); q += 8; return v
          }
          if (usize === MAX32) usize = big()
          if (csize === MAX32) csize = big()
          if (at === MAX32) at = big()
        }
        x += 4 + len
      }
      p = next
      if (name.endsWith('/')) continue
      if (flags & ENCRYPTED) throw new Error(`Encrypted files are not supported (${name})`)
      if (method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name}`)
      if (!entries.has(name)) entries.set(name, { method, crc, csize, size: usize, at })
    }
  } finally { await fh.close() }

  // where a file's data starts: after its local header, whose extra field may differ
  const dataStart = async (h, e, name) => {
    if (e.at + 30 > size) throw damaged(name)
    const local = await readAt(h, 30, e.at, name)
    if (local.readUInt32LE(0) !== LOCAL) throw damaged(name)
    const start = e.at + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    if (start + e.csize > size) throw damaged(name)
    return start
  }
  const entry = name => {
    const e = entries.get(name)
    if (!e) throw new Error(`${name} is missing from the backup`)
    return e
  }
  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    async read(name) {
      const e = entry(name)
      if (e.size > READ_LIMIT || e.csize > READ_LIMIT) throw new Error(`${name} is too large`)
      const h = await fs.open(file, 'r')
      try {
        const raw = await readAt(h, e.csize, await dataStart(h, e, name), name)
        const data = e.method === 0 ? raw : await inflateRaw(raw, { maxOutputLength: Math.max(1, e.size) }).catch(() => { throw damaged(name) })
        if (data.length !== e.size || (crc32(data) >>> 0) !== e.crc) throw damaged(name)
        return data
      } finally { await h.close() }
    },
    async extract(name, dest) {
      const e = entry(name)
      const h = await fs.open(file, 'r')
      let start
      try { start = await dataStart(h, e, name) } finally { await h.close() }
      const check = checker(e.size)
      const source = e.csize ? createReadStream(file, { start, end: start + e.csize - 1, highWaterMark: CHUNK }) : Readable.from([])
      try {
        await pipeline(source, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), check, createWriteStream(dest))
          .catch(err => { throw err.message === 'too much data' || err.code?.startsWith('Z_') ? damaged(name) : err })
        if (check.bytes !== e.size || (check.crc >>> 0) !== e.crc) throw damaged(name)
      } catch (err) {
        await fs.rm(dest, { force: true })
        throw err
      }
    },
  }
}

module.exports = { writeZip, openZip }
