// Sandboxed preload for the 交互预览验收 shell window.
// Only the shell page (http://127.0.0.1:<port>/__gx/shell/...) gets window.gxPreviewHost;
// the preview itself runs in a sandbox iframe without allow-same-origin and cannot reach it.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gxPreviewHost', {
  submit: (payload) => ipcRenderer.invoke('preview:submit', payload),
});
