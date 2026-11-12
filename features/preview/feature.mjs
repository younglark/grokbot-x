// features/preview: 交互预览验收。页面脚本在附件卡旁加「打开预览」；点击后在这里
// 尽力拿到 zip 实体，交给 electron/preview.mjs 在隔离窗口打开。反馈只进剪贴板，不自动发送。
//
// 取 zip 的顺序（详见 README）：
//   1. 外部注册的取文件 hook（registerZipSource）
//   2. local-path：卡片里带的路径就是本机已存在的 .zip（例如输入框里刚附上的本地文件）
//   3. desktop-read：官方 window.desktop.readAttachmentBytes（用户已允许；zip 预期因预览类型门禁返回 null）
//   4. desktop-download：官方 window.desktop.downloadAttachment，弹一次系统保存框；保存后回扫「下载」目录。
//      用户取消 → 整条链停下，不再弹我们的文件选择框
//   5. cdp-resource / cdp-network：附件来源是 URL 且渲染进程已经加载过（资源缓存 / 网络响应体）
//   6. https-fetch：公开 https 地址，不带任何凭据
//   7. downloads：「下载」目录里 30 分钟内的同名文件
//   8. pick-file：弹出文件选择框，默认定位到 下载目录/<name>，由用户确认
// 只走 window.desktop 这个官方 preload 面；不调 readAttachmentChunk 等内部 IPC 或后端 RPC，不读 cookie/令牌。
import fs from 'node:fs';
import path from 'node:path';
import { openPreviewZip, pickZipFile, downloadsDir, previewLimits, notifyPreview } from '../../electron/preview.mjs';
import { resolveZip, downloadCandidates, newestRecent, sizeMatches, normalizeRequest } from '../../electron/preview-core.mjs';
import { desktopSources } from './desktop.mjs';

const state = {
  responses: new Map(), // sessionId\nurl -> requestId（只记 zip 响应）
  queue: Promise.resolve(),
  hooks: [],
};

/** 给以后的取文件通道留的 hook：fn({ name, source, sessionId, ctx }) → Buffer | null。 */
export function registerZipSource(name, fn) {
  if (typeof fn !== 'function') throw new TypeError('zip source must be a function');
  state.hooks.push({ name: `hook:${String(name || 'custom').slice(0, 40)}`, fetch: fn });
  return () => { state.hooks = state.hooks.filter((h) => h.fetch !== fn); };
}

const URL_SRC = /^(https?|sand-media|blob):/i;

function bufFrom(r, field) {
  return r[field] == null ? null : r.base64Encoded ? Buffer.from(r[field], 'base64') : Buffer.from(r[field], 'latin1');
}

export function buildSources(ctx, sessionId, deps = {}) {
  const max = previewLimits().maxZipBytes;
  const dl = deps.downloadsDir ?? downloadsDir;
  const pick = deps.pickZipFile ?? pickZipFile;
  const readFile = (p) => {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > max) throw new Error('too-large');
    return fs.readFileSync(p);
  };
  return [
    ...state.hooks.map((h) => ({ name: h.name, fetch: (req) => h.fetch({ ...req, sessionId, ctx }) })),
    {
      name: 'local-path',
      fetch: ({ source }) => {
        if (!source || URL_SRC.test(source) || !path.isAbsolute(source) || !/\.zip$/i.test(source)) return null;
        return fs.existsSync(source) ? readFile(source) : null;
      },
    },
    ...(deps.desktop === false || !sessionId ? [] : desktopSources({
      evaluate: (expression, timeoutMs) => ctx.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs),
      exists: (p) => fs.existsSync(p),
      stat: (p) => fs.statSync(p),
      readFile,
      downloadsDir: dl,
      maxBytes: max,
      log: ctx.log,
    })),
    {
      name: 'cdp-resource',
      fetch: async ({ source }) => {
        if (!source || !URL_SRC.test(source) || !sessionId) return null;
        const { frameTree } = await ctx.cdp('Page.getFrameTree', {}, sessionId);
        const frames = [];
        (function walk(n) { frames.push(n.frame.id); (n.childFrames || []).forEach(walk); })(frameTree);
        for (const frameId of frames) {
          try {
            const buf = bufFrom(await ctx.cdp('Page.getResourceContent', { frameId, url: source }, sessionId, 30000), 'content');
            if (buf?.length) return buf;
          } catch { /* not in this frame */ }
        }
        return null;
      },
    },
    {
      name: 'cdp-network',
      fetch: async ({ source }) => {
        const hit = source && sessionId && state.responses.get(`${sessionId}\n${source}`);
        if (!hit) return null;
        return bufFrom(await ctx.cdp('Network.getResponseBody', { requestId: hit }, sessionId, 30000), 'body');
      },
    },
    {
      name: 'https-fetch',
      fetch: async ({ source }) => {
        if (!/^https:/i.test(source || '')) return null;
        const r = await fetch(source, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const len = Number(r.headers.get('content-length')) || 0;
        if (len > max) throw new Error('too-large');
        return Buffer.from(await r.arrayBuffer());
      },
    },
    {
      name: 'downloads',
      fetch: ({ name, sizeHint }) => {
        const best = newestRecent(downloadCandidates(dl(), name));
        if (!best) return null;
        if (!sizeMatches(best.size, sizeHint)) throw new Error('size-mismatch');
        return readFile(best.path);
      },
    },
    {
      name: 'pick-file',
      fetch: async ({ name }) => {
        const p = await pick(name);
        if (!p) throw new Error('用户取消');
        return readFile(p);
      },
    },
  ];
}

