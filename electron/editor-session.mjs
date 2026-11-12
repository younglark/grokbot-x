// Window lifecycle for the in-app annotation editor. No Electron imports, so
// tests can exercise open / hide / reopen / quit without a BrowserWindow.
//
// × hides the window and keeps the page (annotations, undo, zoom) in memory.
// Only forceClose() (app quit, feature disable) destroys it.
export function createWaitReady({
  subscribe,
  timeoutMs = 20000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof subscribe !== 'function') throw new Error('subscribe required');
  let settled = false;
  let timer;
  let unsubscribe = () => {};
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  function finish(err) {
    if (settled) return;
    settled = true;
    if (timer != null) clearTimeoutFn(timer);
    try { unsubscribe(); } catch { /* ignore */ }
    if (err) reject(err instanceof Error ? err : new Error(String(err)));
    else resolve(true);
  }
  timer = setTimeoutFn(() => finish(new Error('editor page did not become ready')), timeoutMs);
  unsubscribe = subscribe(() => finish()) || (() => {});
  return {
    promise,
    cancel(reason) { finish(reason instanceof Error ? reason : new Error(reason || 'cancelled')); },
  };
}

export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const job = tail.then(() => fn(), () => fn());
    tail = job.then(() => undefined, () => undefined);
    return job;
  };
}

export function createEditorSession(hooks) {
  const enqueue = createSerialQueue();
  let win = null;
  let imageKey = null;
  let quitting = false;
  const notify = () => { try { hooks.onChange?.(); } catch { /* ignore */ } };

  function live() {
    return win && !hooks.isDestroyed(win) ? win : null;
  }

  function discardCurrent() {
    const w = live();
    win = null;
    imageKey = null;
    if (w) { try { hooks.destroy(w); } catch { /* already gone */ } }
  }

  async function openNow(key) {
    const existing = live();
    if (existing && key && imageKey === key) {
      try { hooks.show(existing); } catch { /* headless */ }
      notify();
      return { window: existing, reused: true };
    }
    discardCurrent();
    const w = hooks.createWindow();
    win = w;
    const ready = hooks.waitReady(w);
    try {
      await hooks.load(w);
    } catch (error) {
      ready.cancel(error);
      if (win === w) win = null;
      try { hooks.destroy(w); } catch { /* ignore */ }
      notify();
      throw error;
    }
    try {
      await ready.promise;
    } catch (error) {
      if (win === w) win = null;
      try { hooks.destroy(w); } catch { /* ignore */ }
      notify();
      throw error;
    }
    imageKey = key || null;
    try { hooks.show(w); } catch { /* headless */ }
    notify();
    return { window: w, reused: false };
  }

  /** Called from the window 'close' event. Returns true when close must be prevented. */
  function handleCloseRequest(w) {
    if (quitting || !w || hooks.isDestroyed(w)) return false;
    try { hooks.hide(w); } catch { /* ignore */ }
    notify();
    return true;
  }

  function showExisting() {
    const w = live();
    if (!w) return false;
    try { hooks.show(w); } catch { /* ignore */ }
    notify();
    return true;
  }

  // destroy() does not emit 'close', so the hide handler cannot block it. The
  // flag only covers a close event that races with teardown; it is cleared so a
  // re-enabled feature gets hide-on-close again.
  function forceClose() {
    quitting = true;
    try { discardCurrent(); } finally { quitting = false; }
    notify();
  }

  /** App is quitting: from now on every close goes through. */
  function markQuitting() { quitting = true; }

  return {
    open: (key) => enqueue(() => openNow(key)),
    handleCloseRequest,
    showExisting,
    forceClose,
    markQuitting,
    current: live,
    imageKey: () => imageKey,
    isQuitting: () => quitting,
  };
}
