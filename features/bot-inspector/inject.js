/* features/bot-inspector page script. Runs inside (function(gx){...})(window.__grokbotX). */
/* --- format:start --- */
const MISSING = '—';
const POLL_MS = 1500;
const MAX_FIBERS = 8000;
const MAX_DEPTH = 300;
const MAX_HOOK_HOPS = 40;
const PREVIEW_MAX = 300;
const CONNECTION_NOTE = '额度用量需走账号接口，此处仅显示连接与配置';
const EMPTY_ROSTER = '未找到 Bot 数据。请确认已打开 Grok Bot 主界面。';
const EMPTY_ROW = '当前没有选中的 Bot。';

function displayValue(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  if (value == null) return MISSING;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : MISSING;
  if (typeof value === 'string') {
    const s = value.trim();
    return s ? s : MISSING;
  }
  return MISSING;
}

function displayText(value, max = PREVIEW_MAX) {
  if (value == null) return MISSING;
  if (typeof value === 'boolean') return displayValue(value);
  if (typeof value !== 'string' && typeof value !== 'number') return MISSING;
  const s = String(value);
  if (!s) return MISSING;
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function listLength(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && typeof value.length === 'number' && Number.isFinite(value.length)) return value.length;
  return null;
}

function displayCount(value) {
  const n = listLength(value);
  return n == null ? MISSING : String(n);
}

function runningStatus(row) {
  if (!row || typeof row !== 'object') return '空闲';
  if (row.awaitingUserResponse) return '等待你回复';
  const activity = row.currentActivity && typeof row.currentActivity === 'object' ? row.currentActivity : null;
  const hasTool = !!(activity && (activity.tool || activity.kind === 'tool'));
  if (row.isRunningTurn || row.isRunning) {
    if (row.isComposingMessage) return '运行中·正在撰写';
    if (hasTool) return '运行中·执行工具';
    if (row.isRunningTurn) return '运行中·回合中';
    return '运行中';
  }
  if (row.isComposingMessage) return '正在撰写';
  return '空闲';
}

function unreadLabel(row) {
  if (!row || typeof row !== 'object') return MISSING;
  if (typeof row.unreadCount === 'number' && Number.isFinite(row.unreadCount)) return String(row.unreadCount);
  if (row.hasUnread === true) return '有';
  if (row.hasUnread === false) return '无';
  return MISSING;
}

function groupLabel(row) {
  if (!row || typeof row !== 'object') return MISSING;
  const n = listLength(row.memberIds);
  const extra = n != null ? `（${n} 名成员）` : '';
  if (row.isGroup === true) return `是${extra}`;
  if (row.isGroup === false) return extra ? `否${extra}` : '否';
  return n != null ? `${n} 名成员` : MISSING;
}

function isValidTime(ms) {
  const t = Number(ms);
  return Number.isFinite(t) && t > 0;
}

function formatAbsolute(ms, _now = Date.now(), timeZone) {
  if (!isValidTime(ms)) return MISSING;
  const opts = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  };
  if (timeZone) opts.timeZone = timeZone;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(Number(ms)));
    const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    if (!p.year || !p.month || !p.day) return MISSING;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return MISSING;
  }
}

