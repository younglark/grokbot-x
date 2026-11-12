// 交互预览验收窗口：把验收 zip 解到状态目录，由只绑 127.0.0.1 的临时 HTTP 服务下发，
// 在隔离的 BrowserWindow（独立内存分区、sandbox、只放行本服务的请求）里打开。
// 页面经 window.__grokbotXPreview.submitFeedback 交来的反馈只写盘 + 进剪贴板，
// 永远不会自动发到对话里。纯逻辑都在 preview-core.mjs。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, BrowserWindow, ipcMain, clipboard, dialog, Notification, session as electronSession } from 'electron';
import { createLogger } from '../core/log.mjs';
import { APP_DIR } from '../core/config.mjs';
import {
  LIMITS, extractZip, detectRoot, parseReview, createPreviewServer, newToken,
  validateSubmit, writeFeedback, clipboardPlan, dirClipboardText,
} from './preview-core.mjs';
import { exportStamp } from './edithere-ipc.mjs';
import { writeFileList } from './clipboard-files.mjs';

const log = createLogger('preview');
const PRELOAD = path.join(APP_DIR, 'electron', 'preload-preview.cjs');
const PARTITION = 'gx-preview'; // 无 persist: 前缀 = 纯内存，不落 cookie/storage

let stateDir = '';
let limits = { ...LIMITS };
let server = null;
let serverStarting = null;
let ipcReady = false;
let sessionReady = false;
let changeListener = null;
/** token -> { root, dir, entry, title, scene, zipName, sha, win } */
const sessions = new Map();
/** webContents.id -> token */
const byContents = new Map();

export function previewRoot(root = stateDir) {
  if (!root) throw new Error('state directory is not set');
  return path.join(root, 'features', 'preview');
}
export function feedbackRoot(root = stateDir) { return path.join(previewRoot(root), 'feedback'); }
function openedRoot() { return path.join(previewRoot(), 'opened'); }

export function onPreviewChange(fn) { changeListener = typeof fn === 'function' ? fn : null; }
function changed() { try { changeListener?.(); } catch { /* ignore */ } }

export function configurePreview({ stateDir: dir, limits: lim } = {}) {
  if (dir) stateDir = dir;
  if (lim && typeof lim === 'object') {
    for (const k of Object.keys(LIMITS)) if (Number.isFinite(lim[k]) && lim[k] > 0) limits[k] = lim[k];
  }
  // 上次没清掉的解压目录（崩溃等）：启动时删掉
  try {
    const root = openedRoot();
    if (fs.existsSync(root)) for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  } catch (e) { log.warn(`cleanup opened/: ${e.message}`); }
}

export function previewLimits() { return { ...limits }; }

export function notifyPreview(title, body, isError = false) {
  log[isError ? 'warn' : 'info'](`${title}: ${body.replace(/\n/g, ' ')}`);
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch { /* ignore */ }
}

async function ensureServer() {
  if (server) return server;
  if (!serverStarting) {
    serverStarting = (async () => {
      const s = createPreviewServer({ sessions, log });
      await s.listen();
      log.info(`preview server listening on ${s.origin} (loopback only)`);
      server = s;
      return s;
    })().finally(() => { serverStarting = null; });
  }
  return serverStarting;
}

async function stopServerIfIdle() {
  if (sessions.size || !server) return;
  const s = server;
  server = null;
  await s.close();
  log.info('preview server stopped (no open previews)');
}

