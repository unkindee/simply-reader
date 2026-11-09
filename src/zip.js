'use strict'
// Minimal .zip writer and reader for library backups (no dependencies).
// Files that are already compressed (books, images) are stored as they are;
// JSON and other text is deflated. Archives up to 4 GB / 65,535 files.
const fs = require('node:fs/promises')
const zlib = require('node:zlib')
const { promisify } = require('node:util')

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
const crc32 = zlib.crc32 ?? (buf => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
})

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50
const UTF8 = 0x0800
const MAX32 = 0xFFFFFFFF
const ALREADY_COMPRESSED = /\.(epub|zip|cbz|fbz|jpe?g|png|webp|gif|avif|mobi|azw3?|kf8|prc|pdf)$/i
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff
const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff

// entries: [{ name, data: Buffer } | { name, file: path }]; written to `dest` via a temp file
async function writeZip(dest, entries) {
  const tmp = dest + '.part'
  const fh = await fs.open(tmp, 'w')
  const central = []
  const now = new Date()
  let offset = 0
  try {
    for (const e of entries) {
      const data = e.data ?? await fs.readFile(e.file)
      const name = Buffer.from(e.name, 'utf8')
      let body = data, method = 0
      if (!ALREADY_COMPRESSED.test(e.name) && data.length > 64) {
        const z = await deflateRaw(data, { level: 6 })
        if (z.length < data.length) { body = z; method = 8 }
      }
      if (data.length > MAX32 || offset + 30 + name.length + body.length > MAX32) throw new Error('The backup would be larger than 4 GB')
      const crc = crc32(data) >>> 0
      const h = Buffer.alloc(30)
      h.writeUInt32LE(LOCAL, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(UTF8, 6); h.writeUInt16LE(method, 8)
      h.writeUInt16LE(dosTime(now), 10); h.writeUInt16LE(dosDate(now), 12); h.writeUInt32LE(crc, 14)
      h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26)
      await fh.write(h); await fh.write(name); await fh.write(body)
      central.push({ name, method, crc, csize: body.length, size: data.length, offset })
      offset += 30 + name.length + body.length
    }
    if (central.length > 0xffff) throw new Error('Too many files for one backup')
    const cdStart = offset
    for (const c of central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(CENTRAL, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(UTF8, 8)
      h.writeUInt16LE(c.method, 10); h.writeUInt16LE(dosTime(now), 12); h.writeUInt16LE(dosDate(now), 14)
      h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24)
      h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.offset, 42)
      await fh.write(h); await fh.write(c.name)
      offset += 46 + c.name.length
    }
    if (offset > MAX32) throw new Error('The backup would be larger than 4 GB')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16)
    await fh.write(end)
    await fh.close()
  } catch (e) {
    await fh.close().catch(() => {})
    await fs.rm(tmp, { force: true })
    throw e
  }
  await fs.rename(tmp, dest)
  return offset + 22
}

// returns Map(name -> Buffer); checks every file's size and checksum
async function readZip(file) {
  const buf = await fs.readFile(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === END) { eocd = i; break }
  if (eocd < 0) throw new Error('This file is not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error('The backup file is damaged')
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & UTF8 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen)
    p += 46 + nlen + xlen + clen
    if (name.endsWith('/')) continue
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LOCAL) throw new Error('The backup file is damaged')
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    if (start + csize > buf.length) throw new Error('The backup file is damaged')
    const raw = buf.subarray(start, start + csize)
    const data = method === 0 ? raw
      : method === 8 ? await inflateRaw(raw, { maxOutputLength: Math.max(1, size) })
      : null
    if (!data) throw new Error(`Unsupported compression in ${name}`)
    if (data.length !== size || (crc32(data) >>> 0) !== crc) throw new Error(`The backup file is damaged (${name})`)
    out.set(name, data)
  }
  return out
}

module.exports = { writeZip, readZip }
