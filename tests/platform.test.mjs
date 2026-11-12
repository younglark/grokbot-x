// Unit tests for platform branches; they run on any OS by injecting a fake system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlatform, parseClientArgs, parseMacPs, parseWinCim, samePath, isLoopback } from '../core/platform.mjs';

const files = (list) => ({ isFile: (p) => list.includes(p), exists: (p) => list.includes(p) });

test('state and config dirs per platform', () => {
  const lin = makePlatform({ platform: 'linux', env: {}, home: '/home/u' });
  assert.equal(lin.stateDir(), '/home/u/.local/state/grokbot-x');
  assert.equal(lin.configDir(), '/home/u/.config/grokbot-x');
  const mac = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u' });
  assert.equal(mac.stateDir(), '/Users/u/Library/Application Support/grokbot-x');
  const win = makePlatform({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' });
  assert.equal(win.stateDir(), 'C:\\Users\\u\\AppData\\Local\\grokbot-x');
  assert.equal(win.configDir(), 'C:\\Users\\u\\AppData\\Roaming\\grokbot-x');
});

test('finds the official client in default install locations', () => {
  const lin = makePlatform({ platform: 'linux', env: {}, home: '/home/u', readdir: () => [], ...files(['/opt/Grok Bot/grok-bot']) });
  assert.equal(lin.findGrokBin(), '/opt/Grok Bot/grok-bot');
  const linApp = makePlatform({ platform: 'linux', env: {}, home: '/home/u', readdir: () => ['Grok_Bot_1.0.1.AppImage'], ...files(['/home/u/Applications/Grok_Bot_1.0.1.AppImage']) });
  assert.equal(linApp.findGrokBin(), '/home/u/Applications/Grok_Bot_1.0.1.AppImage');
  const mac = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u', ...files(['/Applications/Grok Bot.app/Contents/MacOS/Grok Bot']) });
  assert.equal(mac.findGrokBin(), '/Applications/Grok Bot.app/Contents/MacOS/Grok Bot');
  const winBin = 'C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot\\Grok Bot.exe';
  const win = makePlatform({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u', ...files([winBin]) });
  assert.equal(win.findGrokBin(), winBin);
  const envWins = makePlatform({ platform: 'linux', env: { GROK_BOT_BIN: '/x/grok-bot' }, home: '/h', readdir: () => [], ...files(['/x/grok-bot', '/opt/Grok Bot/grok-bot']) });
  assert.equal(envWins.findGrokBin(), '/x/grok-bot');
  const none = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u', ...files([]) });
  assert.equal(none.findGrokBin(), null);
});

test('parses client switches, including space-joined Electron argv and Windows quoting', () => {
  const a = parseClientArgs('/x/grok-bot --no-sandbox --user-data-dir=/home/box/.config/Grok Bot Research --remote-debugging-port=19222 --remote-debugging-address=127.0.0.1');
  assert.deepEqual(a, { port: 19222, address: '127.0.0.1', type: null, userDataDir: '/home/box/.config/Grok Bot Research' });
  const w = parseClientArgs('"C:\\Users\\u\\AppData\\Local\\Programs\\Grok Bot\\Grok Bot.exe" --remote-debugging-port=29229 "--user-data-dir=C:\\data dir" ');
  assert.equal(w.port, 29229);
  assert.equal(w.userDataDir, 'C:\\data dir');
  const w2 = parseClientArgs('"C:\\G\\Grok Bot.exe" --user-data-dir="C:\\a b" --remote-debugging-port=1');
  assert.equal(w2.userDataDir, 'C:\\a b');
  assert.equal(parseClientArgs('/x/grok-bot --type=renderer --foo').type, 'renderer');
  assert.equal(parseClientArgs('/Applications/Grok Bot.app/Contents/MacOS/Grok Bot').port, null);
});

test('main instance filtering by user-data dir', () => {
  const procs = [
    { pid: 1, exe: '/opt/Grok Bot/grok-bot', cmd: '/opt/Grok Bot/grok-bot --remote-debugging-port=29229' },
    { pid: 2, exe: '/opt/Grok Bot/grok-bot', cmd: '/opt/Grok Bot/grok-bot --type=gpu-process' },
    { pid: 3, exe: '/opt/Grok Bot/grok-bot', cmd: '/opt/Grok Bot/grok-bot --user-data-dir=/tmp/iso' },
  ];
  const p = makePlatform({ platform: 'linux', env: {}, home: '/h', listProcesses: () => procs });
  assert.deepEqual(p.mainInstances('').map((x) => x.pid), [1]);
  assert.deepEqual(p.mainInstances('/tmp/iso/').map((x) => x.pid), [3]);
});

test('macOS ps and Windows CIM parsing', () => {
  const ps = parseMacPs('  101 /Applications/Grok Bot.app/Contents/MacOS/Grok Bot --remote-debugging-port=29229\n  102 /Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper (Renderer).app/Contents/MacOS/Grok Bot Helper (Renderer) --type=renderer\n');
  assert.equal(ps[0].exe, '/Applications/Grok Bot.app/Contents/MacOS/Grok Bot');
  const mac = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u' });
  assert.equal(mac.looksLikeGrokExe(ps[0].exe), true);
  assert.equal(mac.looksLikeGrokExe(ps[1].exe), false);
  const cim = parseWinCim('{"ProcessId":42,"ExecutablePath":"C:\\\\P\\\\Grok Bot.exe","CommandLine":"\\"C:\\\\P\\\\Grok Bot.exe\\" --remote-debugging-port=29229"}');
  assert.equal(cim[0].pid, 42);
  assert.equal(parseClientArgs(cim[0].cmd).port, 29229);
  assert.deepEqual(parseWinCim(''), []);
});

test('launch spec: loopback only, SAND_USER_DATA_DIR, macOS goes through open', () => {
  const lin = makePlatform({ platform: 'linux', env: {}, home: '/h' });
  const s = lin.launchSpec('/x/Grok_Bot.AppImage', { port: 29229, userDataDir: '/d' });
  assert.ok(s.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(s.args.includes('--no-sandbox'));
  assert.equal(s.env.SAND_USER_DATA_DIR, '/d');
  const mac = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u' });
  const m = mac.launchSpec('/Applications/Grok Bot.app/Contents/MacOS/Grok Bot', { port: 29229, userDataDir: '' });
  assert.equal(m.command, '/usr/bin/open');
  assert.deepEqual(m.args.slice(0, 4), ['-n', '-a', '/Applications/Grok Bot.app', '--args']);
  assert.ok(!m.args.includes('--no-sandbox'));
  const win = makePlatform({ platform: 'win32', env: {}, home: 'C:\\u' });
  const w = win.launchSpec('C:\\P\\Grok Bot.exe', { port: 29229, userDataDir: '' });
  assert.equal(w.command, 'C:\\P\\Grok Bot.exe');
  assert.ok(!w.args.includes('--no-sandbox'));
});

test('browser discovery prefers configured, falls back to Edge on Windows', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const win = makePlatform({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\u', ...files([edge]) });
  assert.equal(win.findBrowser(), edge);
  const mac = makePlatform({ platform: 'darwin', env: {}, home: '/Users/u', ...files(['/Applications/Chromium.app/Contents/MacOS/Chromium']) });
  assert.equal(mac.findBrowser(), '/Applications/Chromium.app/Contents/MacOS/Chromium');
  const lin = makePlatform({ platform: 'linux', env: {}, home: '/h', which: (n) => (n === 'chromium' ? '/usr/bin/chromium' : null), ...files([]) });
  assert.equal(lin.findBrowser(), '/usr/bin/chromium');
});

test('helpers', () => {
  assert.equal(samePath('C:\\A\\b\\', 'c:/a/B', 'win32'), true);
  assert.equal(samePath('/a/b/', '/a/B', 'linux'), false);
  assert.equal(isLoopback(null), true);
  assert.equal(isLoopback('0.0.0.0'), false);
});
