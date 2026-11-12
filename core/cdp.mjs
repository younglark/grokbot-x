// Minimal Chrome DevTools Protocol client over a WebSocket.
// Uses the bundled `ws` package when present, otherwise Node's global WebSocket.
let WsImpl = null;
try {
  WsImpl = (await import('ws')).default;
} catch {
  WsImpl = null;
}

function openSocket(url) {
  if (WsImpl) {
    const ws = new WsImpl(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    return {
      onOpen: (fn) => ws.once('open', fn),
      onError: (fn) => ws.on('error', fn),
      onClose: (fn) => ws.on('close', fn),
      onMessage: (fn) => ws.on('message', (data) => fn(String(data))),
      send: (s) => ws.send(s),
      isOpen: () => ws.readyState === 1,
      close: () => { try { ws.close(); } catch { /* ignore */ } },
    };
  }
  const ws = new WebSocket(url);
  return {
    onOpen: (fn) => ws.addEventListener('open', fn, { once: true }),
    onError: (fn) => ws.addEventListener('error', fn),
    onClose: (fn) => ws.addEventListener('close', fn),
    onMessage: (fn) => ws.addEventListener('message', (ev) => fn(String(ev.data))),
    send: (s) => ws.send(s),
    isOpen: () => ws.readyState === 1,
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sock = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const sock = openSocket(this.wsUrl);
      this.sock = sock;
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      sock.onOpen(() => { clearTimeout(timer); resolve(this); });
      sock.onError((e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error('CDP socket error')); });
      sock.onClose(() => {
        for (const p of this.pending.values()) p.reject(new Error('CDP closed'));
        this.pending.clear();
        for (const fn of this.closeListeners) fn();
      });
      sock.onMessage((text) => {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code }));
          else p.resolve(msg.result ?? {});
        } else if (msg.method) {
          for (const fn of this.listeners) {
            try { fn(msg); } catch { /* listener errors must not kill the socket */ }
          }
        }
      });
    });
  }

  get open() { return !!this.sock && this.sock.isOpen(); }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onClose(fn) { this.closeListeners.add(fn); }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (!this.open) return Promise.reject(new Error('CDP not open'));
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.send(JSON.stringify(msg));
    });
  }

  close() { this.sock?.close(); }
}

/** Fetch /json/version from a loopback DevTools endpoint. */
export async function devtoolsVersion(port, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`DevTools HTTP ${res.status}`);
  return res.json();
}

export async function waitForDevtools(port, timeoutMs = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { return await devtoolsVersion(port); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`DevTools on 127.0.0.1:${port} not reachable: ${last?.message || 'timeout'}`);
}

/** Evaluate an expression in a CDP session and return its JSON value. */
export async function evaluate(conn, sessionId, expression, { awaitPromise = false, timeoutMs } = {}) {
  const r = await conn.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId, timeoutMs);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
  }
  return r.result?.value;
}
