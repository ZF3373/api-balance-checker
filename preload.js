'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./shared/ipc-channels');

contextBridge.exposeInMainWorld('api', {
  providers: {
    list: () => ipcRenderer.invoke(CH.providersList),
  },
  keys: {
    list: () => ipcRenderer.invoke(CH.keysList),
    add: (entry) => ipcRenderer.invoke(CH.keysAdd, entry),
    addBatch: (payload) => ipcRenderer.invoke(CH.keysAddBatch, payload),
    update: (id, patch) => ipcRenderer.invoke(CH.keysUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.keysDelete, id),
    dedup: () => ipcRenderer.invoke(CH.keysDedup),
    query: (id) => ipcRenderer.invoke(CH.keysQuery, id),
    queryAll: () => ipcRenderer.invoke(CH.keysQueryAll),
    models: (id) => ipcRenderer.invoke(CH.keysModels, id),
    test: (id) => ipcRenderer.invoke(CH.keysTest, id),
  },
  server: {
    start: (port) => ipcRenderer.invoke(CH.serverStart, port),
    stop: () => ipcRenderer.invoke(CH.serverStop),
    status: () => ipcRenderer.invoke(CH.serverStatus),
    getUnifiedKey: () => ipcRenderer.invoke(CH.serverGetUnifiedKey),
    regenerateKey: () => ipcRenderer.invoke(CH.serverRegenerateKey),
    getPort: () => ipcRenderer.invoke(CH.serverGetPort),
  },
  routes: {
    get: () => ipcRenderer.invoke(CH.routesGet),
    set: (modelId, keyId) => ipcRenderer.invoke(CH.routesSet, modelId, keyId),
    clear: () => ipcRenderer.invoke(CH.routesClear),
  },
  updater: {
    check: () => ipcRenderer.invoke(CH.updateCheck),
    install: () => ipcRenderer.invoke(CH.updateInstall),
    getVersion: () => ipcRenderer.invoke(CH.updateGetVersion),
    onStatus: (callback) => {
      const handler = (_e, status) => callback(status);
      ipcRenderer.on(CH.updateStatus, handler);
      return () => ipcRenderer.removeListener(CH.updateStatus, handler);
    },
  },
});
