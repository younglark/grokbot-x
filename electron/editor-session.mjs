// Window lifecycle for the in-app annotation editor. No Electron imports, so
// tests can exercise open / reload / close without launching a BrowserWindow.
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
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
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
    cancel(reason) {
      finish(reason instanceof Error ? reason : new Error(reason || 'cancelled'));
    },
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

export async function resolveCloseRequest({ dirty, confirm }) {
  if (!dirty) return { close: true, prompted: false };
  try {
    const ok = await confirm();
    return { close: !!ok, prompted: true };
  } catch (error) {
    // The user already asked to close; a failed prompt must not trap them.
    return { close: true, prompted: true, error };
  }
}

export function createEditorSession(hooks) {
  const enqueue = createSerialQueue();
  let win = null;
  let allowClose = false;
  let prompting = false;

  function live() {
    return win && !hooks.isDestroyed(win) ? win : null;
  }

  function willAllowClose() {
    return allowClose || !live();
  }

  function discardCurrent() {
    const w = live();
    win = null;
    allowClose = false;
    if (!w) return;
    try { hooks.destroy(w); } catch { /* already gone */ }
  }

  async function openNow() {
    discardCurrent();
    const w = hooks.createWindow();
    win = w;
    allowClose = false;
    const ready = hooks.waitReady(w);
    try {
      await hooks.load(w);
    } catch (error) {
      ready.cancel(error);
      if (win === w) win = null;
      try { hooks.destroy(w); } catch { /* ignore */ }
      throw error;
    }
    await ready.promise;
    try { hooks.show?.(w); } catch { /* headless tests */ }
    return w;
  }

  async function requestClose() {
    const w = live();
    if (!w || allowClose) return { close: true, prompted: false };
    if (prompting) return { close: false, prompted: true };
    prompting = true;
    try {
      let dirty = false;
      try { dirty = !!(await hooks.queryDirty(w)); }
      catch { dirty = true; }
      const decision = await resolveCloseRequest({
        dirty,
        confirm: () => hooks.confirmClose(w),
      });
      if (decision.close) {
        allowClose = true;
        try { hooks.close(w); } catch {
          try { hooks.destroy(w); } catch { /* ignore */ }
        }
      }
      return decision;
    } finally {
      prompting = false;
    }
  }

  function forceClose() {
    allowClose = true;
    const w = live();
    win = null;
    if (!w) return;
    try { hooks.destroy(w); } catch { /* ignore */ }
  }

  return {
    open: () => enqueue(openNow),
    requestClose,
    willAllowClose,
    forceClose,
    current: live,
  };
}
