// 交互预览验收（features/preview）的纯 Node 部分：解压、review.json、桥接注入、
// 本地 HTTP 服务、反馈落盘。没有 Electron 依赖，tests/preview.test.mjs 直接测这些函数。
//
// 约定：页面自己渲染反馈 UI；这里只下发 zip 里的文件，并在 entry HTML 下发时临时
// 插入一小段桥接脚本（window.__grokbotXPreview）。zip 本身从不被修改。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const LIMITS = Object.freeze({
  maxZipBytes: 50 * 1024 * 1024, // 压缩包本身
  maxUnpackedBytes: 200 * 1024 * 1024, // 解压后合计
  maxEntryBytes: 100 * 1024 * 1024, // 单个文件
  maxEntries: 2000,
  maxFeedbackJsonChars: 2 * 1024 * 1024,
  maxFeedbackFiles: 20,
  maxFeedbackFileBytes: 25 * 1024 * 1024,
  maxFeedbackTotalBytes: 100 * 1024 * 1024,
  clipboardMaxBytes: 50 * 1024 * 1024, // 超过就只把反馈目录路径放进剪贴板
});

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

// ---------- 路径安全 ----------

/**
 * 把 zip 里的条目名规范成安全的相对路径（'/' 分隔）。不安全就返回 ''。
 * 拒绝：绝对路径、盘符、'..'、NUL/控制字符、空段。
 */
export function safeEntryName(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  if (/[\u0000-\u001f]/.test(raw)) return '';
  const s = raw.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return '';
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return '';
    parts.push(seg);
  }
  return parts.join('/');
}

/** root 下的 rel 绝对路径；跑出 root 就返回 ''。 */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const safe = safeEntryName(rel);
  if (!safe) return '';
  const abs = path.resolve(base, ...safe.split('/'));
  return abs.startsWith(base + path.sep) ? abs : '';
}

