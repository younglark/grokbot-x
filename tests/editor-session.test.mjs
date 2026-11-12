import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWaitReady, createSerialQueue, createEditorSession,
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
    id, destroyed: false, visible: false, closeHandler: null,
    isDestroyed() { return this.destroyed; },
    // Simulates the WM ×: runs the close handler, which may prevent the close.
    clickClose() {
      if (this.destroyed) return;
      const prevented = this.closeHandler ? this.closeHandler(this) : false;
      if (!prevented) { this.destroyed = true; this.visible = false; }
    },
  };
}

function makeHooks(opts = {}) {
  let nextId = 1;
  const loads = [];
  const windows = [];
  const changes = [];
  let session;
  const hooks = {
    windows, loads, changes,
    bind(s) { session = s; },
    createWindow() {
      const w = fakeWindow(nextId++);
      w.closeHandler = (win) => session.handleCloseRequest(win);
      windows.push(w);
      return w;
    },
    isDestroyed(w) { return !w || w.destroyed; },
    destroy(w) { w.destroyed = true; w.visible = false; },
    hide(w) { w.visible = false; },
    show(w) { w.visible = true; },
    async load(w) {
      loads.push(w.id);
      if (opts.load) return opts.load(w);
    },
    waitReady() { return { promise: Promise.resolve(true), cancel() {} }; },
    onChange() { changes.push(1); },
  };
  return hooks;
}

function newSession(opts) {
  const hooks = makeHooks(opts);
  const session = createEditorSession(hooks);
  hooks.bind(session);
  return { hooks, session };
}

test('× hides the window and does not destroy it', async () => {
  const { session } = newSession();
  const { window: w } = await session.open('sha-a');
  assert.equal(w.visible, true);
  w.clickClose();
  assert.equal(w.destroyed, false);
  assert.equal(w.visible, false);
  assert.equal(session.current(), w);
  assert.equal(session.showExisting(), true);
  assert.equal(w.visible, true);
});

test('same-image reopen reuses the hidden window with no load', async () => {
  const { hooks, session } = newSession();
  const { window: w } = await session.open('sha-a');
  w.clickClose();
  const again = await session.open('sha-a');
  assert.equal(again.reused, true);
  assert.equal(again.window, w);
  assert.equal(w.visible, true);
  assert.deepEqual(hooks.loads, [1]);
});

test('different-image reopen replaces the window', async () => {
  const { hooks, session } = newSession();
  const { window: first } = await session.open('sha-a');
  const second = await session.open('sha-b');
  assert.equal(second.reused, false);
  assert.notEqual(second.window, first);
  assert.equal(first.destroyed, true);
  assert.equal(session.imageKey(), 'sha-b');
  assert.deepEqual(hooks.loads, [1, 2]);
});

test('a destroyed window is recreated even for the same image', async () => {
  const { hooks, session } = newSession();
  const { window: w } = await session.open('sha-a');
  w.destroyed = true;
  const again = await session.open('sha-a');
  assert.equal(again.reused, false);
  assert.deepEqual(hooks.loads, [1, 2]);
});

test('quit/forceClose destroys even when hidden, and close is no longer prevented while quitting', async () => {
  const { session } = newSession();
  const { window: w } = await session.open('sha-a');
  w.clickClose();
  assert.equal(w.destroyed, false);
  session.forceClose();
  assert.equal(w.destroyed, true);
  assert.equal(session.current(), null);
  assert.equal(session.showExisting(), false);
  // After a feature re-enable, × hides again.
  const { window: w2 } = await session.open('sha-a');
  w2.clickClose();
  assert.equal(w2.destroyed, false);
  // App quit: every close goes through.
  session.markQuitting();
  w2.clickClose();
  assert.equal(w2.destroyed, true);
});

test('overlapping opens are serialized and do not hang when the first load fails', async () => {
  let first = true;
  const events = [];
  const { hooks, session } = newSession({
    async load(w) {
      events.push(`load:${w.id}`);
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('loadURL failed');
      }
    },
  });
  const a = session.open('sha-a');
  const b = session.open('sha-a');
  await assert.rejects(a, /loadURL failed/);
  const opened = await b;
  assert.equal(opened.reused, false);
  assert.equal(opened.window.id, 2);
  assert.equal(hooks.windows[0].destroyed, true);
  assert.deepEqual(events, ['load:1', 'load:2']);
});

test('serial queue keeps call order', async () => {
  const q = createSerialQueue();
  const order = [];
  const a = q(async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); return 'a'; });
  const b = q(async () => { order.push('b'); return 'b'; });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a', 'b']);
});
