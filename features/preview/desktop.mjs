// features/preview: 经用户允许，在 Grok Bot 渲染进程里取消息附件 zip。纯函数（evaluate 脚本、
// 媒体令牌、分块拼接、返回值解析、下载目录回扫），没有 Electron 依赖，测试用 mock evaluate 直接跑。
//
// 1.0.1 核对过的事实：
// - 无弹窗路径：页面 fetch sand-media://attachment/<encodeURIComponent(path)>?account=<token>
//   （官方媒体协议；主进程再走内部分块读取，没有预览类型门禁）。按 4MB Range 拉取，
//   主进程拼接。不抢 coordinatorPort，不走隐藏世界 ipcRenderer，不伪造扩展名。
// - 媒体令牌 = sha256("sand-media\0" + slot + "\0" + generation).digest("base64url").slice(0,22)
// - desktop.readAttachmentBytes 对 zip 因预览类型门禁返回 null，保留作后备。
// - desktop.downloadAttachment 一定弹系统保存框，只返回 true/false；再后备。
// - viewSlot 取 SandClient.accountSlot（只读 FIND_CLIENT_CTX）。
// zip 字节不经过 64KB 的 binding。令牌和完整路径不写进日志。
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadCandidates } from '../../electron/preview-core.mjs';

export const PREVIEW_BYTE_CAP = 25 * 1024 * 1024; // ATTACHMENT_PREVIEW_BYTE_CAP（readAttachmentBytes 的上限，分块流不用这个）
export const RANGE_CHUNK = 4 * 1024 * 1024; // 官方媒体流分块大小
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 等用户在保存框里操作
export const RESCAN_WINDOW_MS = 3 * 60 * 1000;

/**
 * 在页面里找：被点的「打开预览」按钮 → 它前面的附件卡 → 沿 React fiber 往上，
 * 拿最近的 agentId（可选）和 SandClientProvider value 上的 accountSlot。
 * 只读，不写任何 React 状态。返回 { hasSlot, viewSlot, agentId }。
 */
export const FIND_CLIENT_CTX = `function(reqId){
  var btn = null;
  try { if (reqId) btn = document.querySelector('[data-gx-preview-req="' + CSS.escape(reqId) + '"]'); } catch (e) {}
  var el = (btn && btn.previousElementSibling) || document.querySelector('article.sand-file-card, [data-attachment-card]') || document.body;
  function fiberOf(n) { if (!n) return null; for (var k in n) { if (k.indexOf('__reactFiber$') === 0) return n[k]; } return null; }
  var f = fiberOf(el);
  if (!f && el) { var all = el.querySelectorAll('*'); for (var i = 0; i < all.length && !f; i++) f = fiberOf(all[i]); }
  var out = { hasSlot: false, viewSlot: null, agentId: '' };
  for (var depth = 0; f && depth < 3000; depth++, f = f.return) {
    var p = f.memoizedProps;
    if (!p || typeof p !== 'object') continue;
    if (!out.agentId) {
      if (typeof p.agentId === 'string' && p.agentId) out.agentId = p.agentId;
      else if (p.entry && typeof p.entry === 'object' && typeof p.entry.agentId === 'string' && p.entry.agentId) out.agentId = p.entry.agentId;
    }
    var v = p.value;
    if (v && typeof v === 'object' && v.desktop && ('accountSlot' in v)) {
      var s = v.accountSlot;
      out.hasSlot = true;
      out.viewSlot = (typeof s === 'string' || typeof s === 'number') ? s : null;
      break;
    }
  }
  return out;
}`;

