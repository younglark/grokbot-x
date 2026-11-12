// Find, attach to, or (with consent) relaunch the official Grok Bot with a
// loopback-only DevTools port. Shared by the Electron main process.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseClientArgs, isLoopback } from '../core/platform.mjs';
import { createLogger } from '../core/log.mjs';

const log = createLogger('client');

export async function devtoolsOk(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function pickPort(preferred) {
  if (await portFree(preferred)) return preferred;
  for (let p = preferred + 1; p <= preferred + 50; p++) if (await portFree(p)) return p;
  throw new Error(`no free loopback port near ${preferred}`);
}

/**
 * Attach to a running client or launch a new one.
 * @returns {{port:number, grokPid:number, attached:boolean}}
 */
export async function ensureClient(plat, cfg, { confirm, notify, stateDir, forceRestart = false } = {}) {
  const L = cfg.launcher || {};
  const bin = plat.findGrokBin(L.grokBotBin);
  if (!bin) {
    const msg = `没有找到官方 Grok Bot 客户端。\n已查找：\n${plat.grokCandidates(L.grokBotBin).join('\n')}\n\n请先安装 Grok Bot，或设置 GROK_BOT_BIN。`;
    notify?.('grokbot-x', msg, true);
    throw new Error('Grok Bot not found');
  }
  const ud = L.userDataDir || '';
  let port = Number(cfg.cdpPort) || 29229;

  const running = plat.mainInstances(ud);
  if (running.length && !forceRestart) {
    const p = running[0];
    const a = parseClientArgs(p.cmd);
    if (a.port && isLoopback(a.address) && await devtoolsOk(a.port)) {
      log.info(`already running (pid ${p.pid}) with DevTools on 127.0.0.1:${a.port}; attaching`);
      return { port: a.port, grokPid: p.pid, attached: true, bin };
    }
    if (a.port && !isLoopback(a.address)) {
      const msg = `Grok Bot 的调试端口绑定在 ${a.address}，不只是本机。为安全起见 grokbot-x 不会挂接。请关闭后用 grokbot-x 重新启动。`;
      notify?.('grokbot-x', msg, true);
      throw new Error('debug port not loopback');
    }
    const ok = confirm
      ? confirm('grokbot-x', 'Grok Bot 正在运行，但没有开启本机调试端口。\n\ngrokbot-x 需要重启 Grok Bot（调试端口只监听 127.0.0.1）。\n未保存的输入可能丢失。现在重启吗？', '重启', '取消')
      : false;
    if (!ok) throw new Error('user declined restart');
    log.info(`stopping Grok Bot pid ${p.pid} for relaunch`);
    if (!(await plat.stopClient(p.pid))) {
      notify?.('grokbot-x', 'Grok Bot 没有在 15 秒内退出，请手动关闭后再试。', true);
      throw new Error('client did not exit');
    }
  } else if (running.length && forceRestart) {
    log.info(`force-restart: stopping pid ${running[0].pid}`);
    await plat.stopClient(running[0].pid);
  }

  port = await pickPort(port);
  const spec = plat.launchSpec(bin, { port, userDataDir: ud, extraArgs: L.extraArgs || [] });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  log.info(`starting ${spec.command} ${spec.args.join(' ')}`);
  const out = fs.openSync(path.join(stateDir, 'grok-bot.log'), 'a');
  const child = spawn(spec.command, spec.args, { env: spec.env, detached: true, stdio: ['ignore', out, out], windowsHide: false });
  child.unref();
  fs.closeSync(out);
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 120 && !(await devtoolsOk(port)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await devtoolsOk(port))) {
    const why = exited && !spec.viaOpen
      ? 'Grok Bot 启动后立即退出。可能已有一个使用同一数据目录的实例在运行（单实例锁）。'
      : `Grok Bot 启动后调试端口 127.0.0.1:${port} 没有响应。`;
    notify?.('grokbot-x', `${why}\n日志：${path.join(stateDir, 'grok-bot.log')}`, true);
    throw new Error('devtools not reachable after launch');
  }
  const grokPid = plat.mainInstances(ud).map((p) => p.pid)[0] || (spec.viaOpen ? 0 : child.pid);
  log.info(`Grok Bot started (pid ${grokPid || 'unknown'}) DevTools 127.0.0.1:${port}`);
  return { port, grokPid, attached: false, bin };
}
