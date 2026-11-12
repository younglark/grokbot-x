// Auto-update helpers for grokbot-x.
// Pure logic lives here so unit tests can run without Electron.
// The main process injects electron-updater's autoUpdater only when supported.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Decide whether in-app updates are available in this process.
 * Linux auto-update is AppImage-only (electron-updater cannot replace a .deb).
 *
 * @param {{ isPackaged?: boolean, platform?: string, env?: NodeJS.ProcessEnv }} opts
 */
export function updateSupport({ isPackaged = false, platform = process.platform, env = process.env } = {}) {
  if (!isPackaged) {
    return { ok: false, reason: 'not-packaged', message: '自动更新仅在打包版中启用' };
  }
  if (platform === 'linux' && !env.APPIMAGE) {
    return {
      ok: false,
      reason: 'linux-not-appimage',
      message: '当前安装方式不支持应用内更新（Linux 仅 AppImage 可自更新）',
    };
  }
  return { ok: true, reason: null, message: '' };
}

/**
 * Wire autoUpdater events and start periodic checks.
 * Feed URL comes from the app-update.yml that electron-builder injects
 * (provider: github). Do not pass a token here.
 *
 * @returns {{ enabled: true, checkNow: Function, stop: Function, isInstalling: Function, markInstalling: Function }}
 */
export function attachUpdater({
  autoUpdater,
  notify,
  dialog,
  log,
  onQuitAndInstall,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
} = {}) {
  if (!autoUpdater) throw new Error('autoUpdater is required');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let installing = false;
  let manualCheck = false;

  autoUpdater.on('update-available', (info) => {
    const ver = info?.version ? ` ${info.version}` : '';
    notify('grokbot-x', `发现新版本${ver}，正在后台下载`);
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    notify('grokbot-x', '已是最新版本');
  });

  autoUpdater.on('update-downloaded', (info) => {
    const ver = info?.version ? ` ${info.version}` : '';
    Promise.resolve(dialog.showMessageBox({
      type: 'info',
      title: 'grokbot-x',
      message: `新版本${ver} 已下载完成`,
      detail: '重启后即可安装更新。',
      buttons: ['现在重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })).then((result) => {
      const response = typeof result === 'number' ? result : result?.response;
      if (response !== 0) return;
      installing = true;
      return Promise.resolve(onQuitAndInstall ? onQuitAndInstall() : autoUpdater.quitAndInstall());
    }).catch((err) => {
      log?.error?.(`update-downloaded handler: ${err?.message || err}`);
    });
  });

  autoUpdater.on('error', (err) => {
    log?.error?.(`auto-update: ${err?.message || err}`);
  });

  async function checkNow({ manual = false } = {}) {
    if (manual) manualCheck = true;
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      log?.error?.(`checkForUpdates: ${err?.message || err}`);
      return null;
    } finally {
      // Leave manualCheck set until update-not-available handles it (or 10s).
      // Automatic checks must not clear a pending manual request.
      if (manual) {
        setTimeout(() => { manualCheck = false; }, 10_000).unref?.();
      }
    }
  }

  // Startup check, then every interval (default 6h).
  checkNow({ manual: false });
  const timer = setInterval(() => { checkNow({ manual: false }); }, intervalMs);
  timer.unref?.();

  return {
    enabled: true,
    checkNow,
    stop() { clearInterval(timer); },
    isInstalling() { return installing; },
    markInstalling() { installing = true; },
  };
}
