/**
 * grokbot-x kernel: CDP attach, injection, and feature-message routing.
 * Used by the Electron main process. Never reads cookies, storage, or page content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { CdpConnection, devtoolsVersion, evaluate } from './cdp.mjs';
import { createLogger, safeUrl } from './log.mjs';
import { APP_DIR } from './config.mjs';
import { makePlatform } from './platform.mjs';

const BINDING = '__grokbotXBridge';
const MAX_MESSAGE_BYTES = 64 * 1024;
export const SCAN_MS = 3000;
const log = createLogger('core');

// ---------- kernel ----------
export class Kernel extends EventEmitter {
  static BINDING = BINDING;

  constructor({ cdpPort, stateDir, grokPid, cfg, plat }) {
    super();
    this.cdpPort = cdpPort;
    this.stateDir = stateDir;
    this.grokPid = grokPid;
    this.cfg = cfg;
    this.plat = plat || makePlatform();
    this.conn = null;
    this.sessions = new Map(); // sessionId -> { targetId, url }
    this.attached = new Set(); // targetIds
    this.attaching = new Map();
    this.features = new Map(); // name -> { mod, ctx, types:Set, pageScript }
    this.pageRuntime = fs.readFileSync(path.join(APP_DIR, 'core', 'page-runtime.js'), 'utf8')
      .replace('__GROKBOTX_BINDING__', BINDING);
    this.stopping = false;
    this.reconnectTimer = null;
    this.lostSince = 0;
    this.scanTimer = null;
  }

  async loadFeatures() {
    const dir = path.join(APP_DIR, 'features');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)).sort() : [];
    for (const name of names) {
      const fcfg = this.cfg.features?.[name] || {};
      if (fcfg.enabled === false) { log.info(`feature ${name}: disabled by config`); continue; }
      const entry = path.join(dir, name, 'feature.mjs');
      if (!fs.existsSync(entry)) continue;
      try {
        const mod = (await import(pathToFileURL(entry).href)).default;
        if (!mod || mod.name !== name || !Array.isArray(mod.messageTypes)) throw new Error('invalid feature manifest');
        const pageScript = mod.pageScript ? fs.readFileSync(path.join(dir, name, mod.pageScript), 'utf8') : '';
        const ctx = this.makeContext(name, fcfg, path.join(dir, name));
        if (mod.init) await mod.init(ctx);
        this.features.set(name, { mod, ctx, types: new Set(mod.messageTypes), pageScript, enabled: fcfg.enabled !== false });
        log.info(`feature ${name}: enabled (messages: ${mod.messageTypes.join(', ') || 'none'})`);
      } catch (e) {
        log.error(`feature ${name}: failed to load: ${e.message}`);
      }
    }
  }

  makeContext(name, fcfg, featureDir) {
    const flog = createLogger(`feature:${name}`);
    const stateDir = path.join(this.stateDir, 'features', name);
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      name,
      config: fcfg,
      featureDir,
      appDir: APP_DIR,
      stateDir,
      log: flog,
      /** Send a CDP command into the page session the message came from. */
      cdp: (method, params, sessionId, timeoutMs) => this.conn.send(method, params, sessionId, timeoutMs),
      evaluate: (sessionId, expr, opts) => evaluate(this.conn, sessionId, expr, opts),
      safeUrl,
      platform: this.plat,
    };
  }

  /** Feature page scripts are wrapped so each runs in its own scope after the runtime. */
  bundledPageSource() {
    const parts = [this.pageRuntime];
    for (const [name, f] of this.features) {
      if (!f.pageScript || f.enabled === false) continue;
      parts.push(`;(function(gx){try{if(!gx||!gx.register(${JSON.stringify(name)}))return;\n${f.pageScript}\n}catch(e){}})(window.__grokbotX);`);
    }
    return parts.join('\n');
  }

  async connect() {
    const ver = await devtoolsVersion(this.cdpPort);
    this.conn = new CdpConnection(ver.webSocketDebuggerUrl);
    await this.conn.connect();
    this.emit('connecting');
    log.info(`connected to Grok Bot DevTools 127.0.0.1:${this.cdpPort} (${ver.Browser || 'unknown'})`);
    this.emit('connected', { port: this.cdpPort, browser: ver.Browser });
    this.lostSince = 0;
    this.conn.onEvent((m) => this.onEvent(m));
    this.conn.onClose(() => {
      if (this.stopping) return;
      log.warn('DevTools socket closed');
      this.sessions.clear();
      this.attached.clear();
      this.lostSince ||= Date.now();
      this.scheduleReconnect();
    });
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    await this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await this.scan();
    await this.settle();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const graceMs = (this.cfg.reconnectGraceSeconds ?? 30) * 1000;
      if (this.lostSince && Date.now() - this.lostSince > graceMs) {
        log.warn('Grok Bot DevTools unreachable past grace period');
        this.emit('disconnected', { reason: 'timeout' });
        return;
      }
      try { await this.connect(); } catch (e) { log.warn(`reconnect failed: ${e.message}`); this.scheduleReconnect(); }
    }, 2000);
  }

  startScanning() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.scan().catch(() => {}), SCAN_MS);
    this.scanTimer.unref?.();
  }

  async settle() {
    for (let i = 0; i < 30 && this.attaching.size; i++) await new Promise((r) => setTimeout(r, 100));
  }

  async scan() {
    if (!this.conn?.open) return;
    try {
      const { targetInfos } = await this.conn.send('Target.getTargets');
      await Promise.all((targetInfos || []).map((t) => this.attach(t)));
    } catch (e) {
      log.warn(`target scan failed: ${e.message}`);
    }
  }

  attach(info, sessionId, waiting) {
    const id = info.targetId;
    if (info.type !== 'page') return;
    if (/^(devtools|chrome-extension|chrome):/i.test(info.url || '')) return;
    if (this.attached.has(id)) return;
    if (this.attaching.has(id)) return this.attaching.get(id);
    const job = this.attachNow(info, sessionId, waiting).finally(() => this.attaching.delete(id));
    this.attaching.set(id, job);
    return job;
  }

  async attachNow(info, sessionId, waiting) {
    const id = info.targetId;
    try {
      if (!sessionId) sessionId = (await this.conn.send('Target.attachToTarget', { targetId: id, flatten: true })).sessionId;
      this.attached.add(id);
      this.sessions.set(sessionId, { targetId: id, url: info.url });
      const src = this.bundledPageSource();
      await this.conn.send('Runtime.enable', {}, sessionId);
      await this.conn.send('Runtime.addBinding', { name: BINDING }, sessionId);
      await this.conn.send('Page.enable', {}, sessionId);
      for (const f of this.features.values()) if (f.mod.onAttach) await f.mod.onAttach(f.ctx, { sessionId });
      await this.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
      if (waiting) await this.conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      const ok = await evaluate(this.conn, sessionId, `${src}\n;!!(window.__grokbotX && window.__grokbotX.v === 1)`);
      log.info(`attached page ${id.slice(0, 8)} injected=${ok} url=${safeUrl(info.url)}`);
    } catch (e) {
      log.warn(`attach ${id.slice(0, 8)} failed: ${e.message}`);
      this.attached.delete(id);
    }
  }

  onEvent(m) {
    const { method, params, sessionId } = m;
    switch (method) {
      case 'Target.attachedToTarget':
        this.attach(params.targetInfo, params.sessionId, params.waitingForDebugger);
        return;
      case 'Target.targetCreated':
        this.attach(params.targetInfo);
        return;
      case 'Target.detachedFromTarget': {
        const s = this.sessions.get(params.sessionId);
        if (s) { this.sessions.delete(params.sessionId); this.attached.delete(s.targetId); }
        for (const f of this.features.values()) f.mod.onDetach?.(f.ctx, { sessionId: params.sessionId });
        return;
      }
      case 'Runtime.bindingCalled':
        if (params?.name === BINDING) this.route(sessionId, params.payload);
        return;
      default:
        for (const f of this.features.values()) {
          if (f.mod.onCdpEvent) {
            try { f.mod.onCdpEvent(f.ctx, m); } catch (e) { f.ctx.log.warn(`onCdpEvent: ${e.message}`); }
          }
        }
    }
  }

  async route(sessionId, payload) {
    if (typeof payload !== 'string' || payload.length > MAX_MESSAGE_BYTES) {
      log.warn('rejected message: missing or oversized payload');
      return;
    }
    let msg;
    try { msg = JSON.parse(payload); } catch { log.warn('rejected message: not JSON'); return; }
    if (!msg || msg.v !== 1 || typeof msg.feature !== 'string' || typeof msg.type !== 'string') {
      log.warn('rejected message: bad envelope');
      return;
    }
    const f = this.features.get(msg.feature);
    if (!f || f.enabled === false) { log.warn(`rejected message: feature "${msg.feature.slice(0, 40)}" not enabled`); return; }
    if (!f.types.has(msg.type)) { log.warn(`rejected message: ${msg.feature}/${msg.type.slice(0, 40)} not whitelisted`); return; }
    try {
      await f.mod.onMessage(f.ctx, { sessionId, type: msg.type, data: msg.data });
    } catch (e) {
      f.ctx.log.error(`${msg.type} failed: ${e.message}`);
    }
  }

  async status() {
    const out = [];
    for (const [sid, s] of this.sessions) {
      try {
        const v = await evaluate(this.conn, sid, `({runtime: !!(window.__grokbotX && window.__grokbotX.v===1), binding: typeof window.${BINDING}==='function', features: ${JSON.stringify([...this.features.keys()])}.filter(n => window.__grokbotX && window.__grokbotX.has(n))})`);
        out.push({ target: s.targetId.slice(0, 8), ...v });
      } catch (e) {
        out.push({ target: s.targetId.slice(0, 8), error: e.message });
      }
    }
    return out;
  }

  watchStopRequest() {
    const f = path.join(this.stateDir, 'stop.request');
    try { fs.unlinkSync(f); } catch { /* none */ }
    setInterval(() => {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
        log.info('stop requested');
        this.shutdown(0);
      }
    }, 500).unref();
  }

  watchGrok() {
    if (!this.grokPid) return;
    setInterval(() => {
      try { process.kill(this.grokPid, 0); } catch {
        log.info(`Grok Bot process ${this.grokPid} exited`);
        this.grokPid = 0;
        this.emit('client-exited');
      }
    }, 2000).unref();
  }

  async shutdown(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const f of this.features.values()) {
      try { await f.mod.shutdown?.(f.ctx); } catch (e) { f.ctx.log.warn(`shutdown: ${e.message}`); }
    }
    this.conn?.close();
    try {
      if (Number(fs.readFileSync(this.pidFile, 'utf8')) === process.pid) fs.unlinkSync(this.pidFile);
    } catch { /* ignore */ }
    log.info('kernel stopped (Grok Bot left running)');
    this.emit('stopped');
  }

  get connected() { return !!this.conn?.open; }

  async setFeatureEnabled(name, enabled) {
    this.cfg.features = this.cfg.features || {};
    this.cfg.features[name] = { ...(this.cfg.features[name] || {}), enabled };
    const f = this.features.get(name);
    if (f) f.enabled = enabled;
    if (!enabled && this.conn?.open) {
      const expr = `document.querySelectorAll('[data-grokbotx-feature="${name}"]').forEach((n)=>n.remove())`;
      for (const sid of this.sessions.keys()) {
        try { await evaluate(this.conn, sid, expr); } catch { /* ignore */ }
      }
    }
    this.emit('features-changed');
  }
}

