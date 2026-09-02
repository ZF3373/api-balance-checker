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
});
