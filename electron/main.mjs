// grokbot-x Electron main process: tray, official-client lifecycle, CDP kernel, features.
import fs from 'node:fs';
import path from 'node:path';
import { app, Tray, Menu, nativeImage, shell, dialog, Notification } from 'electron';
import { Kernel } from '../core/kernel.mjs';
import { makePlatform } from '../core/platform.mjs';
import { APP_DIR, loadConfig, saveUserConfig, appVersion } from '../core/config.mjs';
import { createLogger } from '../core/log.mjs';
import { ensureClient } from './client.mjs';
import { openOfficialClient, restartOfficialClient, clientMenuItems } from './client-actions.mjs';
import { registerEditorScheme, handleEditorProtocol, closeEditor, configureEditor, openImageFile, requestSelfTestExport, exportsRoot, showEditor, hasEditorWindow, onEditorChange } from './editor.mjs';

registerEditorScheme();

const log = createLogger('main');
const plat = makePlatform();
const STATE = plat.stateDir();
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(STATE, 'electron'));
app.setName('grokbot-x');

let cfgWrap = loadConfig(plat);
let kernel = null;
let tray = null;
let status = 'idle'; // idle | connecting | connected | disconnected
let lastClient = { port: 0, grokPid: 0, attached: false };
let scanTimerWatch = null;

function notify(title, text, isError = false) {
  log[isError ? 'error' : 'info'](`${title}: ${text.replace(/\n/g, ' ')}`);
  try {
    if (Notification.isSupported()) new Notification({ title, body: text, urgency: isError ? 'critical' : 'normal' }).show();
    else if (isError) dialog.showErrorBox(title, text);
  } catch { plat.notify(title, text, isError); }
}

