import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LIMITS, safeEntryName, resolveInside, listZip, extractZip, detectRoot, parseReview,
  bridgeScript, injectBridge, shellHtml, createPreviewServer, newToken, validateSubmit,
  writeFeedback, clipboardPlan, dirClipboardText, resolveZip, downloadCandidates, newestRecent,
  parseSizeLabel, sizeMatches, normalizeRequest, sanitizeName,
} from '../electron/preview-core.mjs';
import {
  PREVIEW_BYTE_CAP, readBytesExpr, downloadExpr, evalValue, parseReadResult, looksLikeAttachmentPath,
  localPathOf, rescanDownloads, desktopSources, cancelledError, scrub,
} from '../features/preview/desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `gx-preview-${p}-`));

// ---- 最小 zip 写入器（测试专用，可构造恶意条目） ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const cens = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? (data.length > 64 ? 8 : 0);
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(e.flags ?? 0x800, 6);
    loc.writeUInt16LE(method, 8); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(e.usize ?? data.length, 22); loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(e.madeBy ?? 20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(e.flags ?? 0x800, 8); cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(e.usize ?? data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(e.ext ?? 0, 38); cen.writeUInt32LE(off, 42);
    cens.push(cen, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function zipDir(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(p).isDirectory()) walk(p, r); else out.push({ name: r, data: fs.readFileSync(p) });
    }
  })(dir, '');
  return makeZip(out);
}

// ---- 路径安全 ----

test('safeEntryName rejects traversal, absolute and drive paths', () => {
  assert.equal(safeEntryName('assets/app.js'), 'assets/app.js');
  assert.equal(safeEntryName('./a//b.html'), 'a/b.html');
  assert.equal(safeEntryName('a\\b.css'), 'a/b.css');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', '\\\\server\\x', 'C:\\x', 'c:/x', 'a\u0000b', '..', '']) {
    assert.equal(safeEntryName(bad), '', bad);
  }
  const r = tmp('in');
  assert.equal(resolveInside(r, 'a/b'), path.join(r, 'a', 'b'));
  assert.equal(resolveInside(r, '../b'), '');
});

test('extractZip writes a normal package and keeps everything inside dest', () => {
  const dest = path.join(tmp('ok'), 'out');
  const big = 'x'.repeat(5000);
  const { files } = extractZip(makeZip([
    { name: 'index.html', data: '<html><body>hi</body></html>' },
    { name: 'assets/', data: '' },
    { name: 'assets/app.js', data: big },
  ]), dest);
  assert.deepEqual(files, ['index.html', 'assets/app.js']);
  assert.equal(fs.readFileSync(path.join(dest, 'assets', 'app.js'), 'utf8'), big);
  assert.equal(fs.statSync(path.join(dest, 'index.html')).mode & 0o777, 0o600);
});

test('extractZip blocks zip slip, symlinks, encryption and bad data', () => {
  const cases = [
    [[{ name: '../evil.txt', data: 'x' }], /不安全的路径/],
    [[{ name: 'ok/../../evil.txt', data: 'x' }], /不安全的路径/],
    [[{ name: '/abs.txt', data: 'x' }], /不安全的路径/],
    [[{ name: 'C:/win.txt', data: 'x' }], /不安全的路径/],
    [[{ name: 'link', data: '/etc/passwd', madeBy: (3 << 8) | 20, ext: (0o120777 << 16) >>> 0 }], /符号链接/],
    [[{ name: 'secret.txt', data: 'x', flags: 0x801 }], /加密/],
    [[{ name: 'a.txt', data: 'abc', crc: 1 }], /CRC/],
    [[{ name: 'a.txt', data: 'x' }, { name: 'A.TXT', data: 'y' }], /重复/],
    [[{ name: 'a.txt', data: 'x', method: 12 }], /压缩方式/],
  ];
  for (const [entries, re] of cases) {
    const parent = tmp('bad');
    const dest = path.join(parent, 'out');
    assert.throws(() => extractZip(makeZip(entries), dest), re);
    assert.equal(fs.existsSync(path.join(parent, 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(parent), 'evil.txt')), false);
  }
  assert.throws(() => extractZip(Buffer.from('not a zip at all, definitely not'), path.join(tmp('nz'), 'o')), /不是有效的 zip/);
});