/** Runtime.evaluate 表达式：调用 desktop.readAttachmentBytes，bytes 在页面里转 base64 再回传。 */
export function readBytesExpr({ reqId = '', path: p, maxBytes = PREVIEW_BYTE_CAP, knownSize = 0 }) {
  const args = JSON.stringify({ path: String(p), maxBytes: Math.min(Number(maxBytes) || PREVIEW_BYTE_CAP, PREVIEW_BYTE_CAP), knownSize: Number(knownSize) || 0 });
  return `(async function(){
  var D = window.desktop;
  if (!D || typeof D.readAttachmentBytes !== 'function') return { kind: 'unavailable' };
  var c = (${FIND_CLIENT_CTX})(${JSON.stringify(String(reqId))});
  var a = ${args};
  if (!a.knownSize) delete a.knownSize;
  if (c.agentId) a.agentId = c.agentId;
  if (c.hasSlot) a.viewSlot = c.viewSlot;
  var r;
  try { r = await D.readAttachmentBytes(a); }
  catch (e) { return { kind: 'error', error: String((e && (e.code || (e.failure && e.failure.code) || e.message)) || e).slice(0, 200), slot: c.hasSlot }; }
  if (r == null) return { kind: 'none', slot: c.hasSlot };
  if (r.kind === 'too-large') return { kind: 'too-large', size: Number(r.size) || 0 };
  if (r.kind === 'bytes' && r.bytes) {
    var u = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
    var parts = [];
    for (var i = 0; i < u.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)));
    return { kind: 'bytes', base64: btoa(parts.join('')), size: u.length, resolvedName: typeof r.resolvedName === 'string' ? r.resolvedName.slice(0, 255) : '' };
  }
  return { kind: 'unknown', got: String(r && r.kind).slice(0, 40) };
})()`;
}

/** Runtime.evaluate 表达式：调用 desktop.downloadAttachment（会弹系统保存框）。 */
export function downloadExpr({ path: p, suggestedName }) {
  const args = JSON.stringify({ path: String(p), suggestedName: String(suggestedName || '') });
  return `(async function(){
  var D = window.desktop;
  if (!D || typeof D.downloadAttachment !== 'function') return { kind: 'unavailable' };
  var r;
  try { r = await D.downloadAttachment(${args}); }
  catch (e) { return { kind: 'error', error: String((e && (e.code || e.message)) || e).slice(0, 200) }; }
  return r === true ? { kind: 'saved' } : r === false ? { kind: 'cancelled' } : { kind: 'unknown', got: typeof r };
})()`;
}

/** 解析 Runtime.evaluate 的整个返回（含 exceptionDetails）。 */
export function evalValue(r) {
  if (!r || typeof r !== 'object') throw new Error('empty evaluate result');
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate threw').split('\n')[0].slice(0, 200));
  return r.result?.value;
}

/** readBytesExpr 的值 → { kind:'bytes', buffer } | { kind:'too-large', size } | { kind:'none'|'unavailable'|'error'|'unknown', ... } */
export function parseReadResult(v) {
  if (!v || typeof v !== 'object') return { kind: 'unknown' };
  if (v.kind === 'bytes') {
    if (typeof v.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.base64)) return { kind: 'error', error: 'bad base64' };
    const buffer = Buffer.from(v.base64, 'base64');
    if (Number.isFinite(v.size) && v.size !== buffer.length) return { kind: 'error', error: 'size mismatch' };
    return { kind: 'bytes', buffer, resolvedName: v.resolvedName || '' };
  }
  if (v.kind === 'too-large') return { kind: 'too-large', size: Number(v.size) || 0 };
  if (['none', 'unavailable', 'error', 'unknown'].includes(v.kind)) return { ...v };
  return { kind: 'unknown' };
}


// ---------- 官方媒体协议（无弹窗分块读取） ----------