function confirm(title, text, okLabel = '确定', cancelLabel = '取消') {
  if (app.isReady()) {
    const r = dialog.showMessageBoxSync({
      type: 'warning', title, message: text, buttons: [okLabel, cancelLabel],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    return r === 0;
  }
  return plat.confirm(title, text, okLabel, cancelLabel);
}

function iconPath() {
  const s = process.platform === 'win32' ? 'assets/grokbot-x.ico' : 'assets/grokbot-x-64.png';
  return path.join(APP_DIR, s);
}

function rebuildMenu() {
  if (!tray) return;
  const features = [];
  const names = fs.existsSync(path.join(APP_DIR, 'features'))
    ? fs.readdirSync(path.join(APP_DIR, 'features')).filter((n) => /^[a-z0-9-]+$/.test(n))
    : [];
  for (const name of names) {
    const on = cfgWrap.cfg.features?.[name]?.enabled !== false;
    features.push({
      label: name === 'edithere' ? '图片批注（派生自 EditHere）' : name,
      type: 'checkbox',
      checked: on,
      click: () => toggleFeature(name, !on),
    });
  }
  const connected = status === 'connected';
  const running = officialRunning().length > 0;
  const auto = app.getLoginItemSettings().openAtLogin;
  const [openItem, restartItem] = clientMenuItems({ running });
  tray.setToolTip(connected ? `grokbot-x：已连接到 127.0.0.1:${lastClient.port}` : 'grokbot-x：未连接');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? `状态：已连接（127.0.0.1:${lastClient.port}）` : `状态：${status === 'connecting' ? '正在连接…' : '未连接'}`, enabled: false },
    { type: 'separator' },
    { ...openItem, click: () => { openOfficial().catch((e) => log.error(`open Grok Bot failed: ${e.message}`)); } },
    { ...restartItem, click: () => { restartOfficial().catch((e) => log.error(`restart Grok Bot failed: ${e.message}`)); } },
    { type: 'separator' },
    { label: '显示图片批注窗口', enabled: hasEditorWindow(), click: () => { showEditor(); } },
    { label: '功能', submenu: features.length ? features : [{ label: '（无）', enabled: false }] },
    {
      label: '开机启动', type: 'checkbox', checked: auto,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, name: 'grokbot-x' });
        const { file } = saveUserConfig(plat, { launcher: { openAtLogin: item.checked } });
        cfgWrap = loadConfig(plat, file);
      },
    },
    { type: 'separator' },
    { label: '打开日志目录', click: () => shell.openPath(STATE) },
    { label: '打开导出目录', click: () => { const d = exportsRoot(STATE); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); shell.openPath(d); } },
    { label: `关于 grokbot-x ${appVersion()}`, click: () => dialog.showMessageBox({ type: 'info', title: 'grokbot-x', message: `grokbot-x ${appVersion()}\n非官方 Grok Bot 增强\n图片批注派生自 EditHere，与原作者无隶属关系\n仅限非商业使用\n调试口仅绑定 127.0.0.1` }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

async function toggleFeature(name, enabled) {
  const { file } = saveUserConfig(plat, { features: { [name]: { enabled } } });
  cfgWrap = loadConfig(plat, file);
  if (kernel) await kernel.setFeatureEnabled(name, enabled);
  // Disabling 图片批注 is a real close of its (possibly hidden) window.
  if (name === 'edithere' && !enabled) { try { closeEditor(); } catch { /* ignore */ } }
  log.info(`feature ${name} ${enabled ? 'enabled' : 'disabled'}`);
  rebuildMenu();
}

function officialUserDataDir() {
  return cfgWrap.cfg.launcher?.userDataDir || '';
}

function officialRunning() {
  return plat.mainInstances(officialUserDataDir());
}

function officialActionDeps() {
  return {
    plat,
    userDataDir: officialUserDataDir(),
    status,
    confirm,
    connect,
    getGrokPid: () => lastClient.grokPid,
    log,
  };
}

async function openOfficial() {
  return openOfficialClient(officialActionDeps());
}

async function restartOfficial() {
  return restartOfficialClient(officialActionDeps());
}

async function connect({ forceRestart = false, allowRestart = true } = {}) {
  status = 'connecting';
  rebuildMenu();
  try {
    const r = await ensureClient(plat, cfgWrap.cfg, { confirm, notify, stateDir: STATE, forceRestart, allowRestart });
    if (!r.port) {
      lastClient = { ...lastClient, grokPid: r.grokPid || lastClient.grokPid, attached: false };
      status = 'disconnected';
      rebuildMenu();
      return r;
    }
    lastClient = r;
    if (kernel) {
      await kernel.shutdown();
      kernel = null;
    }
    kernel = new Kernel({ cdpPort: r.port, stateDir: STATE, grokPid: r.grokPid, cfg: cfgWrap.cfg, plat });
    kernel.on('connected', () => { status = 'connected'; rebuildMenu(); });
    kernel.on('disconnected', () => { status = 'disconnected'; rebuildMenu(); });
    kernel.on('client-exited', () => { status = 'disconnected'; lastClient.grokPid = 0; rebuildMenu(); });
    await kernel.loadFeatures();
    await kernel.connect();
    kernel.startScanning();
    kernel.watchGrok();
    const st = await kernel.status();
    status = 'connected';
    log.info(`ready; ${st.length} page(s): ${JSON.stringify(st)}`);
    rebuildMenu();
  } catch (e) {
    status = 'disconnected';
    log.error(`connect failed: ${e.message}`);
    rebuildMenu();
  }
}

function tryCreateTray() {
  try {
    const img = nativeImage.createFromPath(iconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setIgnoreDoubleClickEvents(true);
    rebuildMenu();
    log.info('tray ready');
    return true;
  } catch (e) {
    log.warn(`tray unavailable (${e.message}); running without a tray icon`);
    tray = null;
    return false;
  }
}


function argValue(flag) {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('-')) return argv[i + 1];
  return '';
}

async function maybeOpenTestImage() {
  const file = argValue('--open-image');
  if (!file) return;
  try {
    const info = await openImageFile(file);
    log.info(`--open-image loaded ${info.name} ${info.width}x${info.height}`);
  } catch (e) {
    notify('打开测试图片失败', e.message, true);
    throw e;
  }
}

async function maybeSelfTestExport() {
  try {
    const result = await requestSelfTestExport();
    const marker = path.join(STATE, 'self-test-export.json');
    fs.writeFileSync(marker, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    log.info(`self-test-export: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    notify('测试导出失败', e.message, true);
    throw e;
  }
}

function writePid() {
  const f = path.join(STATE, 'daemon.pid');
  fs.writeFileSync(f, String(process.pid));
}

function watchStopRequest() {
  const f = path.join(STATE, 'stop.request');
  const exportReq = path.join(STATE, 'self-test-export.request');
  try { fs.unlinkSync(f); } catch { /* none */ }
  try { fs.unlinkSync(exportReq); } catch { /* none */ }
  scanTimerWatch = setInterval(() => {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
      log.info('stop.request seen; quitting');
      app.quit();
    }
    if (fs.existsSync(exportReq)) {
      try { fs.unlinkSync(exportReq); } catch { /* ignore */ }
      log.info('self-test-export.request seen');
      maybeSelfTestExport().catch((e) => log.error(e.message));
    }
  }, 500);
  scanTimerWatch.unref?.();
}

// ---- boot ----

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`grokbot-x ${appVersion()} (Electron)
Usage: grokbot-x [--help] [--version] [--dry-run] [--open-image <png>] [--self-test-export]
  Starts the tray app, attaches to Grok Bot if it already has a loopback DevTools port,
  otherwise wait for the tray action "打开 Grok Bot". DevTools is always bound to 127.0.0.1.
  --open-image FILE   Open the in-app annotation window with a local image (dev / self-test).
  --self-test-export  After the editor is open, save feedback into the exports directory.
`);
  app.exit(0);
} else if (process.argv.includes('--version')) {
  process.stdout.write(appVersion() + '\n');
  app.exit(0);
} else if (process.argv.includes('--dry-run')) {
  const info = {
    version: appVersion(),
    platform: plat.platform,
    stateDir: STATE,
    configDir: plat.configDir(),
    grokBotBin: plat.findGrokBin(cfgWrap.cfg.launcher?.grokBotBin) || null,
    searched: plat.grokCandidates(cfgWrap.cfg.launcher?.grokBotBin),
    editor: 'in-app BrowserWindow gx-edithere://app/editor.html (forked sources, preload IPC)',
    cdpBind: '127.0.0.1',
  };
  process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  app.exit(0);
}

if (app.isPackaged) {
  const want = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform !== 'linux';
  if (process.platform === 'linux' && !want) log.warn('no DISPLAY; tray may be unavailable');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('another instance is running; exiting');
  app.exit(0);
} else {
  app.on('second-instance', () => { rebuildMenu(); });
  app.whenReady().then(async () => {
    writePid();
    watchStopRequest();
    const editorBuild = path.join(APP_DIR, 'features', 'edithere', 'build');
    configureEditor({ stateDir: STATE, buildDir: editorBuild });
    handleEditorProtocol(editorBuild);
    onEditorChange(() => rebuildMenu());
    const hasTray = tryCreateTray();
    if (!hasTray) log.info('continuing headless: will still attach to Grok Bot');
    // Default off; honour a previously saved preference.
    const wantLogin = cfgWrap.cfg.launcher?.openAtLogin === true;
    if (app.getLoginItemSettings().openAtLogin !== wantLogin) {
      app.setLoginItemSettings({ openAtLogin: wantLogin, name: 'grokbot-x' });
    }
    // Attach automatically when the official client is already running with a debug port.
    // If it is not running, wait for the user to choose 「打开 Grok Bot」 from the tray (or log the need).
    const ud = cfgWrap.cfg.launcher?.userDataDir || '';
    const running = plat.mainInstances(ud);
    if (running.length || process.env.GROK_BOT_CDP_PORT) {
      await connect({ forceRestart: false });
    } else {
      log.info('Grok Bot is not running; use the tray item 「打开 Grok Bot」');
      status = 'disconnected';
      rebuildMenu();
    }
    try {
      await maybeOpenTestImage();
      if (process.argv.includes('--self-test-export')) await maybeSelfTestExport();
    } catch (e) {
      log.error(`startup editor test failed: ${e.message}`);
    }
  });
}

app.on('window-all-closed', (e) => { e.preventDefault?.(); }); // tray app
app.on('will-quit', () => { try { closeEditor({ quitting: true }); } catch { /* ignore */ } });
app.on('before-quit', async (e) => {
  // The editor window hides on ×; destroy it first so it cannot block quit.
  try { closeEditor({ quitting: true }); } catch { /* ignore */ }
  if (kernel && !kernel.stopping) {
    e.preventDefault();
    try { await kernel.shutdown(); } catch { /* ignore */ }
    kernel = null;
    try { if (Number(fs.readFileSync(path.join(STATE, 'daemon.pid'), 'utf8')) === process.pid) fs.unlinkSync(path.join(STATE, 'daemon.pid')); } catch { /* ignore */ }
    app.exit(0);
  }
});