function formatRelative(ms, now = Date.now()) {
  if (!isValidTime(ms)) return MISSING;
  const diff = Number(now) - Number(ms);
  if (!Number.isFinite(diff)) return MISSING;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  const sec = Math.floor(abs / 1000);
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时${suffix}`;
  const day = Math.floor(hr / 24);
  return `${day} 天${suffix}`;
}

function formatTimestamp(ms, now = Date.now(), timeZone) {
  const abs = formatAbsolute(ms, now, timeZone);
  if (abs === MISSING) return MISSING;
  return `${abs}（${formatRelative(ms, now)}）`;
}

function isSelectedId(value) {
  return typeof value === 'string' && value.length > 0;
}

function isRoster(value) {
  return !!(
    value
    && typeof value === 'object'
    && 'selectedId' in value
    && (typeof value.selectedId === 'string' || value.selectedId === null)
    && value.agentsById != null
    && typeof value.agentsById === 'object'
  );
}

function resolveSelectedId(roster, fallbackId) {
  if (roster && isSelectedId(roster.selectedId)) return roster.selectedId;
  if (isSelectedId(fallbackId)) return fallbackId;
  return '';
}

function hintAgentId(value) {
  if (!value || typeof value !== 'object') return '';
  if (isSelectedId(value.currentAgentId)) return value.currentAgentId;
  if (isSelectedId(value.revealAgentId)) return value.revealAgentId;
  return '';
}

function getAgent(agentsById, id) {
  if (!agentsById || typeof agentsById !== 'object' || typeof id !== 'string' || !id) return null;
  try {
    if (typeof agentsById.get === 'function') {
      const row = agentsById.get(id);
      return row && typeof row === 'object' ? row : null;
    }
  } catch {
    return null;
  }
  try {
    const row = agentsById[id];
    return row && typeof row === 'object' ? row : null;
  } catch {
    return null;
  }
}

function selectedRow(roster, fallbackId) {
  if (!isRoster(roster)) return null;
  return getAgent(roster.agentsById, resolveSelectedId(roster, fallbackId));
}

function isRosterIn(value) {
  if (isRoster(value)) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 8; i++) {
      if (isRoster(value[i])) return value[i];
    }
  }
  return null;
}

function getRootFiber(doc) {
  try {
    const el = doc && doc.getElementById && doc.getElementById('root');
    if (!el) return null;
    const keys = Object.getOwnPropertyNames(el);
    for (const key of keys) {
      if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$')) {
        const node = el[key];
        if (node && node.stateNode && node.stateNode.current) return node.stateNode.current;
        if (node && node.stateNode) return node.stateNode;
        if (node) return node;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function findPageState(fiberRoot) {
  let roster = null;
  let currentAgentId = '';
  const seen = new Set();
  function done() {
    return !!(roster && (isSelectedId(roster.selectedId) || currentAgentId));
  }
  function visitValue(value) {
    if (!roster) {
      const hit = isRosterIn(value);
      if (hit) roster = hit;
    }
    if (!currentAgentId) currentAgentId = hintAgentId(value);
    return done();
  }
  function visitFiber(fiber, depth) {
    if (done()) return true;
    if (!fiber || typeof fiber !== 'object' || depth > MAX_DEPTH) return false;
    if (seen.has(fiber)) return false;
    seen.add(fiber);
    if (seen.size > MAX_FIBERS) return false;
    try {
      const props = fiber.memoizedProps;
      if (visitValue(props) || visitValue(props && props.value)) return true;
      let hook = fiber.memoizedState;
      for (let i = 0; hook && i < MAX_HOOK_HOPS; i++) {
        if (visitValue(hook.memoizedState) || visitValue(hook.queue && hook.queue.lastRenderedState)) return true;
        hook = hook.next;
      }
      const stateNode = fiber.stateNode;
      if (visitValue(stateNode) || visitValue(stateNode && stateNode.state) || visitValue(stateNode && stateNode.props)) return true;
      let dep = fiber.dependencies && fiber.dependencies.firstContext;
      for (let i = 0; dep && i < MAX_HOOK_HOPS; i++) {
        if (visitValue(dep.memoizedValue)) return true;
        dep = dep.next;
      }
    } catch {
      /* skip this fiber's values */
    }
    if (visitFiber(fiber.child, depth + 1)) return true;
    if (visitFiber(fiber.sibling, depth + 1)) return true;
    if (visitFiber(fiber.alternate, depth + 1)) return true;
    return false;
  }
  if (fiberRoot) visitFiber(fiberRoot, 0);
  return { roster, currentAgentId };
}

function findRoster(fiberRoot) {
  return findPageState(fiberRoot).roster;
}

function readPageState(doc) {
  return findPageState(getRootFiber(doc));
}

function readRoster(doc) {
  return readPageState(doc).roster;
}

function activityOf(row) {
  return row && row.currentActivity && typeof row.currentActivity === 'object' && !Array.isArray(row.currentActivity)
    ? row.currentActivity
    : null;
}

function botTitle(row) {
  if (!row || typeof row !== 'object') return '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name) return name;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (title) return title;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  return id;
}

function buildNowFields(row) {
  const act = activityOf(row);
  return [
    { label: '状态', value: runningStatus(row) },
    { label: '活动类型', value: displayValue(act && act.kind) },
    { label: '工具', value: displayValue(act && act.tool) },
    { label: '详情', value: displayText(act && act.detail) },
    { label: '运行中的会话', value: displayCount(row && row.runningSessionIds) },
    { label: '最近消息', value: displayText(row && row.lastMessagePreview) },
    { label: '未读', value: unreadLabel(row) },
    { label: '正在重试', value: displayValue(row && row.isRetrying) },
  ];
}

function buildTimelineFields(row, now = Date.now(), timeZone) {
  return [
    { label: '创建时间', value: formatTimestamp(row && row.createdAt, now, timeZone) },
    { label: '更新时间', value: formatTimestamp(row && row.updatedAt, now, timeZone) },
    { label: '最近活动', value: formatTimestamp(row && row.lastActivityAt, now, timeZone) },
    { label: '本地活动', value: formatTimestamp(row && row.localActivityAt, now, timeZone) },
    { label: '最近查看', value: formatTimestamp(row && row.lastViewedAt, now, timeZone) },
    { label: '活动序号', value: displayValue(row && row.snapshotSeq) },
  ];
}

function buildConnectionFields(row) {
  return [
    { label: 'harness', value: displayValue(row && row.harness) },
    { label: '来源', value: displayValue(row && row.origin) },
    { label: '可见性', value: displayValue(row && row.visibility) },
    { label: '已分享给他人', value: displayValue(row && row.sharedWithOthers) },
    { label: '我是所有者', value: displayValue(row && row.viewerIsOwner) },
    { label: '群组 / 成员', value: groupLabel(row) },
    { label: 'Slack 状态', value: displayValue(row && row.slackStatus) },
    { label: '通知', value: displayValue(row && row.notificationsEnabled) },
    { label: '更新时通知', value: displayValue(row && row.notifyOnUpdatesEnabled) },
    { label: '语音 ID', value: displayValue(row && row.voiceId) },
    { label: '语速', value: displayValue(row && row.voiceSpeed) },
    { label: '语音语言', value: displayValue(row && row.voiceLanguage) },
    { label: 'serverId', value: displayValue(row && row.serverId) },
    { label: '路径', value: displayValue(row && row.path) },
  ];
}

function panelState(roster, now = Date.now(), timeZone, fallbackId) {
  if (!isRoster(roster)) {
    return { kind: 'no-roster', title: '', selectedId: '', now: [], timeline: [], connection: [] };
  }
  const selectedId = resolveSelectedId(roster, fallbackId);
  const row = selectedRow(roster, fallbackId);
  if (!row) {
    return { kind: 'no-row', title: '', selectedId, now: [], timeline: [], connection: [] };
  }
  return {
    kind: 'ok',
    title: botTitle(row),
    selectedId,
    now: buildNowFields(row),
    timeline: buildTimelineFields(row, now, timeZone),
    connection: buildConnectionFields(row),
  };
}
/* --- format:end --- */

/* features/bot-inspector page script. Runs inside (function(gx){...})(window.__grokbotX).
 * Injects a read-only "Bot 透视" floating panel. Idempotent. */
const FEATURE = 'bot-inspector';
const MARK = 'data-grokbotx-feature';
const STYLE_ID = 'gx-bi-style';
const TOGGLE_ID = 'gx-bi-toggle';
const PANEL_ID = 'gx-bi-panel';
const TABS = [
  { id: 'now', label: '现在' },
  { id: 'timeline', label: '时间线' },
  { id: 'connection', label: '用量与连接' },
];

const STYLE = `
#gx-bi-toggle,#gx-bi-panel{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8eaed;line-height:1.45;-webkit-font-smoothing:antialiased}
#gx-bi-toggle *,#gx-bi-panel *{box-sizing:border-box}
#gx-bi-toggle{position:fixed;top:120px;right:0;z-index:2147483000;margin:0;padding:10px 8px;border:1px solid #3a3d45;border-right:0;border-radius:8px 0 0 8px;background:#1b1d21;color:#e8eaed;font-size:12px;letter-spacing:0.02em;cursor:pointer;writing-mode:vertical-rl;text-orientation:mixed;box-shadow:-2px 2px 10px rgba(0,0,0,.35)}
#gx-bi-toggle:hover{background:#25282e}
#gx-bi-toggle.gx-bi-toggle-on{background:#2a3140;color:#8ab4f8}
#gx-bi-panel{position:fixed;top:72px;right:28px;z-index:2147483000;width:360px;max-width:calc(100vw - 40px);max-height:calc(100vh - 96px);display:flex;flex-direction:column;background:#1b1d21;border:1px solid #3a3d45;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.45);overflow:hidden}
#gx-bi-panel[hidden],#gx-bi-toggle[hidden]{display:none !important}
#gx-bi-panel .gx-bi-header{display:flex;align-items:center;gap:8px;padding:10px 10px 8px 14px;border-bottom:1px solid #2e323a;flex:0 0 auto}
#gx-bi-panel .gx-bi-titles{flex:1 1 auto;min-width:0}
#gx-bi-panel .gx-bi-title{font-size:13px;font-weight:650;color:#f1f3f4}
#gx-bi-panel .gx-bi-sub{font-size:11px;color:#9aa0a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
#gx-bi-panel .gx-bi-close{flex:0 0 auto;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#c4c7cc;font-size:18px;line-height:1;cursor:pointer}
#gx-bi-panel .gx-bi-close:hover{background:#2e323a;color:#fff}
#gx-bi-panel .gx-bi-tabs{display:flex;gap:2px;padding:8px 10px 0;flex:0 0 auto}
#gx-bi-panel .gx-bi-tab{flex:1 1 0;border:0;border-radius:6px 6px 0 0;padding:6px 4px 8px;background:transparent;color:#9aa0a6;font-size:12px;cursor:pointer}
#gx-bi-panel .gx-bi-tab:hover{color:#e8eaed;background:#22252b}
#gx-bi-panel .gx-bi-tab.gx-bi-tab-active{color:#8ab4f8;background:#22252b;box-shadow:inset 0 -2px 0 #8ab4f8}
#gx-bi-panel .gx-bi-body{flex:1 1 auto;overflow:auto;padding:10px 14px 12px;min-height:120px}
#gx-bi-panel .gx-bi-note{margin:0 0 10px;padding:8px 10px;border-radius:6px;background:#22252b;color:#9aa0a6;font-size:11px}
#gx-bi-panel .gx-bi-empty{margin:24px 4px;color:#9aa0a6;font-size:13px;text-align:center}
#gx-bi-panel .gx-bi-dl{margin:0;display:grid;grid-template-columns:96px 1fr;gap:8px 10px}
#gx-bi-panel .gx-bi-dt{margin:0;color:#9aa0a6;font-size:11px;font-weight:500;padding-top:1px}
#gx-bi-panel .gx-bi-dd{margin:0;color:#e8eaed;font-size:12px;word-break:break-word;white-space:pre-wrap}
#gx-bi-panel .gx-bi-foot{flex:0 0 auto;padding:6px 14px 8px;border-top:1px solid #2e323a;color:#80868b;font-size:10px}
`.replace(/^\s+|\s+$/g, '');

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'onClick') node.addEventListener('click', v, true);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children || []) if (child) node.appendChild(child);
  return node;
}

function mark(node) {
  node.setAttribute(MARK, FEATURE);
  return node;
}

const state = {
  open: true,
  tab: 'now',
  lastJson: '',
  timer: 0,
};

function fieldsFor(tab, snapshot) {
  if (tab === 'timeline') return snapshot.timeline;
  if (tab === 'connection') return snapshot.connection;
  return snapshot.now;
}

function renderBody(body, snapshot) {
  body.textContent = '';
  if (snapshot.kind !== 'ok') {
    body.appendChild(el('p', { className: 'gx-bi-empty', text: snapshot.kind === 'no-row' ? EMPTY_ROW : EMPTY_ROSTER }));
    return;
  }
  if (state.tab === 'connection') {
    body.appendChild(el('p', { className: 'gx-bi-note', text: CONNECTION_NOTE }));
  }
  const dl = el('dl', { className: 'gx-bi-dl' });
  for (const field of fieldsFor(state.tab, snapshot)) {
    dl.appendChild(el('dt', { className: 'gx-bi-dt', text: field.label }));
    dl.appendChild(el('dd', { className: 'gx-bi-dd', text: field.value }));
  }
  body.appendChild(dl);
}

function setOpen(open) {
  state.open = !!open;
  const panel = document.getElementById(PANEL_ID);
  const toggle = document.getElementById(TOGGLE_ID);
  if (panel) panel.hidden = !state.open;
  if (toggle) toggle.classList.toggle('gx-bi-toggle-on', state.open);
  if (state.open) startPolling();
  else stopPolling();
}

function stopPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = 0;
  }
}

function startPolling() {
  stopPolling();
  refresh();
  state.timer = setInterval(refresh, POLL_MS);
}

function refresh() {
  if (!state.open) return;
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    stopPolling();
    return;
  }
  let snapshot;
  try {
    const page = readPageState(document);
    snapshot = panelState(page.roster, Date.now(), undefined, page.currentAgentId);
  } catch {
    snapshot = { kind: 'no-roster', title: '', selectedId: '', now: [], timeline: [], connection: [] };
  }
  const json = JSON.stringify(snapshot);
  if (json === state.lastJson) return;
  state.lastJson = json;
  const sub = panel.querySelector('.gx-bi-sub');
  if (sub) sub.textContent = snapshot.kind === 'ok' ? (snapshot.title || snapshot.selectedId || '未命名') : '只读';
  renderBody(panel.querySelector('.gx-bi-body'), snapshot);
}

function ensure() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(MARK, FEATURE);
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  let toggle = document.getElementById(TOGGLE_ID);
  if (!toggle) {
    toggle = mark(el('button', {
      id: TOGGLE_ID,
      type: 'button',
      className: 'gx-bi-toggle-on',
      title: '打开或关闭 Bot 透视',
      'aria-label': '打开或关闭 Bot 透视',
      text: 'Bot 透视',
    }));
    toggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(!state.open);
    }, true);
    (document.body || document.documentElement).appendChild(toggle);
  }

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    const tabs = TABS.map((tab) => el('button', {
      type: 'button',
      className: 'gx-bi-tab' + (tab.id === state.tab ? ' gx-bi-tab-active' : ''),
      'data-gx-bi-tab': tab.id,
      'aria-selected': tab.id === state.tab ? 'true' : 'false',
      text: tab.label,
    }));
    panel = mark(el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Bot 透视' }, [
      el('div', { className: 'gx-bi-header' }, [
        el('div', { className: 'gx-bi-titles' }, [
          el('div', { className: 'gx-bi-title', text: 'Bot 透视' }),
          el('div', { className: 'gx-bi-sub', text: '只读' }),
        ]),
        el('button', { type: 'button', className: 'gx-bi-close', title: '关闭', 'aria-label': '关闭', text: '×' }),
      ]),
      el('div', { className: 'gx-bi-tabs', role: 'tablist' }, tabs),
      el('div', { className: 'gx-bi-body' }),
      el('div', { className: 'gx-bi-foot', text: '只读 · 每 1.5 秒从本地名册刷新' }),
    ]));
    panel.addEventListener('click', (ev) => ev.stopPropagation(), false);
    panel.querySelector('.gx-bi-close').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    }, true);
    panel.querySelector('.gx-bi-tabs').addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest('[data-gx-bi-tab]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.getAttribute('data-gx-bi-tab');
      if (!id || id === state.tab) return;
      state.tab = id;
      state.lastJson = '';
      for (const t of panel.querySelectorAll('.gx-bi-tab')) {
        const on = t.getAttribute('data-gx-bi-tab') === id;
        t.classList.toggle('gx-bi-tab-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      refresh();
    }, true);
    (document.body || document.documentElement).appendChild(panel);
  }

  setOpen(state.open);
}

ensure();
