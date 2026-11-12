// Tray actions for the official Grok Bot client. No Electron imports, so
// tests can cover 「打开 Grok Bot」 / 「重启 Grok Bot」 without booting the tray.

export const RESTART_CONFIRM = {
  title: 'grokbot-x',
  message: 'grokbot-x 将重启 Grok Bot（调试端口只监听 127.0.0.1）。\n未保存的输入可能丢失。现在重启吗？',
  okLabel: '重启',
  cancelLabel: '取消',
};

/** Always-visible tray items; 「重启」 is enabled only when a client process is running. */
export function clientMenuItems({ running } = {}) {
  return [
    { label: '打开 Grok Bot' },
    { label: '重启 Grok Bot', enabled: !!running },
  ];
}

/**
 * 「打开 Grok Bot」: focus a running official window (attach if needed, never
 * relaunch). If none is running, start it with a loopback debug port, attach,
 * then focus.
 */
export async function openOfficialClient({
  plat, userDataDir = '', status, getGrokPid, connect, log,
} = {}) {
  if (!plat) throw new Error('plat required');
  const running = plat.mainInstances(userDataDir || '');
  if (running.length) {
    if (status !== 'connected') {
      try {
        await connect({ forceRestart: false, allowRestart: false });
      } catch (e) {
        log?.warn(`attach without restart failed: ${e.message}`);
      }
    }
    return focusResult(plat, getGrokPid?.() || running[0].pid, log, { started: false });
  }
  await connect({ forceRestart: false });
  return focusResult(plat, getGrokPid?.() || 0, log, { started: true });
}

/**
 * 「重启 Grok Bot」: confirm first, then force-restart and reconnect. No-op
 * when no official process is running, or when the user cancels.
 */
export async function restartOfficialClient({
  plat, userDataDir = '', confirm, connect, getGrokPid, log,
} = {}) {
  if (!plat) throw new Error('plat required');
  const running = plat.mainInstances(userDataDir || '');
  if (!running.length) {
    log?.warn('restart requested but Grok Bot is not running');
    return { restarted: false, reason: 'not-running' };
  }
  const ok = confirm?.(
    RESTART_CONFIRM.title,
    RESTART_CONFIRM.message,
    RESTART_CONFIRM.okLabel,
    RESTART_CONFIRM.cancelLabel,
  );
  if (!ok) return { restarted: false, reason: 'cancelled' };
  await connect({ forceRestart: true });
  const focus = focusResult(plat, getGrokPid?.() || 0, log, {});
  return { restarted: true, focused: focus.focused, reason: focus.reason };
}

function focusResult(plat, pid, log, extra) {
  let focused = false;
  let reason;
  try {
    const r = plat.focusOfficialWindow({ pid: pid || undefined });
    focused = !!r?.ok;
    reason = r?.reason;
    if (!focused) log?.warn(`could not focus Grok Bot window: ${reason || 'unknown'}`);
  } catch (e) {
    reason = e.message;
    log?.warn(`could not focus Grok Bot window: ${e.message}`);
  }
  return { ...extra, focused, reason };
}
