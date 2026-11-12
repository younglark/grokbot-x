/* features/edithere page script. Runs inside (function(gx){...})(window.__grokbotX).
 * Adds an "编辑" button left of the media viewer's download button. Only touches
 * .sand-media-viewer nodes. Idempotent; hidden whenever no download button exists. */
const FEATURE = 'edithere';
const MARK = 'data-grokbotx-feature';

function imageIn(btn) {
  const viewer = btn.closest('.sand-media-viewer') || document.querySelector('.sand-media-viewer');
  return viewer ? viewer.querySelector('img.sand-media-viewer__image') : null;
}

function makeButton(download) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute(MARK, FEATURE);
  b.setAttribute('data-edithere', '');
  b.title = 'EditHere';
  b.setAttribute('aria-label', 'EditHere');
  b.className = String(download.className || '').replace(/\bsand-media-viewer__download\b/g, 'grokbotx-edithere');
  b.style.cssText = 'min-width:auto;width:auto;padding:0 12px;gap:4px;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;';
  b.textContent = '✎ 编辑';
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const img = imageIn(b);
    if (!img) return;
    const src = img.currentSrc || img.src || '';
    const isData = src.startsWith('data:');
    gx.send(FEATURE, 'open', {
      src: isData ? '' : src.slice(0, 4096),
      srcIsData: isData,
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
      alt: String(img.alt || '').slice(0, 200),
    });
  }, true);
  return b;
}

function ensureFor(download) {
  const parent = download.parentElement;
  if (!parent) return;
  // Remove buttons left over from earlier prototypes (no feature mark).
  parent.querySelectorAll('[data-edithere]:not([' + MARK + '])').forEach((n) => n.remove());
  if (parent.querySelector('[' + MARK + '="' + FEATURE + '"]')) return;
  parent.insertBefore(makeButton(download), download);
}

function scan(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches && root.matches('.sand-media-viewer__download')) ensureFor(root);
  root.querySelectorAll && root.querySelectorAll('.sand-media-viewer__download').forEach(ensureFor);
}

new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) scan(n);
}).observe(document.documentElement, { childList: true, subtree: true });
scan(document.documentElement);