test('size limits: zip bytes, entry count, unpacked total and inflate bombs', () => {
  const lim = { ...LIMITS, maxZipBytes: 1000, maxEntries: 2, maxUnpackedBytes: 100, maxEntryBytes: 80 };
  assert.throws(() => listZip(Buffer.alloc(2000), lim), /超过上限/);
  assert.throws(() => listZip(makeZip([{ name: 'a', data: '1' }, { name: 'b', data: '2' }, { name: 'c', data: '3' }]), lim), /条目数/);
  assert.throws(() => listZip(makeZip([{ name: 'a', data: 'x'.repeat(60) }, { name: 'b', data: 'y'.repeat(60) }]), lim), /解压后超过/);
  assert.throws(() => listZip(makeZip([{ name: 'a', data: 'x'.repeat(90), method: 8 }]), lim), /文件过大/);
  // 声明 10 字节、实际能解出 100KB：maxOutputLength 截停
  const bomb = makeZip([{ name: 'bomb.txt', data: 'z'.repeat(100000), method: 8, usize: 10 }]);
  assert.throws(() => extractZip(bomb, path.join(tmp('bomb'), 'o')));
});

test('detectRoot picks a single wrapping folder only when it holds the package', () => {
  assert.equal(detectRoot(['index.html', 'review.json']), '');
  assert.equal(detectRoot(['pkg/index.html', 'pkg/review.json', 'pkg/assets/a.js']), 'pkg');
  assert.equal(detectRoot(['pkg/readme.txt']), '');
  assert.equal(detectRoot(['a/index.html', 'b/x.js']), '');
});

// ---- review.json ----

test('parseReview keeps only title/entry/scene/tabs and ignores form fields', () => {
  const { review, warnings, ignored } = parseReview(JSON.stringify({
    v: 1, title: '晨光咖啡 App 改版验收', entry: 'index.html', scene: 'bundle',
    tabs: ['visual', 'animation', 'bad tab!'], mode: 'form', fields: [{ id: 'x' }],
  }));
  assert.deepEqual(review, { v: 1, title: '晨光咖啡 App 改版验收', entry: 'index.html', scene: 'bundle', tabs: ['visual', 'animation'] });
  assert.deepEqual(ignored, ['mode', 'fields']);
  assert.ok(warnings.some((w) => /忽略字段/.test(w)));
});

test('parseReview defaults, entry validation and errors', () => {
  const d = parseReview('', { fallbackTitle: 'demo-preview' });
  assert.deepEqual(d.review, { v: 1, title: 'demo-preview', entry: 'index.html', scene: 'general' });
  assert.ok(d.warnings.length);
  assert.equal(parseReview('{"entry":"app/login.html?review=1"}').review.entry, 'app/login.html');
  assert.equal(parseReview('\uFEFF{"title":"x\\u0007y"}').review.title, 'x y');
  assert.throws(() => parseReview('{"entry":"../x.html"}'), /entry/);
  assert.throws(() => parseReview('{"entry":"main.js"}'), /entry/);
  assert.throws(() => parseReview('[1]'), /对象/);
  assert.throws(() => parseReview('{bad'), /JSON/);
});

test('the bundled skill example review.json parses cleanly', () => {
  const text = fs.readFileSync(path.join(root, 'skills/preview-review/examples/review.json'), 'utf8');
  const { review, ignored } = parseReview(text);
  assert.equal(review.scene, 'bundle');
  assert.equal(review.entry, 'index.html');
  assert.deepEqual(ignored, []);
});

// ---- 桥接注入 ----

test('injectBridge inserts the bridge before page scripts and never edits the rest', () => {
  const origin = 'http://127.0.0.1:4567';
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><script src="a.js"></script></head><body></body></html>';
  const out = injectBridge(html, origin);
  const i = out.indexOf('data-grokbotx-preview-bridge');
  assert.ok(i > out.indexOf('<head>') && i < out.indexOf('src="a.js"'));
  assert.equal(out.replace(/<script data-grokbotx-preview-bridge>[\s\S]*?<\/script>/, ''), html);
  assert.ok(out.includes(JSON.stringify(origin)));
  assert.ok(injectBridge('<p>x</p>', origin).startsWith('<script data-grokbotx-preview-bridge>'));
  const noHead = injectBridge('<!DOCTYPE html><p>x</p>', origin);
  assert.ok(noHead.startsWith('<!DOCTYPE html><script'));
  assert.doesNotThrow(() => new vm.Script(bridgeScript(origin)));
});