function describeSource(ctx, s) {
  if (!s) return '(none)';
  return URL_SRC.test(s) ? ctx.safeUrl(s) : `path:…/${path.basename(s)}`;
}

async function handleOpen(ctx, sessionId, data) {
  const req = normalizeRequest(data);
  ctx.log.info(`open request ${req.name} origin=${req.origin} source=${describeSource(ctx, req.source)}`);
  let got;
  try {
    got = await resolveZip(req, buildSources(ctx, sessionId), { maxBytes: previewLimits().maxZipBytes });
  } catch (e) {
    ctx.log.warn(`no zip for ${req.name}: tried=[${(e.tried || []).join(', ')}]`);
    throw e;
  }
  ctx.log.info(`got ${req.name} via ${got.method} (${got.buffer.length} bytes) tried=[${got.tried.join(', ')}]`);
  await openPreviewZip({ buffer: got.buffer, name: req.name, source: got.method });
}

export default {
  name: 'preview',
  messageTypes: ['open'],
  pageScript: 'inject.js',

  async init(ctx) {
    ctx.log.info('交互预览验收: isolated BrowserWindow + 127.0.0.1 server, feedback → clipboard only');
  },

  async onAttach(ctx, { sessionId }) {
    // 和 edithere 相同的缓冲设置；只为在用户点击时能取回已加载过的 zip 响应体
    await ctx.cdp('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 }, sessionId);
  },

  onDetach(ctx, { sessionId }) {
    for (const k of state.responses.keys()) if (k.startsWith(`${sessionId}\n`)) state.responses.delete(k);
  },

  onCdpEvent(ctx, m) {
    if (m.method !== 'Network.responseReceived' || !m.sessionId) return;
    const { requestId, response } = m.params || {};
    const url = response?.url || '';
    if (!url || url.startsWith('data:')) return;
    const isZip = /zip/i.test(response.mimeType || '') || /\.zip(?:$|[?#])/i.test(url);
    if (!isZip) return;
    state.responses.set(`${m.sessionId}\n${url}`, requestId);
    if (state.responses.size > 200) state.responses.delete(state.responses.keys().next().value);
  },

  onMessage(ctx, { sessionId, type, data }) {
    if (type !== 'open') return;
    state.queue = state.queue.then(() => handleOpen(ctx, sessionId, data)).catch((e) => {
      ctx.log.error(`open failed: ${e.message}`);
      try {
        // 失败才提示；用户取消选择不打扰
        if (!/用户取消/.test((e.tried || []).join(' ') + e.message)) notifyPreview('交互预览验收', `打不开预览：${e.message}`, true);
      } catch { /* ignore */ }
    });
    return state.queue;
  },
};
