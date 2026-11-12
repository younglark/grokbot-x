import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWaitReady, createSerialQueue, resolveCloseRequest, createEditorSession,
} from '../electron/editor-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = path.join(root, 'features/edithere/editor/src/app.js');
const built = path.join(root, 'features/edithere/build/editor.html');

test('host/Electron path does not register a blocking beforeunload', () => {
  const src = fs.readFileSync(appSrc, 'utf8');
  assert.match(src, /if\s*\(\s*!globalThis\.grokbotX\s*\)\s*window\.addEventListener\(\s*'beforeunload'/);
  assert.doesNotMatch(src, /(?<!if\s*\(\s*!globalThis\.grokbotX\s*\))window\.addEventListener\(\s*'beforeunload'/);
  const html = fs.readFileSync(built, 'utf8');
  assert.match(html, /if\s*\(\s*!globalThis\.grokbotX\s*\)\s*window\.addEventListener\(\s*'beforeunload'/);
  assert.match(html, /GrokbotXEditorHooks/);
  assert.match(html, /isDirty\s*\(\s*\)\s*\{return !!dirty;\}/);
});

test('createWaitReady resolves, cancels a timeout, and does not reject twice', async () => {
  const listeners = new Set();
  const timers = [];
  const ready = createWaitReady({
    timeoutMs: 50,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setTimeoutFn(fn, ms) {
      const id = { fn, ms };
      timers.push(id);
      return id;
    },
    clearTimeoutFn(id) { id.cleared = true; },
  });
  listeners.forEach((cb) => cb());
  await ready.promise;
  assert.equal(listeners.size, 0);
  assert.equal(timers[0].cleared, true);
  ready.cancel('too late');
  await assert.doesNotReject(ready.promise);
});

test('createWaitReady cancel rejects immediately and unsubscribes', async () => {
  const listeners = new Set();
  const ready = createWaitReady({
    timeoutMs: 60_000,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setTimeoutFn() { return 1; },
    clearTimeoutFn() {},
  });
  ready.cancel(new Error('loadURL failed'));
  await assert.rejects(ready.promise, /loadURL failed/);
  assert.equal(listeners.size, 0);
});

function fakeWindow(id) {
  return {
    id,
    destroyed: false,
    closed: false,
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; this.closed = true; },
    close() { this.closed = true; this.destroyed = true; },
  };
}

function makeHooks(opts = {}) {
  let nextId = 1;
  const loads = [];
  const destroys = [];
  const windows = [];
  let dirty = opts.dirty ?? false;
  let confirm = opts.confirm ?? (async () => true);
  const loadImpl = opts.load;
  const hooks = {
    windows,
    loads,
    destroys,
    setDirty(v) { dirty = v; },
    setConfirm(fn) { confirm = fn; },
    createWindow() {
      const w = fakeWindow(nextId++);
      windows.push(w);
      return w;
    },
    isDestroyed(w) { return !w || w.destroyed; },
    destroy(w) { destroys.push(w.id); w.destroy(); },
    close(w) { w.close(); },
    async load(w) {
      loads.push(w.id);
      if (loadImpl) return loadImpl(w);
    },
    waitReady(w) {
      if (opts.readyMode === 'manual') {
        let trigger;
        const promise = new Promise((resolve, reject) => {
          trigger = { resolve, reject };
        });
        w._ready = trigger;
        return {
          promise,
          cancel(reason) { trigger.reject(reason instanceof Error ? reason : new Error(reason || 'cancelled')); },
        };
      }
      return {
        promise: Promise.resolve(true),
        cancel() {},
      };
    },
    async queryDirty() {
      if (opts.queryError) throw new Error('query failed');
      return dirty;
    },
    confirmClose() { return confirm(); },
    show() {},
  };
  return hooks;
}

test('a second openEditor succeeds while a session is already loaded', async () => {
  const hooks = makeHooks();
  const session = createEditorSession(hooks);
  const first = await session.open();
  assert.equal(first.id, 1);
  assert.equal(session.current().id, 1);
  const second = await session.open();
  assert.equal(second.id, 2);
  assert.equal(session.current().id, 2);
  assert.equal(hooks.windows[0].destroyed, true);
  assert.equal(hooks.destroys[0], 1);
  assert.deepEqual(hooks.loads, [1, 2]);
});

test('overlapping opens are serialized and do not hang when the first load fails', async () => {
  let first = true;
  let startedSecond = false;
  const events = [];
  const hooks = makeHooks({
    async load(w) {
      events.push(`load:${w.id}`);
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('loadURL failed');
      }
      startedSecond = true;
    },
  });
  const session = createEditorSession(hooks);
  const a = session.open();
  const b = session.open();
  await assert.rejects(a, /loadURL failed/);
  const opened = await b;
  assert.equal(opened.id, 2);
  assert.equal(startedSecond, true);
  assert.equal(hooks.windows[0].destroyed, true);
  assert.equal(session.current().id, 2);
  assert.deepEqual(events, ['load:1', 'load:2']);
});

test('close is not stuck: clean close, dirty cancel, dirty confirm, failed query', async () => {
  const hooks = makeHooks({ dirty: false });
  const session = createEditorSession(hooks);
  const w = await session.open();

  let decision = await session.requestClose();
  assert.equal(decision.close, true);
  assert.equal(decision.prompted, false);
  assert.equal(w.closed, true);

  hooks.setDirty(true);
  hooks.setConfirm(async () => false);
  const w2 = await session.open();
  decision = await session.requestClose();
  assert.equal(decision.close, false);
  assert.equal(decision.prompted, true);
  assert.equal(w2.closed, false);
  assert.equal(session.current().id, w2.id);

  hooks.setConfirm(async () => true);
  decision = await session.requestClose();
  assert.equal(decision.close, true);
  assert.equal(decision.prompted, true);
  assert.equal(w2.closed, true);
});

test('close still proceeds when the dirty query or confirm dialog fails', async () => {
  const hooks = makeHooks({ queryError: true, confirm: async () => { throw new Error('no dialog'); } });
  const session = createEditorSession(hooks);
  const w = await session.open();
  const decision = await session.requestClose();
  assert.equal(decision.close, true);
  assert.equal(decision.prompted, true);
  assert.equal(w.closed, true);
});

test('resolveCloseRequest and the serial queue helpers', async () => {
  assert.deepEqual(await resolveCloseRequest({ dirty: false, confirm: async () => false }), { close: true, prompted: false });
  assert.deepEqual(await resolveCloseRequest({ dirty: true, confirm: async () => true }), { close: true, prompted: true });
  assert.deepEqual(await resolveCloseRequest({ dirty: true, confirm: async () => false }), { close: false, prompted: true });
  const q = createSerialQueue();
  const order = [];
  const a = q(async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); return 'a'; });
  const b = q(async () => { order.push('b'); return 'b'; });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a', 'b']);
});