function bridgeWindow(origin) {
  const listeners = [];
  const posted = [];
  const parent = { postMessage: (data, target) => posted.push({ data, target }) };
  const win = {
    parent,
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    setTimeout, clearTimeout, Blob, Promise, JSON, Object, Error, TypeError, String, Array,
  };
  win.window = win;
  vm.runInNewContext(bridgeScript(origin), win);
  return { win, posted, dispatch: (ev) => listeners.forEach((fn) => fn(ev)) };
}

test('bridge: submitFeedback posts {json, files} to the shell and resolves on its reply', async () => {
  const origin = 'http://127.0.0.1:4567';
  const { win, posted, dispatch } = bridgeWindow(origin);
  const api = win.__grokbotXPreview;
  assert.equal(api.v, 1);
  assert.equal(api.autoSend, false);
  assert.ok(Object.isFrozen(api));
  const file = new File(['png'], 'shot.png', { type: 'image/png' });
  const p = api.submitFeedback({ json: { scene: 'visual', verdict: '通过' }, files: [file, 'not-a-file'] });
  assert.equal(posted.length, 1);
  const msg = posted[0];
  assert.equal(msg.target, origin);
  assert.equal(msg.data.type, 'submit');
  assert.deepEqual(JSON.parse(msg.data.json), { scene: 'visual', verdict: '通过' });
  assert.equal(msg.data.files.length, 1);
  assert.equal(msg.data.files[0].name, 'shot.png');
  // 别的来源的消息不算
  dispatch({ source: {}, origin, data: { gxPreview: 1, type: 'result', id: msg.data.id, ok: false } });
  dispatch({ source: win.parent, origin: 'http://evil', data: { gxPreview: 1, type: 'result', id: msg.data.id, ok: false } });
  dispatch({ source: win.parent, origin, data: { gxPreview: 1, type: 'result', id: msg.data.id, ok: true, result: { mode: 'files' } } });
  assert.equal((await p).mode, 'files');
  const q = api.submitFeedback({ json: { a: 1 } });
  dispatch({ source: win.parent, origin, data: { gxPreview: 1, type: 'result', id: posted[1].data.id, ok: false, error: '剪贴板失败' } });
  await assert.rejects(q, /剪贴板失败/);
  await assert.rejects(api.submitFeedback({ json: [1] }), /对象/);
  await assert.rejects(api.submitFeedback({}), /对象/);
});

test('shell page: sandbox iframe without allow-same-origin, strict CSP, no form', () => {
  const html = shellHtml({ title: '<b>t</b>', frameSrc: '/p/abc/index.html', nonce: 'N0nce' });
  const m = /<iframe[^>]*sandbox="([^"]+)"/.exec(html);
  assert.ok(m);
  assert.ok(m[1].split(' ').includes('allow-scripts'));
  assert.ok(!m[1].includes('allow-same-origin'));
  assert.ok(!m[1].includes('allow-top-navigation'));
  assert.ok(!m[1].includes('allow-popups'));
  assert.match(html, /script-src 'nonce-N0nce'/);
  assert.ok(!/<form|<textarea|<input/i.test(html));
  assert.ok(html.includes('&lt;b&gt;t&lt;/b&gt;'));
});

// ---- 本地服务 ----

