// In-app EditHere window. Loads the vendored HTML over a custom scheme
// (no local HTTP server, no system Chrome). Isolated renderer, no nodeIntegration.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, protocol, net, app, shell } from 'electron';
import { createLogger } from '../core/log.mjs';

export const SCHEME = 'gx-edithere';
const EDITOR_URL = `${SCHEME}://app/EditHere.html`;
const log = createLogger('editor');

let htmlPath = '';
let win = null;

export function registerEditorScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

export function handleEditorProtocol(vendorDir) {
  htmlPath = path.join(vendorDir, 'EditHere.html');
  protocol.handle(SCHEME, (request) => {
    const u = new URL(request.url);
    if (u.hostname !== 'app') return new Response('Not found', { status: 404 });
    const name = path.posix.basename(u.pathname || '');
    if (name !== 'EditHere.html' && name !== 'LICENSE' && name !== 'NOTICE') {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(vendorDir, name)).href);
  });
}

function lockNavigation(wc) {
  const ok = (url) => url === EDITOR_URL || url === `${EDITOR_URL}/`;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!ok(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!ok(url)) e.preventDefault(); });
  wc.setUserAgent(wc.getUserAgent() + ' grokbot-x-editor');
}

async function waitReady(wc, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const ok = await wc.executeJavaScript(
        `document.readyState === 'complete' && !!(window.EditHereWeb && window.EditHereWeb.loadAgentImage)`,
        true,
      );
      if (ok) return true;
    } catch { /* loading */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'EditHere',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: undefined,
      navigateOnDragDrop: false,
    },
  });
  lockNavigation(w.webContents);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.on('closed', () => { if (win === w) win = null; });
  return w;
}

export async function openEditor({ dataUrl, name }) {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    await win.loadURL(EDITOR_URL);
  } else {
    const busy = await win.webContents.executeJavaScript(
      `!!(document.getElementById('workspace') && !document.getElementById('workspace').hidden)`,
      true,
    ).catch(() => false);
    if (busy) {
      await win.loadURL(EDITOR_URL);
    }
  }
  if (!(await waitReady(win.webContents))) throw new Error('EditHere page did not become ready');
  // Pass the image as a function argument so it is never spliced into a script string.
  await win.webContents.executeJavaScript(
    `EditHereWeb.loadAgentImage(${JSON.stringify({ image: dataUrl, name })})`,
    true,
  );
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  log.info(`loaded ${name} into EditHere window`);
}

export function closeEditor() {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

// Satisfy lint: shell/app reserved for future "open in folder" actions.
void path; void app; void shell;
