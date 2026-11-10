'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // 'win32', 'linux'…: for platform-specific fonts and wording
  chooseFiles: () => ipcRenderer.invoke('choose-files'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  readBook: p => ipcRenderer.invoke('read-book', p),
  getPendingFiles: () => ipcRenderer.invoke('get-pending-files'),
  onOpenFiles: cb => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  pathForFile: file => webUtils.getPathForFile(file),
  library: {
    get: () => ipcRenderer.invoke('library-get'),
    upsert: (p, data) => ipcRenderer.invoke('library-upsert', p, data),
    remove: id => ipcRenderer.invoke('library-remove', id),
  },
  bookId: p => ipcRenderer.invoke('book-id', p),
  storeBooks: paths => ipcRenderer.invoke('store-books', paths),
  chooseImage: () => ipcRenderer.invoke('choose-image'),
  backup: {
    info: () => ipcRenderer.invoke('backup-info'),
    create: prefs => ipcRenderer.invoke('backup-create', prefs),
    pick: () => ipcRenderer.invoke('backup-pick'),
    restore: file => ipcRenderer.invoke('backup-restore', file),
    auto: opts => ipcRenderer.invoke('backup-auto', opts),
    setPrefs: prefs => ipcRenderer.invoke('backup-prefs', prefs),
    show: which => ipcRenderer.invoke('backup-show', which),
  },
  stats: {
    get: () => ipcRenderer.invoke('stats-get'),
    add: entry => ipcRenderer.invoke('stats-add', entry),
  },
  goals: {
    get: () => ipcRenderer.invoke('goals-get'),
    set: goals => ipcRenderer.invoke('goals-set', goals),
  },
  searchBookInfo: opts => ipcRenderer.invoke('search-book-info', opts),
  fetchCoverImage: url => ipcRenderer.invoke('fetch-cover-image', url),
  lookupDefinition: word => ipcRenderer.invoke('lookup-definition', word),
  lookupWikipedia: (title, lang) => ipcRenderer.invoke('lookup-wikipedia', title, lang),
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: s => ipcRenderer.invoke('settings-set', s),
  },
  showInFolder: p => ipcRenderer.invoke('show-in-folder', p),
  setFullscreen: on => ipcRenderer.invoke('set-fullscreen', on),
  capture: rect => ipcRenderer.invoke('capture', rect),
  saveText: (name, text) => ipcRenderer.invoke('save-text', name, text),
})