function previewSession() {
  const ses = electronSession.fromPartition(PARTITION);
  if (sessionReady) return ses;
  sessionReady = true;
  // 只放行本机预览服务；包里引用的外网资源、跟踪像素等一律拦下
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok = (server && (u === server.origin || u.startsWith(`${server.origin}/`)))
      || /^(data|blob|devtools|chrome-extension):/i.test(u);
    if (!ok) log.warn(`blocked request from preview: ${u.split(/[?#]/)[0].slice(0, 120)}`);
    cb({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  return ses;
}

function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('preview:submit', async (event, payload) => {
    const token = byContents.get(event.sender.id);
    const s = token && sessions.get(token);
    // 只认外壳主框架（iframe 里的预览页拿不到 preload）
    if (!s || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'unauthorized' };
    const v = validateSubmit(payload, limits);
    if (!v.ok) { log.warn(`submit rejected: ${v.error}`); return { ok: false, error: v.error }; }
    try {
      return await handleSubmit(s, v);
    } catch (e) {
      log.error(`submit failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });
}

async function handleSubmit(s, v) {
  const meta = { zip: s.zipName, title: s.title, scene: s.scene, savedAt: new Date().toISOString(), autoSent: false };
  const out = writeFeedback(feedbackRoot(), { json: v.json, files: v.files }, { stamp: exportStamp(), meta });
  const plan = clipboardPlan({ fileCount: v.files.length, totalBytes: v.totalBytes }, limits);
  let mode = plan;
  if (plan === 'files') {
    let r;
    try { r = await writeFileList(out.paths, { clipboard }); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      log.warn(`file-list clipboard failed (${r.error}); copying directory path instead`);
      clipboard.writeText(dirClipboardText(out.dir, out.jsonText));
      mode = 'dir';
    } else log.info(`copied feedback + ${v.files.length} file(s) via ${r.method}`);
  } else if (plan === 'dir') {
    clipboard.writeText(dirClipboardText(out.dir, out.jsonText));
  } else {
    clipboard.writeText(out.jsonText);
  }
  log.info(`feedback saved (${v.files.length} file(s), ${v.totalBytes} bytes, clipboard=${mode}) dir=${out.dir}`);
  const message = mode === 'text' ? '反馈 JSON 已复制，请粘贴回对话（不会自动发送）'
    : mode === 'files' ? `反馈 JSON 和 ${v.files.length} 个附件已复制，请粘贴回对话（不会自动发送）`
      : '附件较大，已复制反馈目录路径和 JSON，请粘贴回对话（不会自动发送）';
  notifyPreview('交互预览验收', message);
  return { ok: true, mode, dir: out.dir, files: v.files.length, message };
}

function lockWindow(win, shellUrl) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (url !== shellUrl) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (url !== shellUrl) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

function cleanup(token) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  for (const [id, t] of byContents) if (t === token) byContents.delete(id);
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { log.warn(`remove ${s.dir}: ${e.message}`); }
  stopServerIfIdle().catch(() => {});
  changed();
}

/**
 * 打开一个验收包。buffer 是 zip 原始字节；name 是附件文件名（只用于标题和日志）。
 * 同一个包（sha256 相同）已经开着就直接聚焦。
 */
export async function openPreviewZip({ buffer, name = 'preview.zip', source = '' } = {}) {
  if (!stateDir) throw new Error('preview is not configured');
  if (!Buffer.isBuffer(buffer)) throw new Error('missing zip bytes');
  if (buffer.length > limits.maxZipBytes) throw new Error(`压缩包超过上限 ${limits.maxZipBytes} 字节`);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  for (const s of sessions.values()) {
    if (s.sha === sha && s.win && !s.win.isDestroyed()) {
      if (s.win.isMinimized()) s.win.restore();
      s.win.show(); s.win.focus();
      log.info(`reused preview window for ${name}`);
      return { reused: true, title: s.title };
    }
  }
  registerIpc();
  const token = newToken();
  const dir = path.join(openedRoot(), token);
  let s;
  try {
    const { files } = extractZip(buffer, dir, limits);
    const top = detectRoot(files);
    const root = top ? path.join(dir, top) : dir;
    const reviewPath = path.join(root, 'review.json');
    const text = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '';
    const { review, warnings } = parseReview(text, { fallbackTitle: name.replace(/\.zip$/i, '') });
    for (const w of warnings) log.warn(`${name}: ${w}`);
    if (!fs.existsSync(path.join(root, ...review.entry.split('/')))) throw new Error(`包里没有入口文件 ${review.entry}`);
    s = { root, dir, entry: review.entry, title: review.title, scene: review.scene, zipName: name, sha, win: null };
    sessions.set(token, s);
    log.info(`extracted ${name} (${files.length} files, ${buffer.length} bytes${source ? `, via ${source}` : ''}) entry=${review.entry} scene=${review.scene}`);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
  try {
    const srv = await ensureServer();
    const shellUrl = `${srv.origin}/__gx/shell/${token}`;
    const win = new BrowserWindow({
      width: 1320,
      height: 900,
      title: `${s.title} · 交互预览验收`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        session: previewSession(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    s.win = win;
    byContents.set(win.webContents.id, token);
    lockWindow(win, shellUrl);
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('closed', () => cleanup(token));
    await win.loadURL(shellUrl);
    changed();
    return { reused: false, title: s.title, entry: s.entry };
  } catch (e) {
    try { s.win?.destroy(); } catch { /* ignore */ }
    cleanup(token);
    throw e;
  }
}

/** 托盘「打开本地验收 zip…」与 --open-preview：本地文件也走同一条链路。 */
export async function openPreviewFile(file) {
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > limits.maxZipBytes) throw new Error(`压缩包超过上限 ${limits.maxZipBytes} 字节`);
  return openPreviewZip({ buffer: fs.readFileSync(abs), name: path.basename(abs), source: 'local-file' });
}

/** 让用户自己选文件（默认定位到 下载目录/<name>）。取消返回 null。 */
export async function pickZipFile(name = '') {
  const dl = downloadsDir();
  const r = await dialog.showOpenDialog({
    title: name ? `选择「${name}」（可先在 Grok Bot 附件卡上点下载保存）` : '选择验收 zip',
    defaultPath: dl && name ? path.join(dl, path.basename(name)) : dl || undefined,
    properties: ['openFile'],
    filters: [{ name: '验收包', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return r.filePaths[0];
}

export function downloadsDir() {
  try { return app.getPath('downloads'); } catch { return ''; }
}

export function hasPreviewWindow() {
  for (const s of sessions.values()) if (s.win && !s.win.isDestroyed()) return true;
  return false;
}

export function previewCount() { return sessions.size; }

export function closeAllPreviews() {
  for (const [token, s] of [...sessions]) {
    try { if (s.win && !s.win.isDestroyed()) s.win.destroy(); } catch { /* ignore */ }
    cleanup(token);
  }
}
