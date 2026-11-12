import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { updateSupport, attachUpdater, UPDATE_CHECK_INTERVAL_MS } from '../electron/updater.mjs';

test('updateSupport skips unpackaged / dev builds', () => {
  const r = updateSupport({ isPackaged: false, platform: 'linux', env: { APPIMAGE: '/tmp/x.AppImage' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-packaged');
  assert.match(r.message, /打包版/);
});

test('updateSupport skips Linux when not running as AppImage', () => {
  const deb = updateSupport({ isPackaged: true, platform: 'linux', env: {} });
  assert.equal(deb.ok, false);
  assert.equal(deb.reason, 'linux-not-appimage');
  assert.match(deb.message, /AppImage/);
  const empty = updateSupport({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '' } });
  assert.equal(empty.ok, false);
});

test('updateSupport allows packaged AppImage, Windows, and macOS', () => {
  assert.equal(updateSupport({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/home/u/grokbot-x.AppImage' } }).ok, true);
  assert.equal(updateSupport({ isPackaged: true, platform: 'win32', env: {} }).ok, true);
  assert.equal(updateSupport({ isPackaged: true, platform: 'darwin', env: {} }).ok, true);
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

function mockUpdater() {
  const au = new EventEmitter();
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.checkCalls = 0;
  au.quitCalls = 0;
  au.checkForUpdates = async () => {
    au.checkCalls += 1;
    return { updateInfo: { version: '0.2.0' } };
  };
  au.quitAndInstall = () => { au.quitCalls += 1; };
  return au;
}

test('attachUpdater configures autoDownload and checks on start', async () => {
  const au = mockUpdater();
  const logs = [];
  const api = attachUpdater({
    autoUpdater: au,
    notify() {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    intervalMs: 60 * 60 * 1000,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.checkCalls, 1);
  assert.equal(api.enabled, true);
  api.stop();
});

test('update-available notifies; errors are logged only', async () => {
  const au = mockUpdater();
  const notes = [];
  const logs = [];
  const api = attachUpdater({
    autoUpdater: au,
    notify: (t, b) => notes.push([t, b]),
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    log: { info() {}, error: (m) => logs.push(m) },
    intervalMs: 60 * 60 * 1000,
  });
  au.emit('update-available', { version: '0.3.0' });
  au.emit('error', new Error('network down'));
  au.emit('update-not-available', { version: '0.2.0' });
  assert.equal(notes.length, 1);
  assert.match(notes[0][1], /0\.3\.0/);
  assert.match(notes[0][1], /后台下载/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /network down/);
  api.stop();
});

test('manual check notifies when already up to date', async () => {
  const au = mockUpdater();
  const notes = [];
  const api = attachUpdater({
    autoUpdater: au,
    notify: (t, b) => notes.push(b),
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    log: { info() {}, error() {} },
    intervalMs: 60 * 60 * 1000,
  });
  await api.checkNow({ manual: true });
  au.emit('update-not-available', { version: '0.2.0' });
  assert.ok(notes.some((n) => /已是最新版本/.test(n)));
  api.stop();
});

test('update-downloaded restarts only when the user confirms', async () => {
  const au = mockUpdater();
  let installs = 0;
  const api = attachUpdater({
    autoUpdater: au,
    notify() {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    log: { info() {}, error() {} },
    onQuitAndInstall: async () => { installs += 1; },
    intervalMs: 60 * 60 * 1000,
  });
  au.emit('update-downloaded', { version: '0.3.0' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(installs, 0);
  assert.equal(api.isInstalling(), false);

  const au2 = mockUpdater();
  const boxes = [];
  let installs2 = 0;
  const api2 = attachUpdater({
    autoUpdater: au2,
    notify() {},
    dialog: {
      showMessageBox: async (opts) => {
        boxes.push(opts);
        return { response: 0 };
      },
    },
    log: { info() {}, error() {} },
    onQuitAndInstall: async () => { installs2 += 1; },
    intervalMs: 60 * 60 * 1000,
  });
  au2.emit('update-downloaded', { version: '0.3.0' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(installs2, 1);
  assert.equal(api2.isInstalling(), true);
  assert.deepEqual(boxes[0].buttons, ['现在重启安装', '稍后']);
  assert.match(boxes[0].message, /0\.3\.0/);
  api.stop();
  api2.stop();
});
