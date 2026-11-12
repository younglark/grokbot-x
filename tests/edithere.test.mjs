import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateFilesPayload, validateCopyText, validateCopyFiles, validateImagePayload,
  sanitizeFileName, exportStamp, imageInfo, MAX_FILES,
} from '../electron/edithere-ipc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'features', 'edithere', 'build', 'editor.html');

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

test('editor build is generated without unresolved placeholders', () => {
  if (!fs.existsSync(built)) {
    const r = spawnSync(process.execPath, [path.join(root, 'features/edithere/editor/build.mjs')], {
      encoding: 'utf8', cwd: root,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }
  const html = fs.readFileSync(built, 'utf8');
  assert.match(html, /0\.13\.0-grokbot-x\.1/);
  assert.doesNotMatch(html, /\/\*__[A-Z0-9_]+__\*\//);
  assert.match(html, /<title>图片批注<\/title>/);
  assert.match(html, /id="host-bar"/);
  assert.match(html, /host-export-path/);
  assert.doesNotMatch(html, /edithere-lockup/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /派生自 EditHere/);
  assert.match(html, /GrokbotXEditorHooks/);
  assert.equal((html.match(/EDITHERE_PRODUCT_VERSION\s*=/g) || []).length, 1, 'version must be declared only once in the shared classic-script scope');
  assert.match(html, /applyHostInfo/);

});

test('built HTML inlines every referenced shared icon', () => {
  const html = fs.readFileSync(built, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'features/edithere/editor/assets/ui-icons/manifest.json'), 'utf8'));
  for (const icon of manifest.icons) {
    assert.ok(html.includes(`id="i-${icon.id}"`), `missing symbol i-${icon.id}`);
  }
  const refs = new Set([...html.matchAll(/#i-([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const known = new Set(manifest.icons.map((i) => i.id));
  for (const id of refs) assert.ok(known.has(id), `unknown icon reference #i-${id}`);
});

test('sanitizeFileName strips paths and illegal characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\\\tmp\\\\a.png'), 'a.png');
  assert.equal(sanitizeFileName('反馈 图.png'), '反馈_图.png');
  assert.equal(sanitizeFileName(''), '');
  assert.equal(sanitizeFileName('..'), '');
});

test('validateFilesPayload accepts a well-formed JSON+PNG export', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  const r = validateFilesPayload({
    kind: 'feedback',
    reveal: true,
    files: [
      { name: 'demo-feedback.json', mime: 'application/json', base64: b64('{"ok":true}') },
      { name: 'demo.png', mime: 'image/png', base64: b64(png) },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].name, 'demo-feedback.json');
  assert.equal(r.reveal, true);
});

test('validateFilesPayload rejects path traversal, bad kind, bad mime, empty and oversized lists', () => {
  const okFile = { name: 'a.json', mime: 'application/json', base64: b64('{}') };
  assert.equal(validateFilesPayload(null).ok, false);
  assert.equal(validateFilesPayload({ kind: 'wire-agent', files: [okFile] }).ok, false);
  const escaped = validateFilesPayload({ files: [{ name: '../x.json', mime: 'application/json', base64: b64('{}') }] });
  assert.equal(escaped.ok, true);
  assert.equal(escaped.files[0].name, 'x.json');
  assert.equal(validateFilesPayload({ files: [{ name: 'a.json', mime: 'text/html', base64: b64('{}') }] }).ok, false);
  assert.equal(validateFilesPayload({ files: [{ name: 'a.json', mime: 'application/json', base64: '@@@' }] }).ok, false);
  assert.equal(validateFilesPayload({ files: [{ name: 'a.json', mime: 'application/json', base64: '' }] }).ok, false);
  assert.equal(validateFilesPayload({ files: [] }).ok, false);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.json`, mime: 'application/json', base64: b64('{}') }));
  assert.equal(validateFilesPayload({ files: many }).ok, false);
  assert.equal(validateFilesPayload({ files: [okFile, { ...okFile }] }).ok, false);
});

test('validateCopyText and validateCopyFiles', () => {
  assert.equal(validateCopyText({ text: '{"a":1}' }).ok, true);
  assert.equal(validateCopyText({ text: 1 }).ok, false);
  assert.equal(validateCopyText({ text: 'x'.repeat(20 * 1024 * 1024 + 1) }).ok, false);
  const files = { files: [{ name: 'a.json', mime: 'application/json', base64: b64('{}') }] };
  assert.equal(validateCopyFiles(files).ok, true);
  assert.equal(validateCopyFiles({ files: [] }).ok, false);
});

test('validateImagePayload only accepts base64 image data URLs', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  const ok = validateImagePayload({
    name: 't.png',
    dataUrl: `data:image/png;base64,${b64(png)}`,
    width: 1,
    height: 1,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.width, 1);
  assert.equal(validateImagePayload({ dataUrl: 'https://example.com/x.png' }).ok, false);
  assert.equal(validateImagePayload({ dataUrl: 'data:text/plain;base64,YQ==' }).ok, false);
  assert.equal(validateImagePayload({ dataUrl: 'data:image/png;base64,@@@' }).ok, false);
});

test('imageInfo reads PNG dimensions and exportStamp is Asia/Shanghai compact form', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000002000000030802000000d8dc7e0c',
    'hex',
  );
  // 2x3 header only; height/width at standard offsets still parse
  const full = Buffer.alloc(33);
  png.copy(full);
  const info = imageInfo(full);
  assert.equal(info.fmt, 'png');
  assert.equal(info.w, 2);
  assert.equal(info.h, 3);
  assert.match(exportStamp(new Date('2026-11-12T07:08:09Z')), /^\d{8}-\d{6}$/);
});
