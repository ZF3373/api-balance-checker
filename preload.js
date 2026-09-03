'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
  },
  keys: {
    list: () => ipcRenderer.invoke('keys:list'),
    add: (entry) => ipcRenderer.invoke('keys:add', entry),
    addBatch: (payload) => ipcRenderer.invoke('keys:addBatch', payload),
    update: (id, patch) => ipcRenderer.invoke('keys:update', id, patch),
    remove: (id) => ipcRenderer.invoke('keys:delete', id),
    dedup: () => ipcRenderer.invoke('keys:dedup'),
    query: (id) => ipcRenderer.invoke('keys:query', id),
    queryAll: () => ipcRenderer.invoke('keys:queryAll'),
    models: (id) => ipcRenderer.invoke('keys:models', id),
    test: (id) => ipcRenderer.invoke('keys:test', id),
  },
  server: {
    start: (port) => ipcRenderer.invoke('server:start', port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status'),
    getUnifiedKey: () => ipcRenderer.invoke('server:getUnifiedKey'),
    regenerateKey: () => ipcRenderer.invoke('server:regenerateKey'),
    getPort: () => ipcRenderer.invoke('server:getPort'),
  },
  routes: {
    get: () => ipcRenderer.invoke('routes:get'),
    set: (modelId, keyId) => ipcRenderer.invoke('routes:set', modelId, keyId),
    clear: () => ipcRenderer.invoke('routes:clear'),
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    getVersion: () => ipcRenderer.invoke('update:getVersion'),
    onStatus: (callback) => {
      const handler = (_e, status) => callback(status);
      ipcRenderer.on('update:status', handler);
      return () => ipcRenderer.removeListener('update:status', handler);
    },
  },
});
