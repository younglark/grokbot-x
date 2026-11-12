// In-app picture-annotation window (fork of the EditHere web editor).
// Loads the built HTML over a custom scheme (no HTTP server). Isolated,
// sandboxed renderer; image load and exports go through preload + IPC.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow, protocol, net, ipcMain, clipboard, nativeImage,
  dialog, Notification, shell,
} from 'electron';
import { createLogger } from '../core/log.mjs';
import { APP_DIR } from '../core/config.mjs';
import {
  validateFilesPayload, validateCopyText, validateCopyFiles, validateImagePayload,
  exportStamp, imageInfo,
} from './edithere-ipc.mjs';

export const SCHEME = 'gx-edithere';
export const EDITOR_URL = `${SCHEME}://app/editor.html`;
const log = createLogger('editor');
const PRELOAD = path.join(APP_DIR, 'electron', 'preload-edithere.cjs');

let buildDir = '';
let stateDir = '';
let win = null;
let ipcReady = false;
let lastExportDir = '';
let lastExportFile = '';
let pendingImage = null;
let hostInfo = { exportDir: '' };
let selfTestWaiter = null;

export function exportsRoot(root = stateDir) {
  if (!root) throw new Error('state directory is not set');
  return path.join(root, 'features', 'edithere', 'exports');
}

export function registerEditorScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

export function configureEditor({ stateDir: dir, buildDir: built } = {}) {
  if (dir) {
    stateDir = dir;
    hostInfo.exportDir = exportsRoot(dir);
  }
  if (built) buildDir = built;
}

function allowedAsset(name) {
  return name === 'editor.html';
}