// ---------- zip 读取（只支持 stored/deflate，拒绝加密、ZIP64、符号链接） ----------

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 解析中央目录，返回条目元数据（不解压）。任何不安全条目都会让整个包被拒绝。 */
export function listZip(buf, limits = LIMITS) {
  if (!Buffer.isBuffer(buf)) throw new Error('zip 不是 Buffer');
  if (buf.length > limits.maxZipBytes) throw new Error(`压缩包超过上限 ${limits.maxZipBytes} 字节`);
  if (buf.length < 22) throw new Error('不是有效的 zip');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('不支持 ZIP64');
  if (count > limits.maxEntries) throw new Error(`条目数超过上限 ${limits.maxEntries}`);
  if (cdOff + cdSize > eocd) throw new Error('zip 目录越界');
  const entries = [];
  const seen = new Set();
  let total = 0;
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new Error('zip 目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const ext = buf.readUInt32LE(p + 38);
    const loc = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff || loc === 0xffffffff) throw new Error('不支持 ZIP64');
    if (flags & 0x1) throw new Error(`不支持加密条目：${rawName.slice(0, 80)}`);
    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
    const name = safeEntryName(rawName);
    if (!name) {
      if (isDir && /^[./\\]*$/.test(rawName)) continue; // "./" 之类的根目录条目
      throw new Error(`不安全的路径：${rawName.slice(0, 120)}`);
    }
    const mode = (ext >>> 16) & 0o170000;
    if (madeBy === 3 && mode === 0o120000) throw new Error(`不支持符号链接：${name}`);
    if (isDir) { entries.push({ name, dir: true }); continue; }
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}：${name}`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`重复条目：${name}`);
    seen.add(key);
    if (usize > limits.maxEntryBytes) throw new Error(`文件过大：${name}`);
    total += usize;
    if (total > limits.maxUnpackedBytes) throw new Error(`解压后超过上限 ${limits.maxUnpackedBytes} 字节`);
    entries.push({ name, dir: false, method, crc, csize, usize, loc });
  }
  return entries;
}

function entryData(buf, e) {
  if (e.loc + 30 > buf.length || buf.readUInt32LE(e.loc) !== SIG_LOC) throw new Error(`本地头损坏：${e.name}`);
  const start = e.loc + 30 + buf.readUInt16LE(e.loc + 26) + buf.readUInt16LE(e.loc + 28);
  const end = start + e.csize;
  if (end > buf.length) throw new Error(`数据越界：${e.name}`);
  const raw = buf.subarray(start, end);
  let out;
  if (e.method === 0) out = raw;
  else if (e.usize === 0) out = Buffer.alloc(0);
  else out = zlib.inflateRawSync(raw, { maxOutputLength: e.usize });
  if (out.length !== e.usize) throw new Error(`解压长度不符：${e.name}`);
  if (crc32(out) !== e.crc) throw new Error(`CRC 校验失败：${e.name}`);
  return out;
}

/**
 * 把 zip 解到 dest（必须是新建的空目录）。返回 { files: [...相对路径] }。
 * 每个写出路径都再次校验落在 dest 内；用 'wx' 打开，不会覆盖或跟随已有链接。
 */
export function extractZip(buf, dest, limits = LIMITS) {
  const entries = listZip(buf, limits);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(root).length) throw new Error('解压目标目录不为空');
  const files = [];
  for (const e of entries) {
    const abs = resolveInside(root, e.name);
    if (!abs) throw new Error(`不安全的路径：${e.name}`);
    if (e.dir) { fs.mkdirSync(abs, { recursive: true, mode: 0o700 }); continue; }
    const data = entryData(buf, e);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(path.dirname(abs));
    if (real !== fs.realpathSync(root) && !real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`不安全的路径：${e.name}`);
    const fd = fs.openSync(abs, 'wx', 0o600);
    try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    files.push(e.name);
  }
  return { files };
}

/** 包内容根：根上没有 review.json / index.html 且所有文件都在同一个顶层目录里时，取那个目录。 */
export function detectRoot(files) {
  const list = (files || []).filter(Boolean);
  if (list.some((f) => f === 'review.json' || f === 'index.html')) return '';
  const tops = new Set(list.map((f) => (f.includes('/') ? f.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    const top = [...tops][0];
    if (list.some((f) => f === `${top}/review.json` || f === `${top}/index.html`)) return top;
  }
  return '';
}

// ---------- review.json ----------

const SCENE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const KNOWN_KEYS = new Set(['v', 'title', 'entry', 'scene', 'tabs']);

function cleanText(s, max) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * 只读元信息：title / entry / scene / tabs。其余字段（例如旧的 fields、mode:"form"）
 * 一律忽略并列进 ignored，grokbot-x 不据此画任何表单。
 */
export function parseReview(text, { fallbackTitle = '' } = {}) {
  const warnings = [];
  let raw = {};
  if (text == null || text === '') {
    warnings.push('缺少 review.json，按默认值打开 index.html');
  } else {
    try { raw = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`review.json 不是合法 JSON：${e.message}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('review.json 必须是对象');
  }
  if (raw.v !== undefined && raw.v !== 1) warnings.push(`未知的 review.json 版本 v=${String(raw.v).slice(0, 10)}，按 v1 处理`);
  const ignored = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  if (ignored.length) warnings.push(`忽略字段：${ignored.join(', ').slice(0, 200)}（反馈 UI 由页面自己渲染）`);
  const title = cleanText(typeof raw.title === 'string' && raw.title.trim() ? raw.title : (fallbackTitle || '交互预览验收'), 200);
  let entry = 'index.html';
  if (raw.entry !== undefined) {
    const e = typeof raw.entry === 'string' ? safeEntryName(raw.entry.split(/[?#]/)[0]) : '';
    if (!e || !/\.html?$/i.test(e)) throw new Error('review.json 的 entry 必须是包内相对的 .html 路径');
    entry = e;
  }
  const scene = typeof raw.scene === 'string' && SCENE_RE.test(raw.scene) ? raw.scene : (Array.isArray(raw.tabs) ? 'bundle' : 'general');
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter((t) => typeof t === 'string' && SCENE_RE.test(t)).slice(0, 20) : undefined;
  const out = { v: 1, title, entry, scene };
  if (tabs) out.tabs = tabs;
  return { review: out, warnings, ignored };
}

// ---------- 桥接注入 ----------

/** 预览页里的桥接；submitFeedback 通过 postMessage 交给外壳（外壳再走 preload/IPC）。 */
export function bridgeScript(parentOrigin) {
  const origin = JSON.stringify(String(parentOrigin));
  return `(function(){try{if(window.__grokbotXPreview)return;var O=${origin},seq=0,pend={};
window.addEventListener('message',function(ev){if(ev.source!==window.parent||ev.origin!==O)return;var d=ev.data;if(!d||d.gxPreview!==1||d.type!=='result'||!pend[d.id])return;var p=pend[d.id];delete pend[d.id];clearTimeout(p.t);if(d.ok)p.resolve(d.result);else p.reject(new Error(d.error||'提交失败'));});
function submitFeedback(arg){return new Promise(function(resolve,reject){arg=arg||{};var j=arg.json,text;
if(!j||typeof j!=='object'||Array.isArray(j))return reject(new TypeError('json 必须是对象'));
try{text=JSON.stringify(j);}catch(e){return reject(new TypeError('json 无法序列化'));}
var fs=[];var src=arg.files||[];for(var i=0;i<src.length;i++){var f=src[i];if(typeof Blob!=='undefined'&&f instanceof Blob)fs.push({name:String(f.name||('file-'+(i+1))),type:String(f.type||''),blob:f});}
var id=++seq;pend[id]={resolve:resolve,reject:reject,t:setTimeout(function(){if(pend[id]){delete pend[id];reject(new Error('grokbot-x 没有响应'));}},120000)};
try{window.parent.postMessage({gxPreview:1,type:'submit',id:id,json:text,files:fs},O);}catch(e){delete pend[id];reject(e);}});}
Object.defineProperty(window,'__grokbotXPreview',{value:Object.freeze({v:1,host:'grokbot-x',autoSend:false,submitFeedback:submitFeedback}),configurable:false,writable:false});}catch(e){}})();`;
}

/**
 * 在 HTML 里插入桥接 <script>，尽量放在页面自己的脚本之前：
 * <head> 之后 → <html> 之后 → doctype 之后 → 最前面。
 */
export function injectBridge(html, parentOrigin) {
  const tag = `<script data-grokbotx-preview-bridge>${bridgeScript(parentOrigin)}</script>`;
  const s = String(html);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + tag + s.slice(m.index + m[0].length);
  }
  return tag + s;
}

// ---------- 外壳页 ----------

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 外壳：整窗一个 sandbox iframe（allow-scripts allow-forms，没有 allow-same-origin，
 * 访问不到外壳、cookie 或 storage）。外壳只转发 submitFeedback，不画任何表单；
 * 成功提示交给页面自己和系统通知；外壳只在宿主出错时显示一条红色提示。
 */
export function shellHtml({ title, frameSrc, nonce }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'">
<title>${escHtml(title)} · 交互预览验收</title>
<style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0}
#gx-toast{position:fixed;left:50%;top:12px;transform:translateX(-50%);max-width:80vw;padding:8px 14px;border-radius:999px;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);opacity:0;pointer-events:none;transition:opacity .2s;z-index:2}
#gx-toast.on{opacity:1}#gx-toast{background:#b42318}</style></head>
<body><iframe id="gx-frame" title="${escHtml(title)}" sandbox="allow-scripts allow-forms allow-modals" src="${escHtml(frameSrc)}"></iframe><div id="gx-toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">(function(){var fr=document.getElementById('gx-frame'),toast=document.getElementById('gx-toast'),tm=0;
function fail(t){toast.textContent=t;toast.className='on';clearTimeout(tm);tm=setTimeout(function(){toast.className='';},6000);}
window.addEventListener('message',function(ev){if(ev.source!==fr.contentWindow)return;var d=ev.data;if(!d||d.gxPreview!==1||d.type!=='submit')return;
var src=ev.source,id=d.id;function reply(ok,res,err){try{src.postMessage({gxPreview:1,type:'result',id:id,ok:ok,result:res,error:err},'*');}catch(e){}}
var host=window.gxPreviewHost;if(!host||typeof host.submit!=='function'){reply(false,null,'宿主桥接不可用');return;}
var files=Array.isArray(d.files)?d.files:[];
Promise.all(files.map(function(f){return f&&f.blob&&f.blob.arrayBuffer?f.blob.arrayBuffer().then(function(b){return {name:String(f.name||''),type:String(f.type||''),data:new Uint8Array(b)};}):null;}))
.then(function(fs){return host.submit({json:String(d.json||''),files:fs.filter(Boolean)});})
.then(function(r){if(r&&r.ok){reply(true,{mode:r.mode,dir:r.dir,files:r.files,message:r.message},null);}else{var m=(r&&r.error)||'提交失败';fail('grokbot-x：'+m);reply(false,null,m);}})
.catch(function(e){var m=String(e&&e.message||e);fail('grokbot-x：'+m);reply(false,null,m);});});})();</script></body></html>`;
}

// ---------- 本地 HTTP 服务（只绑 127.0.0.1） ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
};
export function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * sessions: Map<token, { root, entry, title }>。
 * 路由：/__gx/shell/<token> 外壳页；/p/<token>/<相对路径> 包内文件（只有 entry 会被注入桥接）。
 */
export function createPreviewServer({ sessions, log } = {}) {
  let origin = '';
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', { Allow: 'GET, HEAD' });
      // DNS rebinding 防护：只认 127.0.0.1:<port>
      if (req.headers.host !== origin.slice('http://'.length)) return send(421, 'misdirected');
      const url = new URL(req.url, origin);
      let m = /^\/__gx\/shell\/([0-9a-f]{32})$/.exec(url.pathname);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) return send(404, 'not found');
        const nonce = crypto.randomBytes(12).toString('base64');
        const frameSrc = `/p/${m[1]}/${s.entry.split('/').map(encodeURIComponent).join('/')}${s.query || ''}`;
        return send(200, shellHtml({ title: s.title, frameSrc, nonce }), {
          'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        });
      }
      m = /^\/p\/([0-9a-f]{32})\/(.*)$/.exec(url.pathname);
      if (!m) return send(404, 'not found');
      const s = sessions.get(m[1]);
      if (!s) return send(404, 'not found');
      let rel;
      try { rel = m[2].split('/').map(decodeURIComponent).join('/'); } catch { return send(400, 'bad path'); }
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const safe = safeEntryName(rel);
      const abs = safe && resolveInside(s.root, safe);
      if (!abs) return send(403, 'forbidden');
      let st;
      try { st = fs.statSync(abs); } catch { return send(404, 'not found'); }
      if (!st.isFile()) return send(404, 'not found');
      const real = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(s.root);
      if (!real.startsWith(realRoot + path.sep)) return send(403, 'forbidden');
      // sandbox iframe 是不透明源，模块脚本 / fetch 需要 CORS；token 在路径里，外部猜不到
      const headers = { 'Content-Type': contentType(abs), 'Access-Control-Allow-Origin': '*', 'Referrer-Policy': 'no-referrer' };
      if (safe === s.entry) {
        const html = injectBridge(fs.readFileSync(abs, 'utf8'), origin);
        return send(200, html, headers);
      }
      return send(200, fs.readFileSync(abs), headers);
    } catch (e) {
      log?.warn?.(`preview server: ${e.message}`);
      return send(500, 'error');
    }
  });
  return {
    server,
    get origin() { return origin; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          origin = `http://127.0.0.1:${server.address().port}`;
          resolve(origin);
        });
      });
    },
    close() { return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }); },
  };
}

