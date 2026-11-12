import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'scripts', 'install.sh');
const INSTALL_PS1 = path.join(ROOT, 'scripts', 'install.ps1');

function runInstall(env, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [INSTALL_SH], {
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`install.sh timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}


function sha512b64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

test('install scripts exist, are executable, and name the official latest URL', () => {
  assert.equal(fs.existsSync(INSTALL_SH), true);
  assert.equal(fs.existsSync(INSTALL_PS1), true);
  const sh = fs.readFileSync(INSTALL_SH, 'utf8');
  const ps = fs.readFileSync(INSTALL_PS1, 'utf8');
  const latest = 'https://github.com/younglark/grokbot-x/releases/latest/download';
  assert.match(sh, new RegExp(latest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ps, new RegExp(latest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(sh, /set -euo pipefail/);
  assert.match(ps, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(sh, /请不要用 root 运行/);
  assert.doesNotMatch(sh, /^[ \t]*sudo\s/m);
  assert.doesNotMatch(sh, /openAtLogin|X-GNOME-Autostart|autostart\//);
  assert.doesNotMatch(ps, /openAtLogin|Run\s*=\s*true/i);
  assert.match(sh, /未开启登录自启/);
  assert.match(ps, /未开启登录自启/);
  assert.match(sh, /也未安装官方 Grok Bot/);
  assert.match(ps, /也未安装官方 Grok Bot/);
  assert.match(sh, /linux-\$\{arch\}\.AppImage/);
  assert.match(ps, /win-x64-setup\.exe/);
  assert.match(ps, /\/currentuser/);
  const st = fs.statSync(INSTALL_SH);
  assert.ok((st.mode & 0o111) !== 0, 'install.sh should be executable');
});

test('parse_latest_yml picks the matching file and sha512 from a multi-arch yml', () => {
  const yml = `version: 0.2.0
files:
  - url: grokbot-x-0.2.0-mac-arm64.zip
    sha512: AAAAarm==
    size: 10
  - url: grokbot-x-0.2.0-mac-x64.zip
    sha512: BBBBx64==
    size: 11
path: grokbot-x-0.2.0-mac-arm64.zip
sha512: AAAAarm==
releaseDate: '2026-11-12T00:00:00.000Z'
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbx-yml-'));
  const file = path.join(dir, 'latest-mac.yml');
  fs.writeFileSync(file, yml);
  const src = fs.readFileSync(INSTALL_SH, 'utf8');
  const start = src.indexOf('parse_latest_yml()');
  const end = src.indexOf('\nsha512_base64()');
  assert.ok(start >= 0 && end > start);
  const fn = src.slice(start, end);
  const r = spawnSync('bash', ['-c', `${fn}\nparse_latest_yml "$1" "$2"`, 'bash', file, 'mac-x64.zip'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['0.2.0', 'grokbot-x-0.2.0-mac-x64.zip', 'BBBBx64==']);
  const miss = spawnSync('bash', ['-c', `${fn}\nparse_latest_yml "$1" "$2"`, 'bash', file, 'linux-x86_64.AppImage'], { encoding: 'utf8' });
  assert.notEqual(miss.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

function serve(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
      const body = files[name];
      if (body == null) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('install.sh downloads, verifies sha512, and installs a user-level AppImage', async (t) => {
  if (process.platform === 'win32') { t.skip('bash installer is for Linux/macOS'); return; }
  const payload = Buffer.from('fake-appimage-payload-for-tests\n');
  const digest = sha512b64(payload);
  const fileName = 'grokbot-x-0.2.0-linux-x86_64.AppImage';
  const yml = Buffer.from(`version: 0.2.0
files:
  - url: ${fileName}
    sha512: ${digest}
    size: ${payload.length}
path: ${fileName}
sha512: ${digest}
releaseDate: '2026-11-12T00:00:00.000Z'
`);
  const { server, base } = await serve({
    'latest-linux.yml': yml,
    [fileName]: payload,
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbx-home-'));
  try {
    const env = {
      HOME: home,
      GROKBOT_X_HOME: home,
      GROKBOT_X_RELEASE_BASE: base,
      GROKBOT_X_SKIP_ICON: '1',
    };
    const r = await runInstall(env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const dest = path.join(home, '.local/opt/grokbot-x/grokbot-x.AppImage');
    assert.equal(fs.readFileSync(dest).equals(payload), true);
    assert.ok((fs.statSync(dest).mode & 0o111) !== 0);
    const desktop = fs.readFileSync(path.join(home, '.local/share/applications/grokbot-x.desktop'), 'utf8');
    assert.match(desktop, /Name=Grok Bot X/);
    assert.match(desktop, new RegExp(`Exec=${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(home, '.config/autostart')), false);
    // Idempotent: running again overwrites cleanly.
    const r2 = await runInstall(env);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(dest).equals(payload), true);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install.sh aborts when the sha512 does not match and does not install', async (t) => {
  if (process.platform === 'win32') { t.skip('bash installer is for Linux/macOS'); return; }
  const payload = Buffer.from('tampered\n');
  const fileName = 'grokbot-x-0.2.0-linux-x86_64.AppImage';
  const yml = Buffer.from(`version: 0.2.0
files:
  - url: ${fileName}
    sha512: thisIsNotTheRealChecksum=======
    size: 8
path: ${fileName}
sha512: thisIsNotTheRealChecksum=======
`);
  const { server, base } = await serve({
    'latest-linux.yml': yml,
    [fileName]: payload,
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbx-home-bad-'));
  try {
    const r = await runInstall({
      HOME: home,
      GROKBOT_X_HOME: home,
      GROKBOT_X_RELEASE_BASE: base,
      GROKBOT_X_SKIP_ICON: '1',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /校验/);
    assert.equal(fs.existsSync(path.join(home, '.local/opt/grokbot-x/grokbot-x.AppImage')), false);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
