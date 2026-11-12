import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uriList, gnomeCopiedFiles, filenamesPlist, writeFileList, savedPathsFor, MAC_JXA, WIN_PS,
} from '../electron/clipboard-files.mjs';

const P = ['/tmp/x y/fb-feedback.json', '/tmp/x y/原图.png'];

test('uriList is CRLF separated and percent-encoded', () => {
  assert.equal(uriList(P), 'file:///tmp/x%20y/fb-feedback.json\r\nfile:///tmp/x%20y/%E5%8E%9F%E5%9B%BE.png\r\n');
});

test('gnomeCopiedFiles starts with copy', () => {
  assert.equal(gnomeCopiedFiles(P).split('\n')[0], 'copy');
  assert.equal(gnomeCopiedFiles(P).split('\n').length, 3);
});

test('filenamesPlist escapes and lists every path', () => {
  const s = filenamesPlist(['/a&b/<c>.json', '/d.png']);
  assert.match(s, /<string>\/a&amp;b\/&lt;c&gt;\.json<\/string><string>\/d\.png<\/string>/);
});

test('linux writes one text/uri-list buffer', async () => {
  const calls = [];
  const clipboard = { writeBuffer: (f, b) => calls.push([f, b.toString()]) };
  const r = await writeFileList(P, { clipboard, platform: 'linux' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [['text/uri-list', uriList(P)]]);
});

test('darwin passes paths as argv to osascript, falls back to plist', async () => {
  let seen;
  const ok = await writeFileList(P, { clipboard: {}, platform: 'darwin', exec: async (cmd, args) => { seen = [cmd, args]; return { ok: true }; } });
  assert.equal(ok.method, 'NSPasteboard.writeObjects');
  assert.equal(seen[0], '/usr/bin/osascript');
  assert.deepEqual(seen[1].slice(-2), P);
  assert.ok(!MAC_JXA.includes('/tmp'));
  const calls = [];
  const fb = await writeFileList(P, { clipboard: { writeBuffer: (f) => calls.push(f) }, platform: 'darwin', exec: async () => ({ ok: false, error: 'no' }) });
  assert.equal(fb.method, 'NSFilenamesPboardType');
  assert.deepEqual(calls, ['NSFilenamesPboardType']);
});

test('win32 passes paths via env, not code', async () => {
  let seen;
  const r = await writeFileList(P, { clipboard: {}, platform: 'win32', exec: async (cmd, args, opts) => { seen = { cmd, args, env: opts.env }; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(seen.cmd, 'powershell.exe');
  assert.equal(seen.env.GX_CLIP_FILES, P.join('\n'));
  assert.ok(seen.args.includes(WIN_PS));
  const bad = await writeFileList(P, { clipboard: {}, platform: 'win32', exec: async () => ({ ok: false, error: 'x' }) });
  assert.equal(bad.ok, false);
});

test('relative or empty paths are rejected', async () => {
  assert.equal((await writeFileList(['a.json'], { clipboard: {}, platform: 'linux' })).ok, false);
});

test('savedPathsFor only returns paths we saved, JSON first', () => {
  const saved = ['/e/img.png', '/e/fb.json'];
  const got = savedPathsFor([{ name: 'img.png' }, { name: 'fb.json' }, { name: 'evil.png' }], saved, () => true);
  assert.deepEqual(got, ['/e/fb.json', '/e/img.png']);
  assert.deepEqual(savedPathsFor([{ name: 'img.png' }], saved, () => false), []);
});