// ---------- 反馈：校验、落盘、剪贴板策略 ----------

export function sanitizeName(name, fallback = 'file') {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 150);
  return cleaned || fallback;
}

/** 外壳经 IPC 交来的 { json: string, files: [{ name, type, data: Uint8Array }] }。 */
export function validateSubmit(payload, limits = LIMITS) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: '反馈格式不对' };
  const text = payload.json;
  if (typeof text !== 'string' || !text) return { ok: false, error: '缺少反馈 JSON' };
  if (text.length > limits.maxFeedbackJsonChars) return { ok: false, error: '反馈 JSON 过大' };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: '反馈不是合法 JSON' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: '反馈 JSON 必须是对象' };
  const list = payload.files == null ? [] : payload.files;
  if (!Array.isArray(list)) return { ok: false, error: 'files 必须是数组' };
  if (list.length > limits.maxFeedbackFiles) return { ok: false, error: `附件最多 ${limits.maxFeedbackFiles} 个` };
  const files = [];
  let total = 0;
  for (const f of list) {
    if (!f || typeof f !== 'object') return { ok: false, error: '附件格式不对' };
    const d = f.data;
    const buf = Buffer.isBuffer(d) ? d : d instanceof Uint8Array ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;
    if (!buf) return { ok: false, error: '附件缺少数据' };
    if (buf.length > limits.maxFeedbackFileBytes) return { ok: false, error: `附件过大：${sanitizeName(f.name)}` };
    total += buf.length;
    if (total > limits.maxFeedbackTotalBytes) return { ok: false, error: '附件合计过大' };
    files.push({ name: sanitizeName(f.name), type: String(f.type || '').slice(0, 100), buffer: buf });
  }
  return { ok: true, json, files, totalBytes: total };
}

