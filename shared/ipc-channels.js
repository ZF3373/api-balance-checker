'use strict';

/**
 * IPC 通道常量表 — main.js 与 preload.js 共用，避免两侧手写字符串失配。
 */
module.exports = {
  providersList: 'providers:list',
  keysList: 'keys:list',
  keysAdd: 'keys:add',
  keysAddBatch: 'keys:addBatch',
  keysUpdate: 'keys:update',
  keysDelete: 'keys:delete',
  keysDedup: 'keys:dedup',
  keysQuery: 'keys:query',
  keysQueryAll: 'keys:queryAll',
  keysModels: 'keys:models',
  keysTest: 'keys:test',
  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverStatus: 'server:status',
  serverGetUnifiedKey: 'server:getUnifiedKey',
  serverRegenerateKey: 'server:regenerateKey',
  serverGetPort: 'server:getPort',
  routesGet: 'routes:get',
  routesSet: 'routes:set',
  routesClear: 'routes:clear',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateGetVersion: 'update:getVersion',
  updateStatus: 'update:status', // main → renderer 推送事件
};