export function handleEditorProtocol(dir = buildDir) {
  buildDir = dir;
  protocol.handle(SCHEME, (request) => {
    const u = new URL(request.url);
    if (u.hostname !== 'app') return new Response('Not found', { status: 404 });
    const name = path.posix.basename(u.pathname || '') || 'editor.html';
    if (!allowedAsset(name)) return new Response('Not found', { status: 404 });
    const file = path.join(buildDir, name);
    if (!file.startsWith(buildDir) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

function notifyUser(title, body) {
  log.info(`${title}: ${String(body || '').replace(/\n/g, ' ')}`);
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* headless */ }
}

function displayPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

async function writeExport(files, { reveal, pickLocation }) {
  let dir;
  if (pickLocation) {
    const parent = win && !win.isDestroyed() ? win : null;
    const choice = await dialog.showOpenDialog(parent, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: lastExportDir || (stateDir && exportsRoot()) || undefined,
    });
    if (choice.canceled || !choice.filePaths?.[0]) return { ok: false, cancelled: true, error: 'cancelled' };
    dir = path.join(choice.filePaths[0], exportStamp());
  } else {
    dir = path.join(exportsRoot(), exportStamp());
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let first = '';
  for (const file of files) {
    const dest = path.join(dir, file.name);
    fs.writeFileSync(dest, file.buffer, { mode: 0o600 });
    if (!first) first = dest;
  }
  lastExportDir = dir;
  lastExportFile = first;
  if (reveal && first) {
    try { shell.showItemInFolder(first); } catch (e) { log.warn(`showItemInFolder: ${e.message}`); }
  }
  const message = `已保存到 ${displayPath(dir)}`;
  notifyUser('图片批注', `${message}。可在窗口顶栏点「在文件夹中显示」。不会回填 Grok Bot。`);
  return { ok: true, dir, file: first, message };
}

function writeClipboardFiles(files) {
  const json = files.find((f) => f.mime === 'application/json' || /\.json$/i.test(f.name));
  const image = files.find((f) => /^image\//i.test(f.mime));
  const payload = {};
  if (json) payload.text = json.buffer.toString('utf8');
  if (image) {
    const img = nativeImage.createFromBuffer(image.buffer);
    if (!img.isEmpty()) payload.image = img;
  }
  if (!payload.text && !payload.image) {
    return { ok: false, error: 'nothing to copy' };
  }
  clipboard.write(payload);
  return { ok: true, copiedText: !!payload.text, copiedImage: !!payload.image };
}

function isEditorSender(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

export function registerEditorIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.on('edithere:ready', (event) => {
    if (!isEditorSender(event)) return;
    if (pendingImage) event.sender.send('edithere:image', pendingImage);
    event.sender.send('edithere:host-info', hostInfo);
  });

  ipcMain.handle('edithere:host-info', (event) => {
    if (!isEditorSender(event)) return { error: 'unauthorized' };
    return { ...hostInfo };
  });

  ipcMain.handle('edithere:save-files', async (event, payload) => {
    if (!isEditorSender(event)) return { ok: false, error: 'unauthorized' };
    const v = validateFilesPayload(payload);
    if (!v.ok) { log.warn(`save-files rejected: ${v.error}`); return { ok: false, error: v.error }; }
    try {
      const result = await writeExport(v.files, { reveal: v.reveal, pickLocation: v.pickLocation });
      if (selfTestWaiter && v.kind === 'self-test') {
        selfTestWaiter(result);
        selfTestWaiter = null;
      }
      return result;
    } catch (e) {
      log.error(`save-files failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('edithere:copy-text', (event, payload) => {
    if (!isEditorSender(event)) return { ok: false, error: 'unauthorized' };
    const v = validateCopyText(payload);
    if (!v.ok) return { ok: false, error: v.error };
    clipboard.writeText(v.text);
    return { ok: true };
  });

  ipcMain.handle('edithere:copy-files', (event, payload) => {
    if (!isEditorSender(event)) return { ok: false, error: 'unauthorized' };
    const v = validateCopyFiles(payload);
    if (!v.ok) return { ok: false, error: v.error };
    return writeClipboardFiles(v.files);
  });

  ipcMain.handle('edithere:show-item-in-folder', (event) => {
    if (!isEditorSender(event)) return { ok: false, error: 'unauthorized' };
    const target = lastExportFile || lastExportDir || (stateDir && exportsRoot());
    if (!target) return { ok: false, error: 'no export yet' };
    const existing = fs.existsSync(target) ? target : path.dirname(target);
    try { shell.showItemInFolder(existing); } catch (e) { return { ok: false, error: e.message }; }
    try { if (fs.statSync(existing).isDirectory()) shell.openPath(existing); } catch { /* showItem is enough */ }
    return { ok: true, dir: lastExportDir || existing };
  });
}

function lockNavigation(wc) {
  const ok = (url) => url === EDITOR_URL || url === `${EDITOR_URL}/`;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!ok(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!ok(url)) e.preventDefault(); });
  wc.setUserAgent(`${wc.getUserAgent()} grokbot-x-editor`);
}

function waitReady(wc, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('edithere:ready', onReady);
      reject(new Error('editor page did not become ready'));
    }, ms);
    function onReady(event) {
      if (event.sender !== wc) return;
      clearTimeout(timer);
      ipcMain.removeListener('edithere:ready', onReady);
      resolve(true);
    }
    ipcMain.on('edithere:ready', onReady);
  });
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '图片批注',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  lockNavigation(w.webContents);
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.on('closed', () => { if (win === w) win = null; });
  return w;
}

export async function openEditor(payload) {
  registerEditorIpc();
  const v = validateImagePayload(payload);
  if (!v.ok) throw new Error(v.error);
  const info = {
    dataUrl: v.dataUrl,
    name: v.name,
    width: v.width,
    height: v.height,
    exportDir: hostInfo.exportDir || '',
  };
  pendingImage = info;
  const mustReload = !win || win.isDestroyed();
  if (mustReload) {
    win = createWindow();
    const ready = waitReady(win.webContents);
    await win.loadURL(EDITOR_URL);
    await ready;
  } else {
    // A previous session cannot accept another loadAgentImage call; reload.
    const ready = waitReady(win.webContents);
    await win.loadURL(EDITOR_URL);
    await ready;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  log.info(`loaded ${v.name} into annotation window`);
}

export async function openImageFile(file) {
  const abs = path.resolve(file);
  const buf = fs.readFileSync(abs);
  if (buf.length > MAX_SAFE()) throw new Error('image file too large');
  const info = imageInfo(buf);
  if (!info.mime) throw new Error(`unsupported image format in ${abs}`);
  await openEditor({
    dataUrl: `data:${info.mime};base64,${buf.toString('base64')}`,
    name: path.basename(abs),
    width: info.w,
    height: info.h,
  });
  return { name: path.basename(abs), width: info.w, height: info.h, bytes: buf.length };
}

function MAX_SAFE() { return 80 * 1024 * 1024; }

export function requestSelfTestExport(ms = 20000) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('editor is not open'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (selfTestWaiter) selfTestWaiter = null;
      reject(new Error('self-test-export timed out'));
    }, ms);
    selfTestWaiter = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    win.webContents.send('edithere:self-test-export');
  });
}

export function editorWindow() {
  return win && !win.isDestroyed() ? win : null;
}

export function lastExport() {
  return { dir: lastExportDir, file: lastExportFile };
}

export function closeEditor() {
  if (win && !win.isDestroyed()) win.close();
  win = null;
  pendingImage = null;
}
