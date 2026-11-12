// features/edithere daemon side: fetch the previewed image and open it in a
// separate EditHere (web) window running in the user's Chrome/Chromium.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CdpConnection, waitForDevtools, evaluate } from '../../core/cdp.mjs';
import { freePort } from '../../core/net.mjs';

const VIEWER_IMG = `(document.querySelector('.sand-media-viewer') || document).querySelector('img.sand-media-viewer__image')`;
const ALLOWED_SRC = /^(sand-media|https|blob|file):/i;

const state = {
  server: null,
  staticPort: 0,
  browser: null, // { proc, port, conn }
  responses: new Map(), // sessionId\nurl -> {requestId, mimeType}
  queue: Promise.resolve(),
};

// ---------- image helpers ----------
function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { fmt: 'png', mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length && buf[i] === 0xff) {
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { fmt: 'jpeg', mime: 'image/jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { fmt: 'jpeg', mime: 'image/jpeg', w: 0, h: 0 };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const k = buf.toString('ascii', 12, 16);
    if (k === 'VP8X') return { fmt: 'webp', mime: 'image/webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { fmt: 'webp', mime: 'image/webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    return { fmt: 'webp', mime: 'image/webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { fmt: 'gif', mime: 'image/gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') return { fmt: 'bmp', mime: 'image/bmp', w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  return { fmt: 'unknown', mime: '', w: 0, h: 0 };
}

function decodeDataUrl(s) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(s);
  if (!m) throw new Error('bad data URL');
  return /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'latin1');
}

async function captureImage(ctx, sessionId, d) {
  const tried = [];
  const done = (method, buf) => { tried.push(`${method}:ok`); return { method, buf, tried }; };
  const fail = (method, e) => tried.push(`${method}:${String(e?.message || e).slice(0, 80)}`);

  // (a) data: URL, read straight from the viewer image (not sent through the binding)
  if (d.srcIsData) {
    try { return done('data-url', decodeDataUrl(await ctx.evaluate(sessionId, `${VIEWER_IMG}?.currentSrc || ''`))); } catch (e) { fail('data-url', e); }
  }
  const src = String(d.src || '');
  if (src && !ALLOWED_SRC.test(src)) throw new Error(`refusing src scheme ${src.split(':')[0]}`);

  // (b) renderer resource cache
  if (src) {
    try {
      const { frameTree } = await ctx.cdp('Page.getFrameTree', {}, sessionId);
      const frames = [];
      (function walk(n) { frames.push(n.frame.id); (n.childFrames || []).forEach(walk); })(frameTree);
      let lastErr = 'not found';
      for (const frameId of frames) {
        try {
          const r = await ctx.cdp('Page.getResourceContent', { frameId, url: src }, sessionId);
          const buf = r.base64Encoded ? Buffer.from(r.content, 'base64') : Buffer.from(r.content, 'latin1');
          if (buf.length) return done('getResourceContent', buf);
        } catch (e) { lastErr = e.message; }
      }
      fail('getResourceContent', lastErr);
    } catch (e) { fail('getResourceContent', e); }
  }

  // (c) network response body
  const hit = src && state.responses.get(`${sessionId}\n${src}`);
  if (hit) {
    try {
      const r = await ctx.cdp('Network.getResponseBody', { requestId: hit.requestId }, sessionId);
      const buf = r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'latin1');
      if (buf.length) return done('getResponseBody', buf);
      fail('getResponseBody', 'empty');
    } catch (e) { fail('getResponseBody', e); }
  } else if (src) fail('getResponseBody', 'no request seen');

  // (d) public https without credentials
  if (/^https:/i.test(src)) {
    try {
      const r = await fetch(src, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return done('https-fetch', Buffer.from(await r.arrayBuffer()));
    } catch (e) { fail('https-fetch', e); }
  }

  // (e) canvas in page (fails if tainted)
  try {
    const url = await ctx.evaluate(sessionId, `(() => { const i = ${VIEWER_IMG}; if (!i) throw new Error('no image');
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
      c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png'); })()`);
    return done('canvas', decodeDataUrl(url));
  } catch (e) { fail('canvas', e); }

  // (f) screenshot of the displayed image (lossy fallback)
  try {
    const b = await ctx.evaluate(sessionId, `(() => { const i = ${VIEWER_IMG}; if (!i) throw new Error('no image');
      const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const shot = await ctx.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, b.x), y: Math.max(0, b.y), width: b.w, height: b.h, scale: 1 } }, sessionId);
    return done('screenshot', Buffer.from(shot.data, 'base64'));
  } catch (e) { fail('screenshot', e); }

  const err = new Error('all capture methods failed');
  err.tried = tried;
  throw err;
}

// ---------- static server for EditHere.html ----------
function startStatic(ctx) {
  const root = path.join(ctx.featureDir, 'vendor');
  const files = { '/EditHere.html': 'EditHere.html' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const f = files[p];
      if (!f) { res.writeHead(404).end(); return; }
      fs.readFile(path.join(root, f), (err, buf) => {
        if (err) { res.writeHead(500).end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(buf);
      });
    });
    srv.on('error', reject);
    freePort(Number(ctx.config.staticPort) || 0).then((port) => {
      srv.listen(port, '127.0.0.1', () => { state.server = srv; state.staticPort = port; resolve(port); });
    }, reject);
  });
}

// ---------- browser window ----------
function findBrowser(ctx) {
  const wanted = [ctx.config.browser, process.env.GROKBOT_X_BROWSER, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .filter(Boolean);
  for (const c of wanted) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    try { return execFileSync('sh', ['-c', `command -v "$1"`, 'sh', c], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return null;
}

function notifyNoBrowser(ctx) {
  const msg = '没有找到 Google Chrome 或 Chromium，EditHere 窗口无法打开。\n请安装 google-chrome-stable 或 chromium，或在 ~/.config/grokbot-x/config.json 里设置 features.edithere.browser。';
  ctx.log.error(msg.replace(/\n/g, ' '));
  try { spawn('zenity', ['--error', '--title=grokbot-x', `--text=${msg}`], { stdio: 'ignore', detached: true }).unref(); } catch { /* no zenity */ }
}

async function ensureBrowser(ctx) {
  const b = state.browser;
  if (b && b.proc.exitCode == null && b.conn?.open) return b;
  if (b && b.proc.exitCode == null) {
    try {
      const ver = await waitForDevtools(b.port, 3000);
      b.conn = await new CdpConnection(ver.webSocketDebuggerUrl).connect();
      return b;
    } catch { try { b.proc.kill(); } catch { /* ignore */ } }
  }
  const bin = findBrowser(ctx);
  if (!bin) { notifyNoBrowser(ctx); throw new Error('no Chrome/Chromium found'); }
  const port = await freePort(Number(ctx.config.browserCdpPort) || 0);
  const profile = path.join(ctx.stateDir, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic',
    '--window-size=1280,860',
    `--app=http://127.0.0.1:${state.staticPort}/EditHere.html`,
  ];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  ctx.log.info(`starting EditHere window with ${bin} (devtools 127.0.0.1:${port})`);
  const logFd = fs.openSync(path.join(ctx.stateDir, 'browser.log'), 'a');
  const proc = spawn(bin, args, { stdio: ['ignore', logFd, logFd], env: process.env });
  fs.closeSync(logFd);
  proc.on('exit', (code) => {
    ctx.log.info(`EditHere window closed (code ${code})`);
    if (state.browser?.proc === proc) { state.browser.conn?.close(); state.browser = null; }
  });
  const ver = await waitForDevtools(port, 20000);
  state.browser = { proc, port, conn: await new CdpConnection(ver.webSocketDebuggerUrl).connect() };
  return state.browser;
}

async function editorSession(b) {
  const want = `127.0.0.1:${state.staticPort}/EditHere.html`;
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await b.conn.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'page' && x.url.includes(want));
    if (t) {
      const { sessionId } = await b.conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      return { sessionId, targetId: t.targetId };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // window exists but the editor tab is gone: open a fresh one
  const { targetId } = await b.conn.send('Target.createTarget', { url: `http://${want}` });
  const { sessionId } = await b.conn.send('Target.attachToTarget', { targetId, flatten: true });
  return { sessionId, targetId };
}

async function openInEditor(ctx, dataUrl, name) {
  const b = await ensureBrowser(ctx);
  let { sessionId, targetId } = await editorSession(b);
  const ready = `new Promise((res) => { const t0 = Date.now(); (function poll() {
    if (document.readyState === 'complete' && window.EditHereWeb) return res(true);
    if (Date.now() - t0 > 15000) return res(false); setTimeout(poll, 100); })(); })`;
  if (!(await evaluate(b.conn, sessionId, ready, { awaitPromise: true }))) throw new Error('EditHere page did not become ready');
  // EditHere accepts one image per page; reload the editor when it already holds one.
  const busy = await evaluate(b.conn, sessionId, `!document.getElementById('workspace')?.hidden`);
  if (busy) {
    await b.conn.send('Page.enable', {}, sessionId);
    await b.conn.send('Page.reload', { ignoreCache: true }, sessionId);
    await new Promise((r) => setTimeout(r, 500));
    if (!(await evaluate(b.conn, sessionId, ready, { awaitPromise: true }))) throw new Error('EditHere reload failed');
  }
  await evaluate(b.conn, sessionId,
    `EditHereWeb.loadAgentImage({ image: ${JSON.stringify(dataUrl)}, name: ${JSON.stringify(name)} }).then(() => true)`,
    { awaitPromise: true, timeoutMs: 60000 });
  await b.conn.send('Target.activateTarget', { targetId }).catch(() => {});
}

function stamp() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

async function handleOpen(ctx, sessionId, d) {
  const nw = Number(d?.naturalWidth) || 0;
  const nh = Number(d?.naturalHeight) || 0;
  ctx.log.info(`open request src=${d?.srcIsData ? 'data:' : ctx.safeUrl(String(d?.src || ''))} natural=${nw}x${nh}`);
  const { method, buf, tried } = await captureImage(ctx, sessionId, d || {});
  const info = imageInfo(buf);
  const match = info.w === nw && info.h === nh && nw > 0;
  const ext = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', bmp: 'bmp' }[info.fmt] || 'png';
  const name = `grok-image-${stamp()}.${ext}`;
  let saved = '';
  if (ctx.config.saveImages !== false) {
    const dir = path.join(ctx.stateDir, 'images');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    saved = path.join(dir, name);
    fs.writeFileSync(saved, buf, { mode: 0o600 });
  }
  ctx.log.info(`captured via ${method} ${info.fmt} ${info.w}x${info.h} bytes=${buf.length} matchesNatural=${match} tried=[${tried.join(', ')}]${saved ? ` saved=${saved}` : ''}`);
  if (!info.mime || !/^image\/(png|jpeg|webp|bmp|gif)$/.test(info.mime)) throw new Error(`unsupported image format ${info.fmt}`);
  await openInEditor(ctx, `data:${info.mime};base64,${buf.toString('base64')}`, name);
  ctx.log.info('image loaded into EditHere');
}

export default {
  name: 'edithere',
  messageTypes: ['open'],
  pageScript: 'inject.js',

  async init(ctx) {
    if (!fs.existsSync(path.join(ctx.featureDir, 'vendor', 'EditHere.html'))) throw new Error('vendor/EditHere.html missing');
    const port = await startStatic(ctx);
    ctx.log.info(`EditHere page served on http://127.0.0.1:${port}/EditHere.html`);
  },

  async onAttach(ctx, { sessionId }) {
    await ctx.cdp('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 }, sessionId);
  },

  onDetach(ctx, { sessionId }) {
    for (const k of state.responses.keys()) if (k.startsWith(`${sessionId}\n`)) state.responses.delete(k);
  },

  onCdpEvent(ctx, m) {
    if (m.method !== 'Network.responseReceived' || !m.sessionId) return;
    const { requestId, response, type } = m.params || {};
    if (type !== 'Image' || !response?.url || response.url.startsWith('data:')) return;
    state.responses.set(`${m.sessionId}\n${response.url}`, { requestId, mimeType: response.mimeType });
    if (state.responses.size > 500) state.responses.delete(state.responses.keys().next().value);
  },

  onMessage(ctx, { sessionId, type, data }) {
    if (type !== 'open') return;
    // serialize clicks so the single editor window is reused cleanly
    state.queue = state.queue.then(() => handleOpen(ctx, sessionId, data)).catch((e) => {
      ctx.log.error(`open failed: ${e.message}${e.tried ? ` tried=[${e.tried.join(', ')}]` : ''}`);
    });
    return state.queue;
  },

  async shutdown() {
    state.server?.close();
    if (state.browser) {
      state.browser.conn?.close();
      try { state.browser.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  },
};
