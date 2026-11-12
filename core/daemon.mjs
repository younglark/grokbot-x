#!/usr/bin/env node
/**
 * grokbot-x kernel.
 *  - connects to the Grok Bot DevTools endpoint on 127.0.0.1
 *  - discovers page targets (auto-attach + periodic scan)
 *  - injects the page runtime and every enabled feature's page script
 *  - routes binding messages {feature,type,data} to the feature's daemon handler
 *    after checking the feature is enabled and the type is whitelisted
 *  - exits when the watched Grok Bot process exits
 *
 * The kernel never reads cookies, storage, or page content. Features receive a
 * narrow context and must keep DOM access scoped to their own UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CdpConnection, devtoolsVersion, evaluate } from './cdp.mjs';
import { createLogger, safeUrl } from './log.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINDING = '__grokbotXBridge';
const MAX_MESSAGE_BYTES = 64 * 1024;
const SCAN_MS = 3000;
const log = createLogger('core');

// ---------- args / config ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]];
    out[k] = v ?? 'true';
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`ignoring unreadable config ${file}: ${e.message}`);
    return null;
  }
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

function loadConfig(args) {
  const home = process.env.HOME || '/tmp';
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const userFile = args.config || process.env.GROKBOT_X_CONFIG || path.join(configHome, 'grokbot-x', 'config.json');
  let cfg = readJson(path.join(APP_DIR, 'config', 'default.json')) || {};
  cfg = deepMerge(cfg, readJson(userFile) || {});
  for (const name of String(process.env.GROKBOT_X_DISABLE || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    cfg.features = cfg.features || {};
    cfg.features[name] = { ...(cfg.features[name] || {}), enabled: false };
  }
  return { cfg, userFile };
}

// ---------- kernel ----------
class Kernel {
  constructor({ cdpPort, stateDir, grokPid, cfg }) {
    this.cdpPort = cdpPort;
    this.stateDir = stateDir;
    this.grokPid = grokPid;
    this.cfg = cfg;
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
        this.features.set(name, { mod, ctx, types: new Set(mod.messageTypes), pageScript });
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
    };
  }

  /** Feature page scripts are wrapped so each runs in its own scope after the runtime. */
  bundledPageSource() {
    const parts = [this.pageRuntime];
    for (const [name, f] of this.features) {
      if (!f.pageScript) continue;
      parts.push(`;(function(gx){try{if(!gx||!gx.register(${JSON.stringify(name)}))return;\n${f.pageScript}\n}catch(e){}})(window.__grokbotX);`);
    }
    return parts.join('\n');
  }

  async connect() {
    const ver = await devtoolsVersion(this.cdpPort);
    this.conn = new CdpConnection(ver.webSocketDebuggerUrl);
    await this.conn.connect();
    log.info(`connected to Grok Bot DevTools 127.0.0.1:${this.cdpPort} (${ver.Browser || 'unknown'})`);
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
        log.warn('Grok Bot DevTools unreachable past grace period; exiting');
        return this.shutdown(0);
      }
      try { await this.connect(); } catch (e) { log.warn(`reconnect failed: ${e.message}`); this.scheduleReconnect(); }
    }, 2000);
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
    if (!f) { log.warn(`rejected message: feature "${msg.feature.slice(0, 40)}" not enabled`); return; }
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

  watchGrok() {
    if (!this.grokPid) return;
    setInterval(() => {
      try { process.kill(this.grokPid, 0); } catch {
        log.info(`Grok Bot process ${this.grokPid} exited; stopping`);
        this.shutdown(0);
      }
    }, 2000).unref();
  }

  async shutdown(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    for (const f of this.features.values()) {
      try { await f.mod.shutdown?.(f.ctx); } catch (e) { f.ctx.log.warn(`shutdown: ${e.message}`); }
    }
    this.conn?.close();
    try {
      if (Number(fs.readFileSync(this.pidFile, 'utf8')) === process.pid) fs.unlinkSync(this.pidFile);
    } catch { /* ignore */ }
    log.info('daemon stopped (Grok Bot left running)');
    process.exit(code);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cfg, userFile } = loadConfig(args);
  const home = process.env.HOME || '/tmp';
  const stateDir = args['state-dir'] || process.env.GROKBOT_X_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'grokbot-x');
  const cdpPort = Number(args['cdp-port'] || process.env.GROK_BOT_CDP_PORT || cfg.cdpPort);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error('missing or invalid --cdp-port');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const pidFile = path.join(stateDir, 'daemon.pid');
  try {
    const old = Number(fs.readFileSync(pidFile, 'utf8'));
    if (old && old !== process.pid) { process.kill(old, 0); log.error(`already running (pid ${old})`); process.exit(3); }
  } catch { /* not running */ }
  fs.writeFileSync(pidFile, String(process.pid));

  const k = new Kernel({ cdpPort, stateDir, grokPid: Number(args['grok-pid']) || 0, cfg });
  k.pidFile = pidFile;
  process.on('SIGINT', () => k.shutdown(0));
  process.on('SIGTERM', () => k.shutdown(0));
  process.on('unhandledRejection', (e) => log.warn(`unhandledRejection: ${e?.message || e}`));
  log.info(`grokbot-x daemon pid=${process.pid} cdp=127.0.0.1:${cdpPort} state=${stateDir} config=${userFile}`);
  await k.loadFeatures();
  await k.connect();
  k.watchGrok();
  setInterval(() => k.scan(), SCAN_MS).unref();
  setInterval(() => {}, 1 << 30); // keep alive
  const st = await k.status();
  log.info(`ready; ${st.length} page(s): ${JSON.stringify(st)}`);
}

main().catch((e) => {
  log.error(`fatal: ${e.message}`);
  process.exit(1);
});