function uniqueName(name, used) {
  let n = name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base}-${i}${ext}`;
  used.add(n.toLowerCase());
  return n;
}

/**
 * 写到 <root>/<stamp>-<rand>/：feedback.json（页面给的 JSON + feedbackFiles 绝对路径）和附件。
 * 返回 { dir, jsonPath, jsonText, paths }，paths 里 JSON 在最前。
 */
export function writeFeedback(root, { json, files = [] }, { stamp = '', meta = null } = {}) {
  const dir = path.join(path.resolve(root), `${stamp || Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = new Set(['feedback.json']);
  const written = [];
  for (const f of files) {
    const name = uniqueName(sanitizeName(f.name), used);
    const p = path.join(dir, name);
    if (path.dirname(p) !== dir) throw new Error('附件路径不安全');
    fs.writeFileSync(p, f.buffer, { mode: 0o600, flag: 'wx' });
    written.push({ name, path: p, bytes: f.buffer.length, type: f.type || '' });
  }
  const out = { ...json };
  if (written.length) out.feedbackFiles = written;
  if (meta) out.grokbotxPreview = meta;
  const jsonText = JSON.stringify(out, null, 2);
  const jsonPath = path.join(dir, 'feedback.json');
  fs.writeFileSync(jsonPath, jsonText + '\n', { mode: 0o600, flag: 'wx' });
  return { dir, jsonPath, jsonText, paths: [jsonPath, ...written.map((w) => w.path)] };
}

