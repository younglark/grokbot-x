// Platform-specific behaviour for grokbot-x: paths, client discovery, running
// instances, dialogs, and browser discovery. Every function takes an explicit
// environment so the branches can be unit-tested on any OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const APP_NAME = 'grokbot-x';
export const GROK_BUNDLE_ID = 'com.anysphere.sand'; // macOS bundle id and Windows AppUserModelID of the official client

/** Build a platform helper. `sys` overrides are for tests. */
export function makePlatform(sys = {}) {
  const platform = sys.platform || process.platform;
  const env = sys.env || process.env;
  const home = sys.home || os.homedir();
  const exists = sys.exists || ((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
  const isFile = sys.isFile || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const readdir = sys.readdir || ((p) => { try { return fs.readdirSync(p); } catch { return []; } });
  const which = sys.which || ((name) => whichImpl(name, platform, env, isFile));
  const P = platform === 'win32' ? path.win32 : path.posix;

  const winLocal = env.LOCALAPPDATA || P.join(home, 'AppData', 'Local');
  const winRoaming = env.APPDATA || P.join(home, 'AppData', 'Roaming');
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  function stateDir() {
    if (env.GROKBOT_X_STATE_DIR) return env.GROKBOT_X_STATE_DIR;
    if (platform === 'win32') return P.join(winLocal, APP_NAME);
    if (platform === 'darwin') return P.join(home, 'Library', 'Application Support', APP_NAME);
    return P.join(env.XDG_STATE_HOME || P.join(home, '.local', 'state'), APP_NAME);
  }

  function configDir() {
    if (env.GROKBOT_X_CONFIG_DIR) return env.GROKBOT_X_CONFIG_DIR;
    if (platform === 'win32') return P.join(winRoaming, APP_NAME);
    if (platform === 'darwin') return P.join(home, 'Library', 'Application Support', APP_NAME);
    return P.join(env.XDG_CONFIG_HOME || P.join(home, '.config'), APP_NAME);
  }

  /** Candidate official-client executables, most specific first. */
  function grokCandidates(configured) {
    const out = [];
    if (env.GROK_BOT_BIN) out.push(env.GROK_BOT_BIN);
    if (configured) out.push(configured);
    if (platform === 'win32') {
      out.push(P.join(winLocal, 'Programs', 'Grok Bot', 'Grok Bot.exe'));
      out.push(P.join(pf, 'Grok Bot', 'Grok Bot.exe'));
    } else if (platform === 'darwin') {
      out.push('/Applications/Grok Bot.app/Contents/MacOS/Grok Bot');
      out.push(P.join(home, 'Applications', 'Grok Bot.app', 'Contents', 'MacOS', 'Grok Bot'));
    } else {
      out.push('/opt/Grok Bot/grok-bot', '/usr/bin/grok-bot', '/opt/grok-bot/grok-bot');
      const appDir = P.join(home, 'Applications');
      for (const f of readdir(appDir).sort()) {
        if (/grok.?bot.*\.appimage$/i.test(f)) out.push(P.join(appDir, f));
      }
    }
    return out;
  }

  function findGrokBin(configured) {
    for (const c of grokCandidates(configured)) {
      if (!c) continue;
      if (platform === 'darwin' && c.endsWith('.app')) {
        const inner = P.join(c, 'Contents', 'MacOS', 'Grok Bot');
        if (isFile(inner)) return inner;
        continue;
      }
      if (isFile(c)) return realpath(c);
    }
    return null;
  }

  /** The .app bundle that contains a macOS executable path, if any. */
  function macAppBundle(bin) {
    const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(bin || '');
    return m ? m[1] : null;
  }

  function looksLikeGrokExe(exe) {
    if (!exe) return false;
    const base = P.basename(exe.replace(/\\/g, platform === 'win32' ? '\\' : '/'));
    if (platform === 'win32') return /^grok bot\.exe$/i.test(base);
    if (platform === 'darwin') return /\/Grok Bot\.app\/Contents\/MacOS\/Grok Bot$/.test(exe);
    return base === 'grok-bot' || /grok.?bot.*\.appimage$/i.test(base);
  }

  /** List running processes as {pid, exe, cmd}. Only the official client is inspected. */
  function listProcesses() {
    if (sys.listProcesses) return sys.listProcesses();
    if (platform === 'linux') {
      const out = [];
      for (const d of readdir('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        let exe = '';
        let cmd = '';
        try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { continue; }
        if (!looksLikeGrokExe(exe)) continue;
        // Electron may rewrite argv into one space-joined string.
        try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { continue; }
        out.push({ pid: Number(d), exe, cmd });
      }
      return out;
    }
    if (platform === 'darwin') {
      let text = '';
      try { text = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 }); } catch { return []; }
      return parseMacPs(text).filter((p) => looksLikeGrokExe(p.exe));
    }
    if (platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='Grok Bot.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
      let text = '';
      try { text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 }); } catch { return []; }
      return parseWinCim(text);
    }
    return [];
  }

  /** Main (browser) processes of the client that use the given user-data dir. */
  function mainInstances(userDataDir) {
    return listProcesses().filter((p) => {
      const a = parseClientArgs(p.cmd);
      if (a.type) return false;
      if (userDataDir) return a.userDataDir && samePath(a.userDataDir, userDataDir, platform);
      return !a.userDataDir;
    });
  }

  /** Should the client get --no-sandbox? Only on Linux when no sandbox can work. */
  function needsNoSandbox(bin) {
    if (platform !== 'linux') return false;
    if (/\.appimage$/i.test(bin)) return true; // FUSE mounts cannot hold a setuid helper
    const helper = P.join(P.dirname(bin), 'chrome-sandbox');
    try {
      const st = fs.statSync(helper);
      if (st.uid === 0 && (st.mode & 0o4000)) return false;
    } catch { /* missing helper */ }
    const r = spawnSync('unshare', ['--user', '--map-root-user', 'true'], { stdio: 'ignore' });
    return r.status !== 0;
  }

  /** Arguments and env to launch the client. */
  function launchSpec(bin, { port, userDataDir, extraArgs = [] }) {
    const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
    const childEnv = { ...env };
    if (userDataDir) {
      args.push(`--user-data-dir=${userDataDir}`);
      childEnv.SAND_USER_DATA_DIR = userDataDir;
    }
    if (needsNoSandbox(bin)) args.push('--no-sandbox');
    args.push(...extraArgs);
    const bundle = platform === 'darwin' ? macAppBundle(bin) : null;
    if (bundle) {
      // Launch through LaunchServices so macOS attributes permissions to Grok Bot itself.
      const openArgs = ['-n', '-a', bundle];
      if (userDataDir) openArgs.push('--env', `SAND_USER_DATA_DIR=${userDataDir}`);
      return { command: '/usr/bin/open', args: [...openArgs, '--args', ...args], env: childEnv, viaOpen: true };
    }
    return { command: bin, args, env: childEnv, viaOpen: false };
  }

  // ---------- dialogs ----------
  function hasGui() {
    if (platform === 'linux') return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
    return true;
  }

  function confirm(title, text, okLabel = '确定', cancelLabel = '取消') {
    if (sys.confirm) return sys.confirm(title, text);
    try {
      if (platform === 'darwin') {
        const script = `display dialog ${asStr(text)} with title ${asStr(title)} buttons {${asStr(cancelLabel)}, ${asStr(okLabel)}} default button ${asStr(okLabel)} cancel button ${asStr(cancelLabel)} with icon caution`;
        return spawnSync('osascript', ['-e', script], { stdio: 'ignore' }).status === 0;
      }
      if (platform === 'win32') {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show(${psStr(text)}, ${psStr(title)}, 'YesNo', 'Warning'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }`;
        return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { stdio: 'ignore', windowsHide: true }).status === 0;
      }
      if (hasGui() && which('zenity')) {
        return spawnSync('zenity', ['--question', `--title=${title}`, '--no-wrap', `--ok-label=${okLabel}`, `--cancel-label=${cancelLabel}`, `--text=${text}`], { stdio: 'ignore' }).status === 0;
      }
      if (hasGui() && which('kdialog')) {
        return spawnSync('kdialog', ['--title', title, '--warningyesno', text], { stdio: 'ignore' }).status === 0;
      }
    } catch { /* fall through to terminal */ }
    if (process.stdin.isTTY) {
      process.stderr.write(`${text}\n[y/N] `);
      const buf = Buffer.alloc(16);
      let n = 0;
      try { n = fs.readSync(0, buf, 0, 16, null); } catch { return false; }
      return /^y/i.test(buf.toString('utf8', 0, n).trim());
    }
    return false;
  }

  function notify(title, text, isError = false) {
    if (sys.notify) return sys.notify(title, text, isError);
    process.stderr.write(`${title}: ${text}\n`);
    try {
      if (platform === 'darwin') {
        spawnSync('osascript', ['-e', `display dialog ${asStr(text)} with title ${asStr(title)} buttons {"OK"} default button "OK"${isError ? ' with icon stop' : ''}`], { stdio: 'ignore' });
      } else if (platform === 'win32') {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(${psStr(text)}, ${psStr(title)}, 'OK', '${isError ? 'Error' : 'Information'}')`;
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { stdio: 'ignore', windowsHide: true });
      } else if (hasGui() && which('zenity')) {
        spawnSync('zenity', [isError ? '--error' : '--info', `--title=${title}`, '--no-wrap', `--text=${text}`], { stdio: 'ignore' });
      }
    } catch { /* stderr already has it */ }
  }

  /** Politely ask a client process to exit. Returns true once it is gone. */
  async function stopClient(pid, timeoutMs = 15000) {
    try {
      if (platform === 'darwin') spawnSync('osascript', ['-e', `tell application id "${GROK_BUNDLE_ID}" to quit`], { stdio: 'ignore' });
      else if (platform === 'win32') spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (platform !== 'win32') { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
    return !alive(pid);
  }

  // ---------- browsers for feature windows ----------
  function browserCandidates(configured) {
    const out = [];
    if (configured) out.push(configured);
    if (env.GROKBOT_X_BROWSER) out.push(env.GROKBOT_X_BROWSER);
    if (platform === 'win32') {
      for (const base of [pf, pf86, winLocal]) out.push(P.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      for (const base of [pf86, pf]) out.push(P.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      out.push(P.join(winLocal, 'Chromium', 'Application', 'chrome.exe'));
    } else if (platform === 'darwin') {
      for (const root of ['/Applications', P.join(home, 'Applications')]) {
        out.push(P.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
        out.push(P.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
        out.push(P.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
      }
    } else {
      out.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable');
    }
    return out;
  }

  function findBrowser(configured) {
    for (const c of browserCandidates(configured)) {
      if (!c) continue;
      if (/[\\/]/.test(c)) { if (isFile(c)) return c; continue; }
      const w = which(c);
      if (w) return w;
    }
    return null;
  }

  function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

  return {
    platform, env, home, path: P,
    stateDir, configDir, grokCandidates, findGrokBin, macAppBundle, looksLikeGrokExe,
    listProcesses, mainInstances, needsNoSandbox, launchSpec,
    confirm, notify, stopClient, browserCandidates, findBrowser, hasGui, exists,
  };
}

// ---------- pure helpers (exported for tests) ----------

/** Extract the switches grokbot-x cares about from a (possibly space-joined) command line. */
export function parseClientArgs(cmd) {
  const s = ` ${String(cmd || '')} `;
  const port = /\s"?--remote-debugging-port=(\d+)/.exec(s);
  const addr = /\s"?--remote-debugging-address=("?)([^\s"]+)\1/.exec(s);
  const type = /\s"?--type=([\w-]+)/.exec(s);
  let userDataDir = null;
  const q = /\s"?--user-data-dir="([^"]+)"/.exec(s) || /\s"--user-data-dir=([^"]+)"/.exec(s);
  if (q) userDataDir = q[1];
  else {
    // Unquoted value may contain spaces: take everything up to the next " --switch".
    const u = /\s--user-data-dir=(.+?)(?=\s--[a-z]|\s*$)/.exec(s);
    if (u) userDataDir = u[1].trim();
  }
  return {
    port: port ? Number(port[1]) : null,
    address: addr ? addr[2] : null,
    type: type ? type[1] : null,
    userDataDir,
  };
}

export function isLoopback(addr) {
  return !addr || addr === '127.0.0.1' || addr === 'localhost' || addr === '::1';
}

export function samePath(a, b, platform = process.platform) {
  const norm = (p) => {
    let x = String(p).replace(/[\\/]+$/, '');
    if (platform === 'win32') x = x.replace(/\//g, '\\').toLowerCase();
    return x;
  };
  return norm(a) === norm(b);
}

export function parseMacPs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[2];
    const exeMatch = /^(.*?\.app\/Contents\/MacOS\/[^/]+?)(?=\s--|\s-psn|$)/.exec(cmd);
    out.push({ pid: Number(m[1]), exe: exeMatch ? exeMatch[1] : cmd.split(' ')[0], cmd });
  }
  return out;
}

export function parseWinCim(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  let data;
  try { data = JSON.parse(t); } catch { return []; }
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), exe: p.ExecutablePath || '', cmd: p.CommandLine || '' }));
}

function whichImpl(name, platform, env, isFile) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = (platform === 'win32' ? path.win32 : path.posix).join(d, name + e);
      if (isFile(p)) return p;
    }
  }
  return null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function asStr(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function psStr(s) { return `'${String(s).replace(/'/g, "''")}'`; }
