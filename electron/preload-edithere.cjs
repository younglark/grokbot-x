// Sandboxed preload for the picture-annotation editor window.
// Exposes window.grokbotX via contextBridge. No Node integration in the page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, holder) {
  ipcRenderer.on(channel, (_event, payload) => {
    if (typeof holder.cb === 'function') holder.cb(payload);
    else holder.queued = payload;
  });
  return (cb) => {
    holder.cb = cb;
    if (holder.queued !== undefined) {
      const value = holder.queued;
      holder.queued = undefined;
      cb(value);
    }
  };
}

const image = { cb: null, queued: undefined };
const hostInfo = { cb: null, queued: undefined };
const selfTest = { cb: null, queued: undefined };

const onImage = listen('edithere:image', image);
const onHostInfo = listen('edithere:host-info', hostInfo);
const onSelfTestExport = listen('edithere:self-test-export', selfTest);

contextBridge.exposeInMainWorld('grokbotX', {
  onImage,
  onHostInfo,
  onSelfTestExport,
  getHostInfo: () => ipcRenderer.invoke('edithere:host-info'),
  saveFiles: (payload) => ipcRenderer.invoke('edithere:save-files', payload),
  saveFeedback: (payload) => ipcRenderer.invoke('edithere:save-files', payload),
  copyText: (payload) => ipcRenderer.invoke('edithere:copy-text', payload),
  copyFiles: (payload) => ipcRenderer.invoke('edithere:copy-files', payload),
  showItemInFolder: () => ipcRenderer.invoke('edithere:show-item-in-folder'),
});

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('edithere:ready');
});
