// Unit tests for platform branches; they run on any OS by injecting a fake system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlatform, parseClientArgs, parseMacPs, parseWinCim, samePath, isLoopback, parseWmctrlLxp, isOfficialGrokWindow, isGrokbotXWindow, pickLinuxWindow, buildWinFocusScript } from '../core/platform.mjs';

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

const WMCTRL = `/usr/bin/wmctrl`;
const XDOTOOL = `/usr/bin/xdotool`;
const wmList = [
  '0x00a00001  0 4242 grok-bot.Grok Bot host Grok Bot',
  '0x00b00001  0 99 grokbot-x.grokbot-x host 图片批注',
  '0x00c00001  0 108653 grok-bot.Grok Bot host Grok Bot Research',
].join('\n');

function linuxPlat({ whichTools = { wmctrl: WMCTRL }, list = wmList, exec } = {}) {
  const calls = [];
  const execFile = exec || ((file, args = []) => {
    calls.push([file, ...args]);
    if (file === WMCTRL && args[0] === '-lxp') return list;
    return '';
  });
  const plat = makePlatform({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    home: '/h',
    which: (n) => whichTools[n] || null,
    execFile,
  });
  return { plat, calls };
}

test('Linux focus uses wmctrl, prefers the known pid, and skips the 图片批注 window', () => {
  const { plat, calls } = linuxPlat();
  const r = plat.focusOfficialWindow({ pid: 4242 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'wmctrl');
  assert.equal(r.id, '0x00a00001');
  assert.ok(calls.some((c) => c[0] === WMCTRL && c.includes('-lxp')));
  assert.ok(calls.some((c) => c.includes('-a') && c.includes('0x00a00001')));
  assert.ok(calls.some((c) => c.includes('remove,hidden') && c.includes('0x00a00001')));
  assert.ok(!calls.some((c) => c.includes('0x00b00001') || c.includes('0x00c00001')));
});

test('Linux focus falls back to xdotool and ignores grokbot-x window names', () => {
  const calls = [];
  const execFile = (file, args = []) => {
    calls.push([file, ...args]);
    if (args[0] === 'search' && args.includes('--pid')) return '0xb01\n0xa01';
    if (args[0] === 'getwindowname' && args[1] === '0xb01') return '图片批注';
    if (args[0] === 'getwindowname' && args[1] === '0xa01') return 'Grok Bot';
    return '';
  };
  const plat = makePlatform({
    platform: 'linux', env: { DISPLAY: ':0' }, home: '/h',
    which: (n) => (n === 'xdotool' ? XDOTOOL : null),
    execFile,
  });
  const r = plat.focusOfficialWindow({ pid: 4242 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'xdotool');
  assert.equal(r.id, '0xa01');
  assert.ok(calls.some((c) => c[0] === XDOTOOL && c.includes('--pid') && c.includes('4242')));
  assert.ok(calls.some((c) => c.includes('windowactivate') && c.includes('0xa01')));
  assert.ok(!calls.some((c) => c.includes('windowactivate') && c.includes('0xb01')));
});

test('Linux focus reports a clear failure when no tool or window is available', () => {
  const none = makePlatform({ platform: 'linux', env: { DISPLAY: ':0' }, home: '/h', which: () => null, execFile: () => '' });
  assert.deepEqual(none.focusOfficialWindow({ pid: 1 }), { ok: false, reason: 'wmctrl/xdotool not found' });
  const empty = linuxPlat({ list: '0x00b00001  0 99 grokbot-x.grokbot-x host 图片批注' });
  const r = empty.plat.focusOfficialWindow({ pid: 4242 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'official window not found');
});

test('macOS focus activates the official bundle id and does not launch a new instance', () => {
  const calls = [];
  const plat = makePlatform({
    platform: 'darwin', env: {}, home: '/Users/u',
    execFile: (file, args = []) => { calls.push([file, ...args]); return ''; },
  });
  const r = plat.focusOfficialWindow({ pid: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'osascript');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  const script = calls[0].slice(1).join(' ');
  assert.match(script, /com\.anysphere\.sand/);
  assert.match(script, /System Events/);
  assert.doesNotMatch(script, /\bopen\b/);
  assert.doesNotMatch(script, / -n /);
  assert.doesNotMatch(script, /tell application "Grok Bot" to activate/);
  const fail = makePlatform({
    platform: 'darwin', env: {}, home: '/Users/u',
    execFile: () => { throw new Error('osascript failed'); },
  });
  assert.equal(fail.focusOfficialWindow().ok, false);
});

test('Windows focus runs PowerShell against Grok Bot.exe / AppUserModelID and not grokbot-x', () => {
  const calls = [];
  const plat = makePlatform({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' },
    home: 'C:\\u',
    execFile: (file, args = []) => { calls.push([file, ...args]); return ''; },
  });
  const r = plat.focusOfficialWindow({ pid: 4242 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'powershell');
  assert.equal(calls[0][0], 'powershell.exe');
  const ps = calls[0].join(' ');
  assert.match(ps, /4242/);
  assert.match(ps, /Grok Bot\.exe/);
  assert.match(ps, /com\.anysphere\.sand/);
  assert.match(ps, /SetForegroundWindow/);
  assert.match(ps, /ShowWindow/);
  assert.match(ps, /图片批注/);
  assert.match(ps, /grokbot-x/);
  assert.doesNotMatch(ps, /Start-Process/);
  const script = buildWinFocusScript(0);
  assert.match(script, /Grok Bot\.exe/);
  assert.doesNotMatch(script, /\$targetPid = 0\d/);
});

test('wmctrl parser and official-window picker', () => {
  const wins = parseWmctrlLxp(wmList + '\n');
  assert.equal(wins.length, 3);
  assert.equal(wins[0].pid, 4242);
  assert.equal(isOfficialGrokWindow(wins[0].rest), true);
  assert.equal(isOfficialGrokWindow(wins[1].rest), false);
  assert.equal(isGrokbotXWindow(wins[1].rest), true);
  assert.equal(pickLinuxWindow(wins, 4242).id, '0x00a00001');
  assert.equal(pickLinuxWindow(wins, 99), null); // pid belongs to 图片批注; do not activate it
  assert.equal(pickLinuxWindow(wins, 108653).id, '0x00c00001');
  assert.equal(pickLinuxWindow(wins, 0)?.id || pickLinuxWindow(wins).id, '0x00a00001');
  assert.equal(pickLinuxWindow(wins, 1), null);
});