/** 'text'：没有附件，复制 JSON 文本；'files'：JSON + 附件作为文件列表；'dir'：附件太大，复制反馈目录路径。 */
export function clipboardPlan({ fileCount, totalBytes }, limits = LIMITS) {
  if (!fileCount) return 'text';
  if (totalBytes > limits.clipboardMaxBytes) return 'dir';
  return 'files';
}

export function dirClipboardText(dir, jsonText) {
  return `反馈附件较大，未放进剪贴板。反馈目录：${dir}\n\n${jsonText}`;
}

// ---------- 取 zip 的来源链 ----------

/** 依次尝试 sources（{ name, fetch(req) → Buffer|null }），返回第一个拿到的；抛出 abort 错误时立即停。 */
export async function resolveZip(req, sources, { maxBytes = LIMITS.maxZipBytes } = {}) {
  const tried = [];
  for (const s of sources) {
    try {
      const buf = await s.fetch(req);
      if (!buf) { tried.push(`${s.name}:skip`); continue; }
      if (buf.length > maxBytes) { tried.push(`${s.name}:too-large`); continue; }
      if (buf.length < 4 || buf.readUInt32LE(0) !== SIG_LOC) { tried.push(`${s.name}:not-zip`); continue; }
      tried.push(`${s.name}:ok`);
      return { buffer: buf, method: s.name, tried };
    } catch (e) {
      tried.push(`${s.name}:${String(e?.message || e).slice(0, 80)}`);
      // e.abort：例如用户在系统保存框里点了取消，后面的来源（含我们自己的文件选择框）都不再跑
      if (e?.abort) { e.tried = tried; throw e; }
    }
  }
  const err = new Error('拿不到压缩包');
  err.tried = tried;
  throw err;
}

/** 客户端下载按钮通常存到 下载目录/<name>，重名时是 "<base> (n).zip"。 */
export function downloadCandidates(dir, name) {
  const safe = sanitizeName(name, '');
  if (!dir || !safe || !/\.zip$/i.test(safe)) return [];
  const base = safe.slice(0, -4);
  const out = [path.join(dir, safe)];
  for (let i = 1; i <= 20; i++) out.push(path.join(dir, `${base} (${i}).zip`), path.join(dir, `${base}(${i}).zip`));
  return out;
}

/** 候选里最近修改、且在 maxAgeMs 内的那个。 */
export function newestRecent(paths, { now = Date.now(), maxAgeMs = 30 * 60 * 1000, stat = fs.statSync } = {}) {
  let best = null;
  for (const p of paths) {
    let st;
    try { st = stat(p); } catch { continue; }
    if (!st.isFile() || now - st.mtimeMs > maxAgeMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

/** 卡片上显示的 "1.9kB" / "3.2 MB" → 字节数（取不到返回 0）。 */
export function parseSizeLabel(s) {
  const m = /([\d.]+)\s*(B|KB|kB|MB|GB)\b/i.exec(String(s || ''));
  if (!m) return 0;
  const k = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * k);
}

/** 卡片上的大小是四舍五入后的文字（如 1.9kB），允许 15% + 1KB 的误差；没有提示就不比。 */
export function sizeMatches(size, hint) {
  if (!hint) return true;
  return Math.abs(size - hint) <= hint * 0.15 + 1024;
}

export function normalizeRequest(d) {
  const name = sanitizeName(String(d?.name || ''), '');
  if (!name || !/\.zip$/i.test(name)) throw new Error('不是 .zip 附件');
  const source = typeof d?.source === 'string' ? d.source.slice(0, 4096) : '';
  const sizeHint = parseSizeLabel(typeof d?.meta === 'string' ? d.meta.slice(0, 200) : '');
  const reqId = typeof d?.reqId === 'string' && /^[a-z0-9]{1,32}$/i.test(d.reqId) ? d.reqId : '';
  return { name, source, sizeHint, reqId, origin: d?.origin === 'composer' ? 'composer' : 'message' };
}
