const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: () => '0.1.0-m0'
});
