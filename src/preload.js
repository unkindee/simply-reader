'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
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
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: s => ipcRenderer.invoke('settings-set', s),
  },
  showInFolder: p => ipcRenderer.invoke('show-in-folder', p),
  setFullscreen: on => ipcRenderer.invoke('set-fullscreen', on),
  capture: rect => ipcRenderer.invoke('capture', rect),
  saveText: (name, text) => ipcRenderer.invoke('save-text', name, text),
})
