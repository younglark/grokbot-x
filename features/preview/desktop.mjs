// features/preview: 经用户允许，调用 Grok Bot 渲染进程里官方 preload 暴露的 window.desktop.*
// 取消息附件 zip。纯函数（evaluate 脚本生成、返回值解析、下载目录回扫），没有 Electron 依赖，
// tests/preview.test.mjs 用 mock CDP / desktop 直接测。
//
// 1.0.1 解包代码里的事实：
// - desktop.readAttachmentBytes({path,maxBytes?,agentId?,knownSize?,viewSlot?}) →
//   {kind:'bytes',bytes,size,resolvedName?} | {kind:'too-large',size} | null。
//   对 .zip 会因预览类型门禁（getFilePreviewKind=unknown）直接返回 null；我们不伪造扩展名。
// - desktop.downloadAttachment({path,suggestedName}) 一定弹系统保存框，只返回 true/false，不返回路径。
// - viewSlot 必须是当前账号槽：官方 UI 传 SandClient.accountSlot（SandClientProvider 的 value 上的 getter）。
// 不调 readAttachmentChunk 或其他未暴露的内部 IPC；zip 字节不经过 64KB 的 binding。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadCandidates } from '../../electron/preview-core.mjs';

export const PREVIEW_BYTE_CAP = 25 * 1024 * 1024; // ATTACHMENT_PREVIEW_BYTE_CAP
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
  return String(msg || '').replace(/(?:[a-zA-Z]:)?[\\/][^\s'"]+/g, '…').slice(0, 200);
}

/** 用户在系统保存框里点了取消：整条来源链停下，不再弹我们的文件选择框。 */
export function cancelledError() {
  const e = new Error('用户取消');
  e.abort = true;
  return e;
}

/**
 * 两个来源：desktop-read、desktop-download。deps 由 feature.mjs 注入（真实 CDP / fs / 下载目录），
 * 测试里换成 mock。
 *   deps.evaluate(expr, timeoutMs) → Runtime.evaluate 的原始返回
 *   deps.exists(p) / deps.stat(p) / deps.readFile(p) / deps.downloadsDir() / deps.now() / deps.log
 */
export function desktopSources(deps) {
  const log = deps.log || { info() {}, warn() {} };
  const now = deps.now || Date.now;
  return [
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
