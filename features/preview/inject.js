/* features/preview page script. Runs inside (function(gx){...})(window.__grokbotX).
 * 在 .zip 附件卡（消息里的 article.sand-file-card，输入框里的 [data-attachment-card] /
 * .sand-attachment-chip）旁边加一个「打开预览」按钮。只读 DOM 文本和卡片 React props
 * 里的附件来源（href / filePath），本脚本不调用客户端接口；官方 window.desktop.* 由主进程经
 * CDP 在用户点击后调用（见 features/preview/desktop.mjs）。点击经 gx.send('preview','open') 报给主进程。 */
const FEATURE = 'preview';
const MARK = 'data-grokbotx-feature';
const CARD_SEL = 'article.sand-file-card, [data-attachment-card], .sand-attachment-chip';

function injectStyle() {
  if (document.getElementById('gx-preview-style')) return;
  const st = document.createElement('style');
  st.id = 'gx-preview-style';
  st.setAttribute(MARK, FEATURE);
  st.textContent = '.gx-preview-btn{-webkit-app-region:no-drag;display:inline-flex;align-items:center;gap:4px;margin:6px 0 0;padding:0 12px;height:28px;'
    + 'border:1px solid var(--sand-border-secondary-translucent,#1c1c1c1f);border-radius:9999px;background:var(--sand-bg-elevated,#fff);'
    + 'color:var(--sand-text-primary,#1c1c1c);font-family:var(--cursor-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);'
    + 'font-size:var(--sand-font-size-sm,13px);font-weight:var(--sand-font-weight-medium,500);line-height:1;white-space:nowrap;cursor:pointer;'
    + 'box-shadow:var(--sand-shadow-xs,0 1px 2px #1c1c1c0d);transition:background-color 150ms,color 150ms}'
    + '.gx-preview-btn:hover{background:var(--sand-bg-elevated-hover,#f1f1f1)}'
    + '.gx-preview-btn:focus-visible{outline:2px solid var(--sand-border-focus,#0b6dd3);outline-offset:2px}'
    + '.gx-preview-btn[data-busy]{color:var(--sand-text-tertiary,#1c1c1c8f);cursor:progress}';
  (document.head || document.documentElement).appendChild(st);
}

function leafText(card, re) {
  const bdi = card.querySelector('bdi[title]');
  if (bdi && re.test(bdi.title.trim())) return bdi.title.trim();
  for (const el of card.querySelectorAll('bdi, p, span, div')) {
    if (el.tagName !== 'BDI' && el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (re.test(t) && t.length > 4 && t.length < 260) return t;
  }
  return '';
}

/** 从卡片 DOM 往上找 React props：消息卡是 { href, downloadName, label }，输入框是 { filePath, name }。 */
function propsOf(card) {
  const key = Object.keys(card).find((k) => k.startsWith('__reactFiber$'));
  let f = key ? card[key] : null;
  for (let i = 0; f && i < 25; i++, f = f.return) {
    const p = f.memoizedProps;
    if (p && typeof p === 'object') {
      if (typeof p.href === 'string' && p.href) return { source: p.href, name: p.downloadName || p.label || '' };
      if (typeof p.filePath === 'string' && p.filePath) return { source: p.filePath, name: p.name || '' };
    }
  }
  return { source: '', name: '' };
}

function metaText(card) {
  const m = card.querySelector('[data-testid="sand-file-card-meta"], .sand-file-card__meta');
  if (m) return (m.textContent || '').trim().slice(0, 120);
  for (const el of card.querySelectorAll('p, span')) {
    const t = (el.textContent || '').trim();
    if (!el.children.length && /\d\s*(B|kB|KB|MB|GB)\b/.test(t)) return t.slice(0, 120);
  }
  return '';
}

function zipInfo(card) {
  const props = propsOf(card);
  let name = typeof props.name === 'string' && /\.zip$/i.test(props.name.trim()) ? props.name.trim() : '';
  if (!name) name = leafText(card, /\.zip$/i);
  if (!name && /\.zip$/i.test(props.source.split(/[?#]/)[0])) name = props.source.split(/[?#]/)[0].split(/[/\\]/).pop();
  if (!name) return null;
  return { name: name.slice(0, 255), source: props.source.slice(0, 4096), meta: metaText(card) };
}

function makeButton(card, info) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gx-preview-btn';
  b.setAttribute(MARK, FEATURE);
  b.title = '在 grokbot-x 的隔离窗口里打开这个验收包；反馈只会复制到剪贴板，不会自动发送';
  b.setAttribute('aria-label', `打开预览 ${info.name}`);
  b.textContent = '▶ 打开预览';
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (b.hasAttribute('data-busy')) return;
    const now = zipInfo(card) || info; // React 可能已更新 props
    const origin = card.matches('article.sand-file-card') ? 'message' : 'composer';
    // 主进程用 reqId 找回这张卡，在页面里读当前账号槽（不经过 binding 传输）
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    b.setAttribute('data-gx-preview-req', reqId);
    if (!gx.send(FEATURE, 'open', { name: now.name, source: now.source, meta: now.meta, origin, reqId })) return;
    b.setAttribute('data-busy', '');
    b.textContent = '正在打开…';
    setTimeout(() => { b.removeAttribute('data-busy'); b.textContent = '▶ 打开预览'; }, 2500);
  }, true);
  return b;
}

function ensure(card) {
  // 消息卡里嵌着 [data-attachment-card]，只在最外层的 article 上加一次
  if (!card.matches('article.sand-file-card') && card.closest('article.sand-file-card')) return;
  // 按钮作为卡片的下一个兄弟节点；React 重渲染把它弄掉了就再补上
  const next = card.nextElementSibling;
  if (next && next.getAttribute(MARK) === FEATURE) return;
  const info = zipInfo(card);
  if (!info) return;
  injectStyle();
  card.insertAdjacentElement('afterend', makeButton(card, info));
}

let pending = 0;
function scanSoon() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    document.querySelectorAll(CARD_SEL).forEach(ensure);
  });
}

new MutationObserver(scanSoon).observe(document.documentElement, { childList: true, subtree: true });
scanSoon();