test('preview server: loopback only, injects only the entry, blocks traversal and foreign hosts', async (t) => {
  const pkg = tmp('srv');
  fs.mkdirSync(path.join(pkg, 'assets'));
  fs.writeFileSync(path.join(pkg, 'index.html'), '<html><head></head><body>entry</body></html>');
  fs.writeFileSync(path.join(pkg, 'other.html'), '<html><head></head><body>other</body></html>');
  fs.writeFileSync(path.join(pkg, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(path.dirname(pkg), 'outside-secret.txt'), 'secret');
  const sessions = new Map();
  const token = newToken();
  sessions.set(token, { root: pkg, entry: 'index.html', title: '测试' });
  const srv = createPreviewServer({ sessions });
  const origin = await srv.listen();
  t.after(() => srv.close());
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(srv.server.address().address, '127.0.0.1');

  const shell = await fetch(`${origin}/__gx/shell/${token}`);
  assert.equal(shell.status, 200);
  const shellText = await shell.text();
  assert.ok(shellText.includes(`/p/${token}/index.html`));

  const entry = await (await fetch(`${origin}/p/${token}/index.html?review=1`)).text();
  assert.ok(entry.includes('__grokbotXPreview'));
  assert.ok(entry.includes(JSON.stringify(origin)));
  const dirIndex = await (await fetch(`${origin}/p/${token}/`)).text();
  assert.ok(dirIndex.includes('__grokbotXPreview'));
  const other = await (await fetch(`${origin}/p/${token}/other.html`)).text();
  assert.ok(!other.includes('__grokbotXPreview'));
  const js = await fetch(`${origin}/p/${token}/assets/app.js`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('access-control-allow-origin'), '*');
  assert.equal(await js.text(), 'console.log(1)');
  assert.equal(fs.readFileSync(path.join(pkg, 'index.html'), 'utf8').includes('__grokbotXPreview'), false);

  for (const p of [`/p/${token}/..%2Foutside-secret.txt`, `/p/${token}/assets/..%2F..%2Foutside-secret.txt`, `/p/${token}/%2e%2e/outside-secret.txt`]) {
    const r = await fetch(origin + p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!(await r.text()).includes('secret'));
  }
  assert.equal((await fetch(`${origin}/p/${'0'.repeat(32)}/index.html`)).status, 404);
  assert.equal((await fetch(`${origin}/p/${token}/index.html`, { method: 'POST', body: 'x' })).status, 405);
  const port = srv.server.address().port;
  const http = await import('node:http');
  const foreign = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/p/${token}/index.html`, headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(foreign, 421);
});

test('preview server serves the bundled skill examples zip end to end', async (t) => {
  const zip = zipDir(path.join(root, 'skills/preview-review/examples'));
  const dest = path.join(tmp('ex'), 'out');
  const { files } = extractZip(zip, dest);
  assert.ok(files.includes('index.html') && files.includes('review.json') && files.includes('app/login.html'));
  const { review } = parseReview(fs.readFileSync(path.join(dest, 'review.json'), 'utf8'));
  const sessions = new Map([[newToken(), { root: dest, entry: review.entry, title: review.title }]]);
  const [token] = sessions.keys();
  const srv = createPreviewServer({ sessions });
  const origin = await srv.listen();
  t.after(() => srv.close());
  const html = await (await fetch(`${origin}/p/${token}/index.html`)).text();
  assert.ok(html.indexOf('data-grokbotx-preview-bridge') < html.indexOf('assets/app.js'));
  assert.equal((await fetch(`${origin}/p/${token}/app/login.html?review=1`)).status, 200);
});

// ---- 反馈 ----

test('validateSubmit checks json object, file count and sizes', () => {
  const ok = validateSubmit({ json: '{"verdict":"通过"}', files: [{ name: '../../x.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.json, { verdict: '通过' });
  assert.equal(ok.files[0].name, 'x.png');
  assert.equal(ok.totalBytes, 3);
  assert.equal(validateSubmit({ json: '[1]' }).ok, false);
  assert.equal(validateSubmit({ json: 'nope' }).ok, false);
  assert.equal(validateSubmit({ json: '' }).ok, false);
  assert.equal(validateSubmit(null).ok, false);
  assert.equal(validateSubmit({ json: '{}', files: [{ name: 'a' }] }).ok, false);
  const lim = { ...LIMITS, maxFeedbackFiles: 1, maxFeedbackFileBytes: 4, maxFeedbackTotalBytes: 6 };
  const f = (n) => ({ name: 'a', data: new Uint8Array(n) });
  assert.match(validateSubmit({ json: '{}', files: [f(1), f(1)] }, lim).error, /最多/);
  assert.match(validateSubmit({ json: '{}', files: [f(5)] }, lim).error, /过大/);
  assert.match(validateSubmit({ json: '{}', files: [f(4), f(4)] }, { ...lim, maxFeedbackFiles: 5 }).error, /合计/);
});

test('writeFeedback writes feedback.json first, with absolute file paths and safe names', () => {
  const rootDir = tmp('fb');
  const out = writeFeedback(rootDir, {
    json: { scene: 'visual', verdict: '需修改' },
    files: [
      { name: 'feedback.json', type: 'application/json', buffer: Buffer.from('{}') },
      { name: 'shot.png', type: 'image/png', buffer: Buffer.from('a') },
      { name: 'shot.png', type: 'image/png', buffer: Buffer.from('b') },
    ],
  }, { stamp: '20261113-030000', meta: { zip: 'demo.zip', autoSent: false } });
  assert.ok(out.dir.startsWith(rootDir + path.sep));
  assert.match(path.basename(out.dir), /^20261113-030000-[0-9a-f]{6}$/);
  assert.equal(out.paths[0], out.jsonPath);
  assert.deepEqual(out.paths.slice(1).map((p) => path.basename(p)), ['feedback-2.json', 'shot.png', 'shot-2.png']);
  const saved = JSON.parse(fs.readFileSync(out.jsonPath, 'utf8'));
  assert.equal(saved.verdict, '需修改');
  assert.equal(saved.grokbotxPreview.autoSent, false);
  assert.equal(saved.feedbackFiles.length, 3);
  for (const f of saved.feedbackFiles) assert.ok(path.isAbsolute(f.path) && fs.existsSync(f.path));
  assert.equal(fs.readFileSync(path.join(out.dir, 'shot-2.png'), 'utf8'), 'b');
  assert.equal(fs.statSync(out.jsonPath).mode & 0o777, 0o600);
  assert.equal(out.jsonText, JSON.stringify(saved, null, 2));
  const noFiles = writeFeedback(rootDir, { json: { a: 1 } });
  assert.equal(JSON.parse(fs.readFileSync(noFiles.jsonPath, 'utf8')).feedbackFiles, undefined);
});

test('clipboardPlan: text without files, file list normally, directory path when too big', () => {
  assert.equal(clipboardPlan({ fileCount: 0, totalBytes: 0 }), 'text');
  assert.equal(clipboardPlan({ fileCount: 2, totalBytes: 1000 }), 'files');
  assert.equal(clipboardPlan({ fileCount: 1, totalBytes: LIMITS.clipboardMaxBytes + 1 }), 'dir');
  const t = dirClipboardText('/tmp/fb/1', '{"a":1}');
  assert.ok(t.includes('/tmp/fb/1') && t.endsWith('{"a":1}'));
});

// ---- 取 zip ----

test('resolveZip tries sources in order and reports what was tried', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'x' }]);
  const r = await resolveZip({ name: 'a.zip' }, [
    { name: 'none', fetch: () => null },
    { name: 'boom', fetch: () => { throw new Error('nope'); } },
    { name: 'notzip', fetch: () => Buffer.from('hello world') },
    { name: 'good', fetch: async () => zip },
    { name: 'never', fetch: () => { throw new Error('should not run'); } },
  ]);
  assert.equal(r.method, 'good');
  assert.deepEqual(r.tried, ['none:skip', 'boom:nope', 'notzip:not-zip', 'good:ok']);
  await assert.rejects(resolveZip({}, [{ name: 'big', fetch: () => zip }], { maxBytes: 4 }), (e) => e.tried[0] === 'big:too-large');
});

test('download candidates, recency and size hints', () => {
  const dir = tmp('dl');
  const c = downloadCandidates(dir, 'demo-preview.zip');
  assert.equal(c[0], path.join(dir, 'demo-preview.zip'));
  assert.ok(c.includes(path.join(dir, 'demo-preview (2).zip')));
  assert.deepEqual(downloadCandidates(dir, 'x.txt'), []);
  assert.deepEqual(downloadCandidates('', 'x.zip'), []);
  fs.writeFileSync(c[0], 'a');
  fs.writeFileSync(path.join(dir, 'demo-preview (1).zip'), 'bb');
  const now = Date.now();
  fs.utimesSync(c[0], new Date(now - 60_000), new Date(now - 60_000));
  assert.equal(path.basename(newestRecent(c, { now }).path), 'demo-preview (1).zip');
  assert.equal(newestRecent(c, { now: now + 3600_000 }), null);
  assert.equal(parseSizeLabel('1.9kB'), 1900);
  assert.equal(parseSizeLabel('3.2 MB · zip'), 3200000);
  assert.equal(parseSizeLabel('无'), 0);
  assert.ok(sizeMatches(1946, 1900));
  assert.ok(!sizeMatches(50_000, 1900));
  assert.ok(sizeMatches(123, 0));
});

test('normalizeRequest only accepts .zip names and trims inputs', () => {
  const r = normalizeRequest({ name: 'demo-preview.zip', source: 'x'.repeat(5000), meta: '1.9kB', origin: 'composer' });
  assert.equal(r.name, 'demo-preview.zip');
  assert.equal(r.source.length, 4096);
  assert.equal(r.sizeHint, 1900);
  assert.equal(r.origin, 'composer');
  assert.equal(normalizeRequest({ name: 'a.zip', origin: 'weird' }).origin, 'message');
  assert.throws(() => normalizeRequest({ name: 'a.exe' }), /zip/);
  assert.throws(() => normalizeRequest(null), /zip/);
  assert.equal(sanitizeName('../../a<b>.zip'), 'a_b_.zip');
});

// ---- 插件形态 ----

test('feature files: manifest shape, page script uses the kernel bridge, config enables it', () => {
  const src = fs.readFileSync(path.join(root, 'features/preview/feature.mjs'), 'utf8');
  assert.match(src, /name: 'preview'/);
  assert.match(src, /messageTypes: \['open'\]/);
  assert.match(src, /pageScript: 'inject.js'/);
  const page = fs.readFileSync(path.join(root, 'features/preview/inject.js'), 'utf8');
  assert.match(page, /gx\.send\(FEATURE, 'open'/);
  assert.ok(!/addBinding|gxPreviewOpen|isAnysphereUser/.test(page));
  // 页面脚本本身不调官方接口（注释里可以提到），desktop.* 只由主进程经 CDP 调
  assert.ok(!/desktop\s*\.\s*\w+\s*\(/.test(page.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  assert.match(page, /data-gx-preview-req/);
  assert.doesNotThrow(() => new vm.Script(`(function(gx){${page}\n})`));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  assert.equal(cfg.features.preview.enabled, true);
  const main = fs.readFileSync(path.join(root, 'electron/main.mjs'), 'utf8');
  assert.match(main, /'交互预览验收'/);
  const server = fs.readFileSync(path.join(root, 'electron/preview-core.mjs'), 'utf8');
  assert.ok(!server.includes('0.0.0.0'));
});

// ---- 官方 window.desktop.*（用户已允许） ----

/** 模拟 Grok Bot 渲染进程：被点按钮 → 附件卡 fiber → 有 agentId 的祖先 → SandClientProvider（accountSlot getter）。 */
function fakePage(desktop, { slot = 'slot-1', agentId = 'agent-42', provider = true } = {}) {
  const calls = [];
  const spy = {};
  for (const [k, fn] of Object.entries(desktop)) spy[k] = async (a) => { calls.push({ method: k, args: JSON.parse(JSON.stringify(a)) }); return fn(a); };
  const client = { desktop: spy };
  Object.defineProperty(client, 'accountSlot', { get: () => slot, enumerable: true });
  const root = provider ? { memoizedProps: { value: client, children: null }, return: null } : null;
  const card = { '__reactFiber$abc': { memoizedProps: { href: '/home/box/a.zip' }, return: { memoizedProps: { entry: { agentId } }, return: { memoizedProps: { value: 1 }, return: root } } } };
  const btn = { previousElementSibling: card };
  const document = {
    querySelector: (sel) => (sel.includes('data-gx-preview-req="r1"') ? btn : null),
    body: { querySelectorAll: () => [] },
  };
  const ctx = { window: { desktop: spy }, document, CSS: { escape: (s) => s }, btoa, Uint8Array, String, Number, Promise, JSON };
  // returnByValue 等价于 JSON 拷贝
  return { calls, run: async (expr) => ({ result: { value: JSON.parse(JSON.stringify(await vm.runInNewContext(expr, ctx))) } }) };
}

test('readBytesExpr passes path, capped maxBytes, agentId and the current accountSlot as viewSlot', async () => {
  const page = fakePage({ readAttachmentBytes: () => null });
  const v = evalValue(await page.run(readBytesExpr({ reqId: 'r1', path: '/home/box/out/demo.zip', maxBytes: 999 * 1024 * 1024 })));
  assert.deepEqual(v, { kind: 'none', slot: true });
  assert.deepEqual(page.calls[0], { method: 'readAttachmentBytes', args: { path: '/home/box/out/demo.zip', maxBytes: PREVIEW_BYTE_CAP, agentId: 'agent-42', viewSlot: 'slot-1' } });
  // 没找到 provider：不传 viewSlot（不编造）；找到但为 null：照官方传 null
  const noProv = fakePage({ readAttachmentBytes: () => null }, { provider: false });
  await noProv.run(readBytesExpr({ reqId: 'r1', path: '/x.zip' }));
  assert.equal('viewSlot' in noProv.calls[0].args, false);
  const nullSlot = fakePage({ readAttachmentBytes: () => null }, { slot: null });
  await nullSlot.run(readBytesExpr({ reqId: 'r1', path: '/x.zip' }));
  assert.equal(nullSlot.calls[0].args.viewSlot, null);
});

test('readBytesExpr results: bytes round-trip as base64, too-large, thrown errors, missing desktop', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'x'.repeat(100000) }]);
  const ok = fakePage({ readAttachmentBytes: () => ({ kind: 'bytes', bytes: new Uint8Array(zip), size: zip.length, resolvedName: 'a.zip' }) });
  const r = parseReadResult(evalValue(await ok.run(readBytesExpr({ reqId: 'r1', path: '/a.zip' }))));
  assert.equal(r.kind, 'bytes');
  assert.ok(r.buffer.equals(zip));
  const big = fakePage({ readAttachmentBytes: () => ({ kind: 'too-large', size: 30e6 }) });
  assert.deepEqual(parseReadResult(evalValue(await big.run(readBytesExpr({ path: '/a.zip' })))), { kind: 'too-large', size: 30e6 });
  const boom = fakePage({ readAttachmentBytes: () => { throw Object.assign(new Error('x'), { code: 'ATTACHMENT_READ_ABANDONED' }); } });
  assert.equal(parseReadResult(evalValue(await boom.run(readBytesExpr({ path: '/a.zip' })))).error, 'ATTACHMENT_READ_ABANDONED');
  const none = { window: {}, document: {}, CSS: {} };
  assert.equal((await vm.runInNewContext(readBytesExpr({ path: '/a.zip' }), none)).kind, 'unavailable');
  assert.equal(parseReadResult({ kind: 'bytes', base64: 'AAAA', size: 7 }).error, 'size mismatch');
  assert.throws(() => evalValue({ exceptionDetails: { text: 'Uncaught' } }), /Uncaught/);
});

test('downloadExpr maps true/false and only sends path + suggestedName', async () => {
  const yes = fakePage({ downloadAttachment: () => true });
  assert.equal(evalValue(await yes.run(downloadExpr({ path: '/home/box/a.zip', suggestedName: 'a.zip' }))).kind, 'saved');
  assert.deepEqual(yes.calls[0].args, { path: '/home/box/a.zip', suggestedName: 'a.zip' });
  const no = fakePage({ downloadAttachment: () => false });
  assert.equal(evalValue(await no.run(downloadExpr({ path: '/a.zip', suggestedName: 'a.zip' }))).kind, 'cancelled');
});

test('looksLikeAttachmentPath / localPathOf follow the client path rules', () => {
  for (const ok of ['/home/box/a.zip', 'C:\\Users\\x\\a.zip', 'd:/a.zip', 'file:///tmp/a.zip']) assert.equal(looksLikeAttachmentPath(ok), true, ok);
  for (const no of ['https://x/a.zip', 'http://x/a.zip', 'sand-media://image/abc', 'blob:x', 'a.zip', '']) assert.equal(looksLikeAttachmentPath(no), false, no);
  assert.equal(localPathOf(pathToFileURL('/tmp/a b.zip').href), '/tmp/a b.zip');
  assert.equal(localPathOf('/home/box/a.zip'), '/home/box/a.zip');
});

test('rescanDownloads only accepts files written after the download started', () => {
  const dir = tmp('rescan');
  const now = Date.now();
  const at = (n, ms) => { const p = path.join(dir, n); fs.writeFileSync(p, 'z'); fs.utimesSync(p, new Date(ms), new Date(ms)); };
  at('demo.zip', now - 3600_000); // 旧文件
  const opts = { since: now - 1000, now, stat: fs.statSync };
  assert.equal(rescanDownloads(dir, 'demo.zip', opts), null);
  at('demo (1).zip', now);
  assert.equal(path.basename(rescanDownloads(dir, 'demo.zip', opts).path), 'demo (1).zip');
  assert.equal(rescanDownloads(dir, 'demo.zip', { ...opts, now: now + 10 * 60_000 }), null);
});

function chainDeps(page, { downloads, exists = () => false, clock = Date.now } = {}) {
  return {
    evaluate: (expr) => page.run(expr),
    exists,
    stat: fs.statSync,
    readFile: (p) => fs.readFileSync(p),
    downloadsDir: () => downloads,
    now: clock,
    log: { info() {}, warn() {} },
  };
}

test('desktop sources: read null → download saved → rescan Downloads finds the zip', async () => {
  const downloads = tmp('dlok');
  const zip = makeZip([{ name: 'index.html', data: 'ok' }]);
  const page = fakePage({
    readAttachmentBytes: () => null, // zip 因预览类型门禁返回 null
    downloadAttachment: () => { fs.writeFileSync(path.join(downloads, 'demo-preview.zip'), zip); return true; },
  });
  let picked = false;
  const r = await resolveZip({ name: 'demo-preview.zip', source: '/home/box/out/demo-preview.zip', reqId: 'r1' }, [
    ...desktopSources(chainDeps(page, { downloads })),
    { name: 'pick-file', fetch: () => { picked = true; return null; } },
  ]);
  assert.equal(r.method, 'desktop-download');
  assert.ok(r.buffer.equals(zip));
  assert.deepEqual(r.tried, ['desktop-read:skip', 'desktop-download:ok']);
  assert.deepEqual(page.calls.map((c) => c.method), ['readAttachmentBytes', 'downloadAttachment']);
  assert.deepEqual(page.calls[1].args, { path: '/home/box/out/demo-preview.zip', suggestedName: 'demo-preview.zip' });
  assert.equal(picked, false);
});

test('desktop sources: readAttachmentBytes bytes are used directly; too-large falls through', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'b' }]);
  const direct = fakePage({ readAttachmentBytes: () => ({ kind: 'bytes', bytes: new Uint8Array(zip), size: zip.length }), downloadAttachment: () => true });
  const r = await resolveZip({ name: 'a.zip', source: '/home/box/a.zip' }, desktopSources(chainDeps(direct, { downloads: tmp('d1') })));
  assert.equal(r.method, 'desktop-read');
  assert.equal(direct.calls.length, 1);
  const big = fakePage({ readAttachmentBytes: () => ({ kind: 'too-large', size: 99e6 }), downloadAttachment: () => false });
  await assert.rejects(resolveZip({ name: 'a.zip', source: '/home/box/a.zip' }, desktopSources(chainDeps(big, { downloads: tmp('d2') }))),
    (e) => e.abort === true && e.tried.join() === 'desktop-read:skip,desktop-download:用户取消');
});

test('desktop sources: user cancels the save dialog → chain stops, our picker never opens', async () => {
  const page = fakePage({ readAttachmentBytes: () => null, downloadAttachment: () => false });
  let later = 0;
  await assert.rejects(resolveZip({ name: 'a.zip', source: '/home/box/a.zip' }, [
    ...desktopSources(chainDeps(page, { downloads: tmp('d3') })),
    { name: 'downloads', fetch: () => { later++; return null; } },
    { name: 'pick-file', fetch: () => { later++; return null; } },
  ]), /用户取消/);
  assert.equal(later, 0);
  assert.equal(cancelledError().abort, true);
});

test('desktop sources: saved but not in Downloads → falls back to later sources', async () => {
  const zip = makeZip([{ name: 'index.html', data: 'p' }]);
  const page = fakePage({ readAttachmentBytes: () => null, downloadAttachment: () => true }); // 用户存到了别处
  const r = await resolveZip({ name: 'a.zip', source: '/home/box/a.zip' }, [
    ...desktopSources(chainDeps(page, { downloads: tmp('d4') })),
    { name: 'pick-file', fetch: () => zip },
  ]);
  assert.equal(r.method, 'pick-file');
  assert.deepEqual(r.tried, ['desktop-read:skip', 'desktop-download:skip', 'pick-file:ok']);
});

test('desktop sources skip https sources and paths that already exist locally', async () => {
  const page = fakePage({ readAttachmentBytes: () => { throw new Error('must not call'); }, downloadAttachment: () => { throw new Error('must not call'); } });
  const srcs = desktopSources(chainDeps(page, { downloads: tmp('d5'), exists: () => true }));
  assert.equal(await srcs[0].fetch({ name: 'a.zip', source: 'https://example.com/a.zip' }), null);
  assert.equal(await srcs[1].fetch({ name: 'a.zip', source: 'https://example.com/a.zip' }), null);
  assert.equal(await srcs[1].fetch({ name: 'a.zip', source: '/home/box/a.zip' }), null);
  assert.equal(page.calls.length, 0);
});

test('normalizeRequest keeps a safe reqId only', () => {
  assert.equal(normalizeRequest({ name: 'a.zip', reqId: 'lz3k9abc12' }).reqId, 'lz3k9abc12');
  assert.equal(normalizeRequest({ name: 'a.zip', reqId: '"]; alert(1)' }).reqId, '');
});

test('scrub removes paths from logged client errors', () => {
  assert.equal(scrub('ENOENT: open /home/box/secret/a.zip failed'), 'ENOENT: open … failed');
  assert.equal(scrub('bad C:\\Users\\me\\a.zip'), 'bad …');
});
