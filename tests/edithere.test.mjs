import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import {
  validateFilesPayload, validateCopyText, validateCopyFiles, validateImagePayload,
  sanitizeFileName, exportStamp, imageInfo, MAX_FILES,
  fillFeedbackImagePaths, collectImageDescriptors, isAbsoluteNativePath,
} from '../electron/edithere-ipc.mjs';

function loadUmd(rel) {
  const file = path.join(root, rel);
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === './image-format.js') return loadUmd('features/edithere/editor/src/image-format.js');
      throw new Error('cannot require ' + id);
    },
    globalThis: {},
    console,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'features', 'edithere', 'build', 'editor.html');
const imageFormat = loadUmd('features/edithere/editor/src/image-format.js');
const feedbackFormat = loadUmd('features/edithere/editor/src/feedback.js');

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

test('bottom tool bar carries only the two copy actions', () => {
  const html = fs.readFileSync(built, 'utf8');
  assert.doesNotMatch(html, /id="export"/, 'header 导出反馈 button must be gone');
  assert.doesNotMatch(html, /导出反馈<\/span>/);
  const tools = html.slice(html.indexOf('class="tools surface"'), html.indexOf('id="video-controls"'));
  const ids = [...tools.matchAll(/<button id="([\w-]+)" class="export-action[^"]*"([^>]*)>([^<]+)</g)];
  assert.deepEqual(ids.map((m) => m[1]), ['copy-json-main', 'copy-files-main']);
  assert.deepEqual(ids.map((m) => m[3]), ['复制 JSON 内容', '复制 JSON 与图片']);
  assert.match(tools, /id="copy-files-main" class="export-action primary"/);
  assert.doesNotMatch(tools, /id="(view-json|copy-annotated)"/);
  assert.ok(tools.indexOf('id="redo"') < tools.indexOf('id="copy-json-main"'), 'export actions follow undo/redo');
  // 查看 JSON stays reachable through the dialog (Ctrl/Cmd+E and the save menu).
  assert.match(html, /<h2>查看 JSON<\/h2>/);
  assert.match(html, /data-save-mode="view"/);
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

const SAMPLE_SHA = 'a'.repeat(64);
function fileDescriptor(name, extra = {}) {
  return {
    mode: 'file',
    file: name,
    mimeType: 'image/png',
    width: 960,
    height: 640,
    devicePixelRatio: null,
    sha256: SAMPLE_SHA,
    ...extra,
  };
}
function sampleFeedback(image) {
  return {
    annotationSpace: 'result',
    schemaVersion: 'feedback-minimal-4',
    tool: { name: 'EditHere', version: '0.13.0-grokbot-x.1' },
    image,
    objects: [],
  };
}

test('fillFeedbackImagePaths writes absolute paths for a user-picked non-ASCII dir', () => {
  const image = fileDescriptor('test-open-feedback.png', { preview: 'test-open-feedback.annotated.png' });
  const src = feedbackFormat.serialize(sampleFeedback(image));
  const dir = '/tmp/导出 目录/图片批注/20261112-160000';
  const r = fillFeedbackImagePaths(src, dir, ['test-open-feedback.json', 'test-open-feedback.png', 'test-open-feedback.annotated.png'], path.posix);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.data.image.file, 'test-open-feedback.png');
  assert.equal(r.data.image.path, `${dir}/test-open-feedback.png`);
  assert.equal(r.data.image.previewPath, `${dir}/test-open-feedback.annotated.png`);
  assert.equal(JSON.parse(r.text).image.path, r.data.image.path);
  imageFormat.validate(r.data.image);
  assert.doesNotThrow(() => feedbackFormat.normalizeImage(JSON.parse(r.text)));
});

test('fillFeedbackImagePaths uses native separators for a Windows picked dir', () => {
  const src = JSON.stringify(sampleFeedback(fileDescriptor('shot-feedback.png')));
  const dir = 'D:\\Users\\阳\\导出\\20261112-160000';
  const r = fillFeedbackImagePaths(src, dir, ['shot-feedback.png'], path.win32);
  assert.equal(r.ok, true);
  assert.equal(r.data.image.path, 'D:\\Users\\阳\\导出\\20261112-160000\\shot-feedback.png');
  imageFormat.validate(r.data.image);
  assert.doesNotThrow(() => feedbackFormat.normalizeImage(JSON.parse(r.text)));
});

test('fillFeedbackImagePaths skips descriptors whose companion was not written', () => {
  const src = JSON.stringify(sampleFeedback(fileDescriptor('missing.png')));
  const r = fillFeedbackImagePaths(src, '/tmp/exports/a', ['feedback.json'], path.posix);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.text, src);
  assert.equal(r.data.image.path, undefined);
});

test('fillFeedbackImagePaths fills each page and frame image in set/video exports', () => {
  const setDoc = {
    $schema: 'urn:edithere:image-set-feedback:1',
    schemaVersion: 'image-set-feedback-1',
    tool: { name: 'EditHere', version: '0.13.0-grokbot-x.1' },
    exportedAt: '2026-11-12T16:00:00+08:00',
    annotationSpace: 'result',
    set: { name: '组图', pageCount: 1, annotatedPageCount: 1 },
    pageIndex: [{ id: 'p1', name: '首页', index: 1, width: 960, height: 640, annotated: true, imageFile: 'page-1-home.png' }],
    pages: [{
      id: 'p1', name: '首页', index: 1, width: 960, height: 640, imageFile: 'page-1-home.png',
      feedback: sampleFeedback(fileDescriptor('page-1-home.png')),
    }],
    groupNotes: [],
  };
  const dir = '/home/user/导出/set-1';
  const r = fillFeedbackImagePaths(JSON.stringify(setDoc), dir, ['page-1-home.png'], path.posix);
  assert.equal(r.ok, true);
  assert.equal(r.data.pages[0].feedback.image.path, `${dir}/page-1-home.png`);
  assert.equal(r.data.pageIndex[0].imageFile, 'page-1-home.png');
  imageFormat.validate(r.data.pages[0].feedback.image);
  assert.doesNotThrow(() => feedbackFormat.normalizeSet(r.data));

  const videoDoc = {
    schemaVersion: 'video-feedback-1',
    tool: 'EditHere',
    exportedAt: '2026-11-12T16:00:00+08:00',
    video: { source: 'clip.mp4', durationMs: 1000, width: 960, height: 640 },
    frames: [{ id: 'f1', timestampMs: 0, timestampUs: 0, imageFile: 'frame-f1.png', feedback: sampleFeedback(fileDescriptor('frame-f1.png')) }],
    objects: [],
  };
  const v = fillFeedbackImagePaths(JSON.stringify(videoDoc), dir, ['frame-f1.png'], path.posix);
  assert.equal(v.ok, true);
  assert.equal(v.data.frames[0].feedback.image.path, `${dir}/frame-f1.png`);
  assert.doesNotThrow(() => imageFormat.validate(v.data.frames[0].feedback.image));
  assert.doesNotThrow(() => feedbackFormat.normalizeImage(v.data.frames[0].feedback));
});

test('image descriptors with path re-import, invalid paths are rejected', () => {
  const ok = fileDescriptor('a.png', { path: '/tmp/exports/a.png' });
  assert.equal(imageFormat.validate({ ...ok }).path, '/tmp/exports/a.png');
  assert.throws(() => imageFormat.validate(fileDescriptor('a.png', { path: 'exports/a.png' })));
  assert.throws(() => imageFormat.validate(fileDescriptor('a.png', { path: '/tmp/exports/other.png' })));
  assert.throws(() => imageFormat.validate({ ...fileDescriptor('a.png'), mode: 'none', path: '/tmp/exports/a.png', file: undefined }));
  const withPreview = fileDescriptor('a.png', { preview: 'a.annotated.png', path: '/tmp/a.png', previewPath: '/tmp/a.annotated.png' });
  assert.doesNotThrow(() => imageFormat.validate(withPreview));
  assert.throws(() => imageFormat.validate(fileDescriptor('a.png', { previewPath: '/tmp/a.annotated.png' })));
  assert.ok(isAbsoluteNativePath('/tmp/导出/a.png'));
  assert.ok(isAbsoluteNativePath('D:\\Users\\阳\\a.png'));
  assert.equal(isAbsoluteNativePath('relative/a.png'), false);
  assert.equal(collectImageDescriptors(sampleFeedback(ok)).length, 1);
});
