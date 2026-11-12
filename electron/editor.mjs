// In-app picture-annotation window (fork of the EditHere web editor).
// Loads the built HTML over a custom scheme (no HTTP server). Isolated,
// sandboxed renderer; image load and exports go through preload + IPC.
import fs from 'node:fs';
import crypto from 'node:crypto';
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
  exportStamp, imageInfo, fillFeedbackImagePaths,
} from './edithere-ipc.mjs';
import { createWaitReady, createEditorSession } from './editor-session.mjs';
import { writeFileList, savedPathsFor } from './clipboard-files.mjs';

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
/** Absolute paths written by the latest writeExport, in save order. */
let lastExportPaths = [];
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
  const names = files.map((f) => f.name);
  let jsonText = '';
  let jsonName = '';
  let first = '';
  const paths = [];
  for (const file of files) {
    let buffer = file.buffer;
    const isJson = file.mime === 'application/json' || /\.json$/i.test(file.name);
    if (isJson) {
      const src = buffer.toString('utf8');
      const filled = fillFeedbackImagePaths(src, dir, names);
      if (filled.ok) buffer = Buffer.from(filled.text, 'utf8');
      if (!jsonText) {
        jsonText = filled.ok ? filled.text : src;
        jsonName = file.name;
      }
    }
    const dest = path.join(dir, file.name);
    fs.writeFileSync(dest, buffer, { mode: 0o600 });
    paths.push(dest);
    if (!first) first = dest;
  }
  lastExportDir = dir;
  lastExportFile = first;
  lastExportPaths = paths;
  if (reveal && first) {
    try { shell.showItemInFolder(first); } catch (e) { log.warn(`showItemInFolder: ${e.message}`); }
  }
  const message = `已保存到 ${displayPath(dir)}`;
  notifyUser('图片批注', `${message}。可在窗口顶栏点「在文件夹中显示」。不会回填 Grok Bot。`);
  return { ok: true, dir, file: first, paths, message, jsonText, jsonName };
}

function isJsonFile(f) {
  return f.mime === 'application/json' || /\.json$/i.test(f.name);
}

// Old behaviour, kept as fallback: JSON text + image bitmap in one write.
function writeTextAndImage(files) {
  const json = files.find(isJsonFile);
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
  return { ok: true, copiedText: !!payload.text, copiedImage: !!payload.image, method: 'text+image' };
}

async function writeClipboardFiles(files) {
  const paths = savedPathsFor(files, lastExportPaths);
  if (paths.length) {
    try {
      const r = await writeFileList(paths, { clipboard });
      if (r.ok) {
        log.info(`copied ${r.count} file(s) via ${r.method}`);
        return { ok: true, copiedFiles: paths.length, paths, method: r.method };
      }
      log.warn(`file-list clipboard failed (${r.error}); falling back to text + image`);
    } catch (e) {
      log.warn(`file-list clipboard threw (${e.message}); falling back to text + image`);
    }
  } else {
    log.warn('copy-files: no saved paths match; falling back to text + image');
  }
  return writeTextAndImage(files);
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
  return createWaitReady({
    timeoutMs: ms,
    subscribe(onReady) {
      const handler = (event) => { if (event.sender === wc) onReady(); };
      ipcMain.on('edithere:ready', handler);
      return () => ipcMain.removeListener('edithere:ready', handler);
    },
  });
}

let changeListener = null;
/** main.mjs registers this to refresh the tray menu when the window appears or goes away. */
export function onEditorChange(fn) { changeListener = typeof fn === 'function' ? fn : null; }

const editorSession = createEditorSession({
  createWindow() {
    const w = buildEditorWindow();
    win = w;
    // × hides the window; page state stays in memory. Quit / feature disable
    // go through forceClose(), after which this handler lets the close through.
    w.on('close', (e) => {
      if (editorSession.handleCloseRequest(w)) {
        e.preventDefault();
        log.info('editor window hidden (state kept)');
      }
    });
    return w;
  },
  isDestroyed(w) { return !w || w.isDestroyed(); },
  destroy(w) {
    if (win === w) win = null;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
  },
  hide(w) { if (w && !w.isDestroyed()) w.hide(); },
  load(w) { return w.loadURL(EDITOR_URL); },
  waitReady(w) { return waitReady(w.webContents); },
  show(w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  },
  onChange() { try { changeListener?.(); } catch { /* ignore */ } },
});

function buildEditorWindow() {
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
  pendingImage = {
    dataUrl: v.dataUrl,
    name: v.name,
    width: v.width,
    height: v.height,
    exportDir: hostInfo.exportDir || '',
  };
  // Same image bytes as the current session: show the kept window as is.
  // Different image (or no live window): build a fresh window. Calls are
  // serialized so overlapping 「编辑」 clicks cannot stack waitReady listeners.
  const key = crypto.createHash('sha256').update(v.buffer).digest('hex');
  const { window: opened, reused } = await editorSession.open(key);
  if (opened) win = opened;
  log.info(reused ? `reused annotation window for ${v.name} (same image)` : `loaded ${v.name} into annotation window`);
  return { reused };
}

/** Tray action: show the hidden window again. Returns false if there is none. */
export function showEditor() {
  return editorSession.showExisting();
}

export function hasEditorWindow() {
  return !!editorSession.current();
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

/** Real close: app quit or feature disable. Never prompts, never hides. */
export function closeEditor({ quitting = false } = {}) {
  if (quitting) editorSession.markQuitting();
  editorSession.forceClose();
  win = null;
  pendingImage = null;
}
