/* grokbot-x host adapter. Talks to the Electron preload bridge (window.grokbotX).
 * This file is original to the fork; it is not part of upstream EditHere. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const host = globalThis.grokbotX;

  function text(id, value) {
    const n = $(id);
    if (n && value != null && value !== '') n.textContent = value;
  }

  function applyHostInfo(info) {
    if (!info) return;
    const bar = $('host-bar');
    if (bar) bar.hidden = false;
    if (info.name) text('host-source', info.name);
    if (info.width && info.height) text('host-size', `${info.width} × ${info.height} px`);
    else if (info.sizeLabel) text('host-size', info.sizeLabel);
    if (info.exportDir) text('host-export-path', info.exportDir);
  }

  function sessionSize() {
    const hooks = globalThis.GrokbotXEditorHooks;
    return hooks?.sessionSize?.() || null;
  }

  async function loadImage(payload) {
    const app = globalThis.EditHereWeb;
    if (!app?.loadAgentImage) throw new Error('编辑器尚未就绪');
    await app.loadAgentImage({ image: payload.dataUrl, name: payload.name || 'image.png' });
    try { app.releaseAgent?.(); } catch { /* allow local open/replace */ }
    const size = sessionSize();
    applyHostInfo({
      ...payload,
      width: payload.width || size?.width,
      height: payload.height || size?.height,
      name: payload.name || size?.name,
    });
  }

  async function runSelfTestExport() {
    const hooks = globalThis.GrokbotXEditorHooks;
    if (!hooks?.hasSession?.()) throw new Error('没有已载入的图片，无法导出');
    const files = await hooks.collectExportFiles();
    if (!host?.saveFiles) throw new Error('宿主保存接口不可用');
    return host.saveFiles({ kind: 'self-test', files, reveal: false });
  }

  $('host-reveal')?.addEventListener('click', () => {
    host?.showItemInFolder?.().catch((e) => globalThis.EditHereWeb?.notify?.(e.message));
  });
  $('host-save-as')?.addEventListener('click', () => {
    const hooks = globalThis.GrokbotXEditorHooks;
    if (!hooks?.hasSession?.()) {
      globalThis.EditHereWeb?.notify?.('请先载入图片');
      return;
    }
    hooks.saveFeedback?.({ pickLocation: true });
  });

  // Hide the divider before the export actions when they wrap onto their own row,
  // and publish sizes for the dock-clearance clamp.
  const tools = document.querySelector('.tools');
  const exportTools = tools?.querySelector('.export-tools');
  if (tools && exportTools && typeof ResizeObserver === 'function') {
    const root = document.documentElement.style;
    const dock = document.querySelector('.utility-dock');
    const syncWrap = () => {
      const first = tools.querySelector('.tool-group');
      tools.dataset.exportWrapped = String(!!first && exportTools.offsetTop >= first.offsetTop + first.offsetHeight);
      // Inputs for the dock-clearance clamp in host.css.
      root.setProperty('--gx-tools-width', tools.offsetWidth + 'px');
      root.setProperty('--gx-dock-right', (dock ? Math.ceil(dock.getBoundingClientRect().right) : 0) + 'px');
    };
    const observer = new ResizeObserver(syncWrap);
    observer.observe(tools);
    if (dock) observer.observe(dock);
    addEventListener('resize', syncWrap);
    syncWrap();
  }

  if (host?.onImage) host.onImage((payload) => {
    loadImage(payload).catch((e) => globalThis.EditHereWeb?.notify?.(e.message || String(e)));
  });
  if (host?.onHostInfo) host.onHostInfo(applyHostInfo);
  if (host?.onSelfTestExport) {
    host.onSelfTestExport(() => {
      runSelfTestExport().catch((e) => globalThis.EditHereWeb?.notify?.(e.message || String(e)));
    });
  }
  if (host?.getHostInfo) {
    host.getHostInfo().then(applyHostInfo).catch(() => { /* optional */ });
  }
  applyHostInfo({ exportDir: '状态目录 / features/edithere/exports' });
})();
