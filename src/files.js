'use strict'
// File helpers shared by the main process and the backup code.
const fs = require('node:fs/promises')

// On Windows, antivirus, search indexing or a sync client (OneDrive, Dropbox) can hold a file
// open for a moment, and renaming it then fails. Try again for a few seconds before giving up.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
async function rename(from, to) {
  for (let wait = 50; ; wait *= 2) {
    try { return await fs.rename(from, to) }
    catch (e) { if (!BUSY.has(e.code) || wait > 3200) throw e }
    await new Promise(r => setTimeout(r, wait))
  }
}

module.exports = { rename }
