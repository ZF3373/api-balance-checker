'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
  },
  keys: {
    list: () => ipcRenderer.invoke('keys:list'),
    add: (entry) => ipcRenderer.invoke('keys:add', entry),
    update: (id, patch) => ipcRenderer.invoke('keys:update', id, patch),
    remove: (id) => ipcRenderer.invoke('keys:delete', id),
    query: (id) => ipcRenderer.invoke('keys:query', id),
    queryAll: () => ipcRenderer.invoke('keys:queryAll'),
  },
  server: {
    start: (port) => ipcRenderer.invoke('server:start', port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status'),
    getUnifiedKey: () => ipcRenderer.invoke('server:getUnifiedKey'),
    regenerateKey: () => ipcRenderer.invoke('server:regenerateKey'),
    getPort: () => ipcRenderer.invoke('server:getPort'),
  },
});