/** 与官方一致：sha256("sand-media\0" + slot + "\0" + generation) 的 base64url 前 22 位。 */
export function mediaAccountToken(slot, generation = 0) {
  return crypto.createHash('sha256')
    .update(`sand-media\0${slot}\0${generation}`, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

/** sand-media://attachment/<encodeURIComponent(path)>，有令牌时加 ?account=（令牌本身已是 url-safe，不再编码）。 */
export function attachmentUrl(filePath, token) {
  const base = `sand-media://attachment/${encodeURIComponent(String(filePath))}`;
  return token == null || token === '' ? base : `${base}?account=${token}`;
}

/**
 * 令牌候选：先用页面里已有的 sand-media:// URL 刮到的 ?account=，
 * 再按当前账号槽计算 generation 0/1/2，最后试一次无令牌。去重，顺序保留。
 */
export function tokenCandidates({ scraped = [], slot, generations = [0, 1, 2] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (t == null || t === '') return;
    const k = String(t);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const t of scraped) {
    if (typeof t === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(t)) push(t);
  }
  if (slot != null && String(slot) !== '') {
    for (const g of generations) push(mediaAccountToken(slot, g));
  }
  out.push(null);
  return out;
}

/** Runtime.evaluate：从 img/video/src/href 等已有 sand-media:// URL 刮 ?account=。 */
export const SCRAPE_TOKENS = `(function(){ /* gx-scrape-tokens */
  var out = [], seen = Object.create(null);
  function add(u) {
    if (typeof u !== 'string' || u.indexOf('sand-media:') !== 0) return;
    try {
      var t = new URL(u).searchParams.get('account');
      if (t && !seen[t] && /^[A-Za-z0-9_-]{16,32}$/.test(t)) { seen[t] = 1; out.push(t); }
    } catch (e) {}
  }
  try {
    var nodes = document.querySelectorAll('img,video,audio,source,a,link,[src],[href]');
    for (var i = 0; i < nodes.length && out.length < 8; i++) {
      var el = nodes[i];
      add(el.currentSrc); add(el.src); add(el.href);
      var ss = el.srcset || (el.getAttribute && el.getAttribute('srcset'));
      if (ss) {
        var parts = String(ss).split(',');
        for (var j = 0; j < parts.length; j++) add(parts[j].trim().split(/\s+/)[0]);
      }
    }
  } catch (e) {}
  return out;
})()`;

export function clientCtxExpr(reqId = '') {
  return `(${FIND_CLIENT_CTX})(${JSON.stringify(String(reqId || ''))})`;
}

/** Runtime.evaluate：按 Range 拉取一块，bytes 在页面里转 base64。 */
export function rangeFetchExpr({ path: p, token, start, end }) {
  const url = JSON.stringify(attachmentUrl(p, token));
  const range = JSON.stringify(`bytes=${Number(start) || 0}-${Number(end) || 0}`);
  const off = Number(start) || 0;
  return `(async function(){ /* gx-range-fetch */
  if (typeof fetch !== 'function') return { kind: 'unavailable' };
  var res;
  try { res = await fetch(${url}, { headers: { Range: ${range} } }); }
  catch (e) { return { kind: 'error', error: String((e && e.message) || e).slice(0, 200) }; }
  if (res.status === 404) return { kind: 'not-found', status: 404 };
  if (res.status !== 200 && res.status !== 206) return { kind: 'http', status: res.status };
  var buf;
  try { buf = new Uint8Array(await res.arrayBuffer()); }
  catch (e) { return { kind: 'error', error: String((e && e.message) || e).slice(0, 200) }; }
  var cr = res.headers.get('content-range') || '';
  var m = new RegExp('^bytes (\\\\d+)-(\\\\d+)/(\\\\d+)$').exec(cr);
  var total = m ? Number(m[3]) : (Number(res.headers.get('content-length')) || buf.length);
  var offset = m ? Number(m[1]) : ${off};
  var parts = [];
  for (var i = 0; i < buf.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)));
  return { kind: 'bytes', base64: btoa(parts.join('')), size: buf.length, totalSize: total, offset: offset };
})()`;
}

export function parseRangeResult(v) {
  if (!v || typeof v !== 'object') return { kind: 'unknown' };
  if (v.kind === 'bytes') {
    if (typeof v.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.base64)) return { kind: 'error', error: 'bad base64' };
    const buffer = Buffer.from(v.base64, 'base64');
    if (Number.isFinite(v.size) && v.size !== buffer.length) return { kind: 'error', error: 'size mismatch' };
    return {
      kind: 'bytes',
      buffer,
      size: buffer.length,
      totalSize: Number(v.totalSize) || 0,
      offset: Number(v.offset) || 0,
    };
  }
  if (v.kind === 'not-found') return { kind: 'not-found', status: 404 };
  if (v.kind === 'http') return { kind: 'http', status: Number(v.status) || 0 };
  if (['unavailable', 'error', 'unknown'].includes(v.kind)) return { ...v };
  return { kind: 'unknown' };
}

/**
 * 用候选令牌拉第一块：404 换下一个，成功后锁定该令牌再按 4MB 续拉，在本进程拼接。
 * 超过 maxBytes 抛 too-large；全部令牌失败返回 null。
 */
export async function fetchAttachmentChunks({
  evaluate, path: p, tokens, maxBytes, chunkSize = RANGE_CHUNK, evalTimeoutMs = 60000,
} = {}) {
  const cap = Number(maxBytes) || 0;
  if (!p || !Array.isArray(tokens) || !tokens.length || cap <= 0) return null;
  const once = async (token, start, end) => parseRangeResult(
    evalValue(await evaluate(rangeFetchExpr({ path: p, token, start, end }), evalTimeoutMs)),
  );
  let locked;
  let first = null;
  for (const token of tokens) {
    const r = await once(token, 0, chunkSize - 1);
    if (r.kind === 'unavailable') return null;
    if (r.kind === 'not-found' || (r.kind === 'http' && r.status === 404)) continue;
    if (r.kind === 'bytes') { first = r; locked = token; break; }
    // 其他错误也换令牌再试
  }
  if (!first) return null;
  if (!first.totalSize) throw new Error('no total size');
  if (first.totalSize > cap) throw new Error('too-large');
  if (first.offset !== 0) throw new Error('unexpected offset');
  const parts = [first.buffer];
  let have = first.buffer.length;
  while (have < first.totalSize) {
    if (have >= cap) throw new Error('too-large');
    const end = Math.min(have + chunkSize, first.totalSize) - 1;
    const r = await once(locked, have, end);
    if (r.kind !== 'bytes') throw new Error(r.error || r.kind || 'chunk failed');
    if (r.offset !== have) throw new Error('unexpected offset');
    if (r.totalSize !== first.totalSize) throw new Error('total size changed');
    if (!r.buffer.length) throw new Error('empty chunk');
    parts.push(r.buffer);
    have += r.buffer.length;
  }
  const out = Buffer.concat(parts);
  if (out.length !== first.totalSize) throw new Error('size mismatch');
  return out;
}

/**
 * 像官方附件路径：POSIX 绝对路径、Windows 盘符路径或 file://（eM() 只认这几种）。
 * https / sand-media / blob 等返回 false。
 */
export function looksLikeAttachmentPath(source) {
  const s = String(source || '');
  if (!s) return false;
  if (/^file:\/\//i.test(s)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  return s.startsWith('/');
}

/** file:// → 本地路径，其余原样。 */
export function localPathOf(source) {
  const s = String(source || '');
  if (/^file:\/\//i.test(s)) { try { return fileURLToPath(s); } catch { return ''; } }
  return s;
}

/**
 * downloadAttachment 返回 true 后回扫「下载」目录：同名（含 "name (n).zip"）、
 * mtime 不早于发起下载前 5 秒、且在 windowMs 内。返回 { path, size, mtimeMs } 或 null。
 */
export function rescanDownloads(dir, name, { since, now = Date.now(), windowMs = RESCAN_WINDOW_MS, stat } = {}) {
  let best = null;
  for (const p of downloadCandidates(dir, name)) {
    let st;
    try { st = stat(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (since && st.mtimeMs < since - 5000) continue;
    if (now - st.mtimeMs > windowMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, size: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

/** 日志里不留完整路径。 */
export function scrub(msg) {
  return String(msg || '')
    .replace(/account=[A-Za-z0-9_-]+/g, 'account=…')
    .replace(/(?:[a-zA-Z]:)?[\\/][^\s'"]+/g, '…')
    .slice(0, 200);
}

/** 用户在系统保存框里点了取消：整条来源链停下，不再弹我们的文件选择框。 */
export function cancelledError() {
  const e = new Error('用户取消');
  e.abort = true;
  return e;
}

/**
 * 来源：desktop-chunk（无弹窗）、desktop-read、desktop-download（弹保存框，后备）。
 * deps 由 feature.mjs 注入，测试里换成 mock。
 *   deps.evaluate(expr, timeoutMs) → Runtime.evaluate 的原始返回
 *   deps.exists(p) / deps.stat(p) / deps.readFile(p) / deps.downloadsDir() / deps.now() / deps.log
 */
export function desktopSources(deps) {
  const log = deps.log || { info() {}, warn() {} };
  const now = deps.now || Date.now;
  return [
    {
      name: 'desktop-chunk',
      fetch: async ({ source, reqId }) => {
        if (!looksLikeAttachmentPath(source)) return null;
        let slot = null;
        try {
          const ctx = evalValue(await deps.evaluate(clientCtxExpr(reqId), 15000));
          if (ctx && ctx.hasSlot && ctx.viewSlot != null && ctx.viewSlot !== '') slot = ctx.viewSlot;
        } catch (e) { log.warn(`desktop-chunk: slot ${scrub(e.message)}`); }
        let scraped = [];
        try {
          const v = evalValue(await deps.evaluate(SCRAPE_TOKENS, 15000));
          if (Array.isArray(v)) scraped = v;
        } catch (e) { log.warn(`desktop-chunk: scrape ${scrub(e.message)}`); }
        const tokens = tokenCandidates({ scraped, slot });
        try {
          const buf = await fetchAttachmentChunks({
            evaluate: deps.evaluate,
            path: source,
            tokens,
            maxBytes: deps.maxBytes,
          });
          if (buf) log.info(`desktop-chunk: got ${buf.length} bytes`);
          return buf;
        } catch (e) {
          log.warn(`desktop-chunk: ${scrub(e.message)}`);
          throw e;
        }
      },
    },
    {
      name: 'desktop-read',
      fetch: async ({ source, reqId }) => {
        if (!looksLikeAttachmentPath(source)) return null;
        const v = evalValue(await deps.evaluate(readBytesExpr({ reqId, path: source, maxBytes: deps.maxBytes }), 60000));
        const r = parseReadResult(v);
        if (r.kind === 'bytes') return r.buffer;
        if (r.kind === 'too-large') { log.info(`desktop-read: too-large (${r.size} bytes), trying download`); return null; }
        if (r.kind === 'error') { log.warn(`desktop-read: ${scrub(r.error)}`); return null; }
        if (r.kind === 'none') log.info(`desktop-read: null (zip is not a preview kind; viewSlot ${r.slot ? 'found' : 'not found'})`);
        return null;
      },
    },
    {
      name: 'desktop-download',
      fetch: async ({ source, name }) => {
        if (!looksLikeAttachmentPath(source)) return null;
        const local = localPathOf(source);
        if (local && deps.exists(local)) return null; // 本机已有，交给 local-path（已在前面）
        const since = now();
        const v = evalValue(await deps.evaluate(downloadExpr({ path: source, suggestedName: path.basename(name) }), DOWNLOAD_TIMEOUT_MS));
        if (!v || v.kind === 'unavailable') return null;
        if (v.kind === 'cancelled') throw cancelledError();
        if (v.kind !== 'saved') { log.warn(`desktop-download: ${v.kind}${v.error ? ` ${scrub(v.error)}` : ''}`); return null; }
        const hit = rescanDownloads(deps.downloadsDir(), name, { since, now: now(), stat: deps.stat });
        if (!hit) { log.info('desktop-download: saved, but not found in Downloads; falling back'); return null; }
        log.info(`desktop-download: saved and found ${path.basename(hit.path)} (${hit.size} bytes)`);
        return deps.readFile(hit.path);
      },
    },
  ];
}
