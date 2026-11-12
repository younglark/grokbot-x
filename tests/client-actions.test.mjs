import test from 'node:test';
import assert from 'node:assert/strict';
import { clientMenuItems, openOfficialClient, restartOfficialClient, RESTART_CONFIRM } from '../electron/client-actions.mjs';

function fakePlat({ running = [], focusOk = true } = {}) {
  const focusCalls = [];
  return {
    focusCalls,
    mainInstances: () => running,
    focusOfficialWindow(opts) {
      focusCalls.push(opts);
      if (focusOk === 'throw') throw new Error('focus boom');
      return { ok: !!focusOk, reason: focusOk ? undefined : 'official window not found' };
    },
  };
}

test('tray items: 打开 is always present; 重启 is disabled when no process is running', () => {
  const off = clientMenuItems({ running: false });
  assert.deepEqual(off.map((i) => i.label), ['打开 Grok Bot', '重启 Grok Bot']);
  assert.equal(off[0].enabled, undefined);
  assert.equal(off[1].enabled, false);
  const on = clientMenuItems({ running: true });
  assert.equal(on[1].enabled, true);
});

test('打开 when already running and attached: focus only, no start', async () => {
  const plat = fakePlat({ running: [{ pid: 10, cmd: 'grok-bot' }] });
  let connectOpts;
  const r = await openOfficialClient({
    plat,
    status: 'connected',
    getGrokPid: () => 10,
    connect: async (opts) => { connectOpts = opts; },
    log: { warn() {}, info() {} },
  });
  assert.equal(r.started, false);
  assert.equal(r.focused, true);
  assert.equal(connectOpts, undefined);
  assert.deepEqual(plat.focusCalls, [{ pid: 10 }]);
});

test('打开 when running but not attached: attach without restart, then focus', async () => {
  const plat = fakePlat({ running: [{ pid: 11, cmd: 'grok-bot' }] });
  const connects = [];
  const r = await openOfficialClient({
    plat,
    status: 'disconnected',
    getGrokPid: () => 11,
    connect: async (opts) => { connects.push(opts); },
    log: { warn() {}, info() {} },
  });
  assert.equal(r.started, false);
  assert.equal(r.focused, true);
  assert.deepEqual(connects, [{ forceRestart: false, allowRestart: false }]);
  assert.deepEqual(plat.focusCalls, [{ pid: 11 }]);
});

test('打开 when running still focuses if attach fails', async () => {
  const plat = fakePlat({ running: [{ pid: 12, cmd: 'grok-bot' }] });
  const warnings = [];
  const r = await openOfficialClient({
    plat,
    status: 'disconnected',
    getGrokPid: () => 12,
    connect: async () => { throw new Error('debug port not loopback'); },
    log: { warn: (m) => warnings.push(m), info() {} },
  });
  assert.equal(r.started, false);
  assert.equal(r.focused, true);
  assert.ok(warnings.some((m) => /attach without restart/.test(m)));
  assert.deepEqual(plat.focusCalls, [{ pid: 12 }]);
});

test('打开 when not running: start with loopback debug port, then focus', async () => {
  const plat = fakePlat({ running: [] });
  const connects = [];
  const r = await openOfficialClient({
    plat,
    status: 'disconnected',
    getGrokPid: () => 99,
    connect: async (opts) => { connects.push(opts); },
    log: { warn() {}, info() {} },
  });
  assert.equal(r.started, true);
  assert.equal(r.focused, true);
  assert.deepEqual(connects, [{ forceRestart: false }]);
  assert.deepEqual(plat.focusCalls, [{ pid: 99 }]);
});

test('打开 logs a warning and does not throw when focus fails', async () => {
  const plat = fakePlat({ running: [{ pid: 10 }], focusOk: false });
  const warnings = [];
  const r = await openOfficialClient({
    plat, status: 'connected', getGrokPid: () => 10,
    connect: async () => { throw new Error('should not start'); },
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(r.focused, false);
  assert.match(warnings[0], /could not focus Grok Bot window/);
});

test('重启 when not running: no confirm, no connect', async () => {
  const plat = fakePlat({ running: [] });
  let confirmed = false;
  let connected = false;
  const r = await restartOfficialClient({
    plat,
    confirm: () => { confirmed = true; return true; },
    connect: async () => { connected = true; },
    log: { warn() {} },
  });
  assert.deepEqual(r, { restarted: false, reason: 'not-running' });
  assert.equal(confirmed, false);
  assert.equal(connected, false);
  assert.deepEqual(plat.focusCalls, []);
});

test('重启 cancel does nothing; confirm force-restarts', async () => {
  const plat = fakePlat({ running: [{ pid: 20 }] });
  const prompts = [];
  const cancelled = await restartOfficialClient({
    plat,
    confirm: (...args) => { prompts.push(args); return false; },
    connect: async () => { throw new Error('should not restart'); },
    getGrokPid: () => 20,
  });
  assert.deepEqual(cancelled, { restarted: false, reason: 'cancelled' });
  assert.deepEqual(prompts[0], [RESTART_CONFIRM.title, RESTART_CONFIRM.message, '重启', '取消']);
  assert.match(RESTART_CONFIRM.message, /未保存的输入可能丢失/);

  const connects = [];
  const ok = await restartOfficialClient({
    plat,
    confirm: () => true,
    connect: async (opts) => { connects.push(opts); },
    getGrokPid: () => 21,
    log: { warn() {} },
  });
  assert.equal(ok.restarted, true);
  assert.equal(ok.focused, true);
  assert.deepEqual(connects, [{ forceRestart: true }]);
  assert.deepEqual(plat.focusCalls, [{ pid: 21 }]);
});
