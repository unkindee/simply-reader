// Prepended to pdf.js (pdf.mjs and pdf.worker.mjs) in the Android build by prepare-web.mjs.
// The vendored pdf.js expects a current Chromium, as desktop's Electron has; Android's System
// WebView can be older (Uint8Array hex/base64 arrived in Chromium 140, getOrInsert later still).
// Each one is only added when missing.
;(() => {
  const def = (obj, name, fn) => { if (obj && typeof obj[name] !== 'function') Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true }) }
  const U8 = Uint8Array
  def(U8.prototype, 'toHex', function () { let s = ''; for (const b of this) s += b.toString(16).padStart(2, '0'); return s })
  def(U8, 'fromHex', function (hex) {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new SyntaxError('Invalid hex string')
    const out = new U8(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
    return out
  })
  def(U8.prototype, 'toBase64', function (opts) {
    let s = ''
    for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000))
    let b = btoa(s)
    if (opts?.alphabet === 'base64url') b = b.replace(/\+/g, '-').replace(/\//g, '_')
    if (opts?.omitPadding) b = b.replace(/=+$/, '')
    return b
  })
  def(U8, 'fromBase64', function (str, opts) {
    let s = String(str).replace(/\s+/g, '')
    if (opts?.alphabet === 'base64url') s = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(s)
    const out = new U8(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  })
  for (const M of [Map, WeakMap]) {
    def(M.prototype, 'getOrInsert', function (key, value) { if (!this.has(key)) this.set(key, value); return this.get(key) })
    def(M.prototype, 'getOrInsertComputed', function (key, fn) { if (!this.has(key)) this.set(key, fn(key)); return this.get(key) })
  }
  def(Promise, 'try', function (fn, ...args) { return new Promise(resolve => resolve(fn(...args))) })
  def(Promise, 'withResolvers', function () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } })
  def(ArrayBuffer.prototype, 'transferToFixedLength', function (len = this.byteLength) { const out = new ArrayBuffer(len); new U8(out).set(new U8(this, 0, Math.min(len, this.byteLength))); return out })
  def(ArrayBuffer.prototype, 'transfer', function (len = this.byteLength) { const out = new ArrayBuffer(len); new U8(out).set(new U8(this, 0, Math.min(len, this.byteLength))); return out })
})();
