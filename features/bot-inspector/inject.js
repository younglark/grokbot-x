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

// --- Cross-bot status strip (read-only) ---

const STRIP_PREVIEW_MAX = 80;
const CLASS_ORDER = { waiting: 0, running: 1, retrying: 1, idle: 2 };
const ACTIVITY_KIND_LABELS = {
  tool: '执行工具',
  thinking: '思考中',
  reasoning: '思考中',
  composing: '撰写中',
  writing: '撰写中',
  responding: '回复中',
  searching: '搜索中',
  waiting: '等待中',
};

function rowValues(container) {
  if (!container || typeof container !== 'object') return [];
  try {
    if (typeof container.values === 'function' && typeof container.get === 'function') {
      return Array.from(container.values());
    }
  } catch {
    return [];
  }
  if (Array.isArray(container)) return container.slice();
  try {
    return Object.values(container);
  } catch {
    return [];
  }
}

function rowId(row) {
  return row && typeof row.id === 'string' ? row.id : '';
}

function allRows(roster) {
  if (!roster || typeof roster !== 'object') return [];
  let list = rowValues(roster.agentsById);
  if (!list.some((r) => r && typeof r === 'object')) {
    const refs = Array.isArray(roster.rows) ? roster.rows : [];
    list = refs.map((ref) => {
      if (typeof ref === 'string') return getAgent(roster.agentsById, ref);
      if (!ref || typeof ref !== 'object') return null;
      return getAgent(roster.agentsById, rowId(ref)) || ref;
    });
  }
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = rowId(row);
    const key = id || row;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function classify(row) {
  if (!row || typeof row !== 'object') return 'idle';
  if (row.awaitingUserResponse || row.boxHandoff) return 'waiting';
  if (row.isRetrying) return 'retrying';
  if (row.isRunning || row.isRunningTurn || row.isComposingMessage) return 'running';
  return 'idle';
}

function activityLabel(row) {
  const act = activityOf(row);
  if (!act) return '';
  const kind = typeof act.kind === 'string' ? act.kind.trim() : '';
  const tool = typeof act.tool === 'string' ? act.tool.trim() : '';
  const kindLabel = kind ? (ACTIVITY_KIND_LABELS[kind] || kind) : (tool ? ACTIVITY_KIND_LABELS.tool : '');
  if (kindLabel && tool) return `${kindLabel} · ${tool}`;
  return kindLabel || tool;
}

function activityTime(row) {
  if (!row || typeof row !== 'object') return 0;
  for (const key of ['lastActivityAt', 'localActivityAt', 'updatedAt']) {
    if (isValidTime(row[key])) return Number(row[key]);
  }
  return 0;
}

function unreadOf(row) {
  if (!row || typeof row !== 'object') return 0;
  const n = row.unreadCount;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
  return 0;
}

function oneLine(value, max = STRIP_PREVIEW_MAX) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function rowSummary(row, now = Date.now(), _timeZone) {
  const at = activityTime(row);
  const relative = at ? formatRelative(at, now) : '';
  return {
    id: rowId(row),
    name: botTitle(row) || '未命名',
    status: runningStatus(row),
    cls: classify(row),
    activity: activityLabel(row),
    unread: unreadOf(row),
    hasUnread: unreadOf(row) > 0 || !!(row && row.hasUnread === true),
    preview: oneLine(row && row.lastMessagePreview),
    relative: relative === MISSING ? '' : relative,
    at,
    retrying: !!(row && row.isRetrying),
    boxHandoff: !!(row && row.boxHandoff),
  };
}

function compareSummaries(a, b) {
  const d = (CLASS_ORDER[a.cls] ?? 3) - (CLASS_ORDER[b.cls] ?? 3);
  if (d) return d;
  if (b.at !== a.at) return b.at - a.at;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function emptyCounts() {
  return { total: 0, running: 0, waiting: 0, idle: 0, unread: 0 };
}

function stripState(roster, now = Date.now(), timeZone, fallbackId) {
  if (!isRoster(roster)) return { kind: 'no-roster', selectedId: '', counts: emptyCounts(), rows: [] };
  const rows = allRows(roster).map((row) => rowSummary(row, now, timeZone));
  rows.sort(compareSummaries);
  const counts = emptyCounts();
  for (const r of rows) {
    counts.total += 1;
    if (r.cls === 'waiting') counts.waiting += 1;
    else if (r.cls === 'running' || r.cls === 'retrying') counts.running += 1;
    else counts.idle += 1;
    counts.unread += r.unread;
  }
  return { kind: 'ok', selectedId: resolveSelectedId(roster, fallbackId), counts, rows };
}
/* --- format:end --- */

/* features/bot-inspector page script. Runs inside (function(gx){...})(window.__grokbotX).
 * Injects a read-only cross-bot status strip ("Bot 透视"). Idempotent.
 * Styling reuses Grok Bot's own --sand-* design tokens (fallbacks are the values
 * measured in the light theme), so it follows the client's theme. */
const FEATURE = 'bot-inspector';
const MARK = 'data-grokbotx-feature';
const STYLE_ID = 'gx-bi-style';
const TOGGLE_ID = 'gx-bi-toggle';
const PANEL_ID = 'gx-bi-panel';
const COUNT_ITEMS = [
  { key: 'total', label: '总数' },
  { key: 'running', label: '运行中' },
  { key: 'waiting', label: '等你回复' },
  { key: 'idle', label: '空闲' },
  { key: 'unread', label: '未读' },
];

const STYLE = `
#gx-bi-toggle,#gx-bi-panel{box-sizing:border-box;font-family:var(--cursor-font-family-sans,XVF,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);color:var(--sand-text-primary,#1c1c1c);-webkit-font-smoothing:antialiased;letter-spacing:normal;-webkit-app-region:no-drag}
#gx-bi-toggle *,#gx-bi-panel *{box-sizing:border-box}
#gx-bi-panel[hidden],#gx-bi-toggle[hidden]{display:none !important}
#gx-bi-toggle{position:fixed;top:120px;right:0;z-index:2147483000;margin:0;padding:12px 7px;border:1px solid var(--sand-border-secondary-translucent,#1c1c1c1f);border-right:0;border-radius:10px 0 0 10px;background:var(--sand-bg-elevated,#ffffff);color:var(--sand-text-secondary,#1c1c1cad);font-size:var(--sand-font-size-xs,12px);font-weight:var(--sand-font-weight-medium,500);line-height:1;cursor:pointer;writing-mode:vertical-rl;text-orientation:mixed;box-shadow:var(--sand-shadow-popover,0 10px 20px -3px #1c1c1c1a,0 4px 6px -4px #1c1c1c1a,0 0 0 1px #1c1c1c01);transition:background-color 150ms,color 150ms}
#gx-bi-toggle:hover{background:var(--sand-bg-elevated-hover,#f1f1f1);color:var(--sand-text-primary,#1c1c1c)}
#gx-bi-toggle.gx-bi-toggle-on{color:var(--sand-text-primary,#1c1c1c)}
#gx-bi-panel{position:fixed;top:64px;right:30px;z-index:2147483000;width:340px;max-width:calc(100vw - 48px);max-height:calc(100vh - 96px);display:flex;flex-direction:column;background:var(--sand-bg-elevated,#ffffff);border:1px solid var(--sand-border-tertiary-translucent,#1c1c1c14);border-radius:var(--sand-menu-radius,16px);box-shadow:var(--sand-shadow-popover,0 10px 20px -3px #1c1c1c1a,0 4px 6px -4px #1c1c1c1a,0 0 0 1px #1c1c1c01);overflow:hidden}
#gx-bi-panel .gx-bi-header{display:flex;align-items:center;gap:8px;padding:12px 10px 4px 16px;flex:0 0 auto}
#gx-bi-panel .gx-bi-titles{flex:1 1 auto;min-width:0}
#gx-bi-panel .gx-bi-title{font-size:var(--sand-font-size-base,14px);line-height:var(--sand-line-height-base,20px);font-weight:var(--sand-font-weight-semibold,600);color:var(--sand-text-primary,#1c1c1c)}
#gx-bi-panel .gx-bi-sub{font-size:var(--sand-font-size-xs,12px);line-height:var(--sand-line-height-xs,16px);color:var(--sand-text-tertiary,#1c1c1c8f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gx-bi-panel .gx-bi-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:9999px;background:transparent;color:var(--sand-icon-secondary,#1c1c1ca8);font-size:18px;line-height:1;cursor:pointer;transition:background-color 150ms}
#gx-bi-panel .gx-bi-close:hover{background:var(--sand-bg-hover,#1c1c1c0f);color:var(--sand-icon-primary,#1c1c1ceb)}
#gx-bi-panel .gx-bi-counts{display:flex;gap:4px;padding:8px 12px 10px;flex:0 0 auto}
#gx-bi-panel .gx-bi-count{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 2px;border-radius:10px;background:var(--sand-bg-quaternary,#1c1c1c0a)}
#gx-bi-panel .gx-bi-count-n{font-size:var(--sand-font-size-lg,15px);line-height:var(--sand-line-height-base,20px);font-weight:var(--sand-font-weight-semibold,600);font-variant-numeric:tabular-nums;color:var(--sand-text-primary,#1c1c1c)}
#gx-bi-panel .gx-bi-count-l{font-size:var(--sand-font-size-xxs,11px);line-height:var(--sand-line-height-xxs,16px);color:var(--sand-text-tertiary,#1c1c1c8f);white-space:nowrap}
#gx-bi-panel .gx-bi-count[data-gx-bi-count="waiting"][data-gx-bi-hot] .gx-bi-count-n{color:var(--sand-text-warn-primary,#aa6300)}
#gx-bi-panel .gx-bi-count[data-gx-bi-count="running"][data-gx-bi-hot] .gx-bi-count-n{color:var(--sand-text-success-primary,#00854a)}
#gx-bi-panel .gx-bi-count[data-gx-bi-count="unread"][data-gx-bi-hot] .gx-bi-count-n{color:var(--sand-text-accent-primary,#0b6dd3)}
#gx-bi-panel .gx-bi-divider{height:1px;margin:0 16px;background:var(--sand-border-tertiary-translucent,#1c1c1c14);flex:0 0 auto}
#gx-bi-panel .gx-bi-list{flex:1 1 auto;overflow:auto;padding:6px 8px 8px;min-height:80px}
#gx-bi-panel .gx-bi-row{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:var(--sand-agent-item-radius,12px);transition:background-color 150ms}
#gx-bi-panel .gx-bi-row:hover{background:var(--sand-bg-hover,#1c1c1c0f)}
#gx-bi-panel .gx-bi-row[data-gx-bi-selected]{background:var(--sand-bg-active,#1c1c1c14)}
#gx-bi-panel .gx-bi-dot{flex:0 0 auto;width:8px;height:8px;margin-top:6px;border-radius:9999px;background:var(--sand-icon-quaternary,#1c1c1c52)}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="running"] .gx-bi-dot{background:var(--sand-icon-success-primary,#10ab61);box-shadow:0 0 0 3px var(--sand-bg-success-secondary,#14c16f17);animation:gx-bi-pulse 1.6s ease-in-out infinite}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="waiting"] .gx-bi-dot{background:var(--sand-icon-warn-primary,#da830e);box-shadow:0 0 0 3px var(--sand-bg-warn-secondary,#f5931217)}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="retrying"] .gx-bi-dot{background:var(--sand-icon-orange-primary,#ee620d);box-shadow:0 0 0 3px var(--sand-bg-orange-secondary,#fd690f17)}
@keyframes gx-bi-pulse{0%,100%{opacity:1}50%{opacity:.45}}
#gx-bi-panel .gx-bi-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
#gx-bi-panel .gx-bi-line{display:flex;align-items:center;gap:6px;min-width:0}
#gx-bi-panel .gx-bi-name{flex:1 1 auto;min-width:0;font-size:var(--sand-font-size-base,14px);line-height:var(--sand-line-height-base,20px);font-weight:var(--sand-font-weight-medium,500);color:var(--sand-text-primary,#1c1c1c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gx-bi-panel .gx-bi-time{flex:0 0 auto;font-size:var(--sand-font-size-xs,12px);line-height:var(--sand-line-height-xs,16px);color:var(--sand-text-quaternary,#1c1c1c66);white-space:nowrap}
#gx-bi-panel .gx-bi-status{flex:1 1 auto;min-width:0;font-size:var(--sand-font-size-xs,12px);line-height:var(--sand-line-height-xs,16px);color:var(--sand-text-tertiary,#1c1c1c8f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="running"] .gx-bi-status{color:var(--sand-text-success-primary,#00854a)}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="waiting"] .gx-bi-status{color:var(--sand-text-warn-primary,#aa6300)}
#gx-bi-panel .gx-bi-row[data-gx-bi-cls="retrying"] .gx-bi-status{color:var(--sand-text-orange-primary,#c14c00)}
#gx-bi-panel .gx-bi-tag{flex:0 0 auto;padding:0 6px;border-radius:9999px;font-size:var(--sand-font-size-xxs,11px);line-height:16px;font-weight:var(--sand-font-weight-medium,500);white-space:nowrap;background:var(--sand-bg-orange-secondary,#fd690f17);color:var(--sand-text-orange-primary,#c14c00)}
#gx-bi-panel .gx-bi-tag[data-gx-bi-tag="handoff"]{background:var(--sand-bg-warn-secondary,#f5931217);color:var(--sand-text-warn-primary,#aa6300)}
#gx-bi-panel .gx-bi-badge{flex:0 0 auto;min-width:18px;height:18px;padding:0 5px;border-radius:9999px;background:var(--sand-bg-accent-primary,#1680f3);color:var(--sand-text-on-primary,#ffffff);font-size:var(--sand-font-size-xxs,11px);line-height:18px;font-weight:var(--sand-font-weight-semibold,600);text-align:center;font-variant-numeric:tabular-nums}
#gx-bi-panel .gx-bi-badge[data-gx-bi-dot]{min-width:8px;width:8px;height:8px;padding:0}
#gx-bi-panel .gx-bi-preview{font-size:var(--sand-font-size-sm,13px);line-height:var(--sand-line-height-sm,18px);color:var(--sand-text-secondary,#1c1c1cad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gx-bi-panel .gx-bi-empty{margin:24px 8px;color:var(--sand-text-tertiary,#1c1c1c8f);font-size:var(--sand-font-size-sm,13px);line-height:var(--sand-line-height-sm,18px);text-align:center}
#gx-bi-panel .gx-bi-foot{flex:0 0 auto;padding:6px 16px 10px;color:var(--sand-text-quaternary,#1c1c1c66);font-size:var(--sand-font-size-xxs,11px);line-height:var(--sand-line-height-xxs,16px)}
`.replace(/^\s+|\s+$/g, '');

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
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
  lastJson: '',
  timer: 0,
};

function statusText(r) {
  if (r.cls === 'running' && r.activity) return `${r.status} · ${r.activity}`;
  if (r.activity && r.cls !== 'idle') return `${r.status} · ${r.activity}`;
  return r.status;
}

function renderRow(r, selectedId) {
  const tags = [];
  if (r.retrying) tags.push(el('span', { className: 'gx-bi-tag', 'data-gx-bi-tag': 'retry', text: '重试中' }));
  if (r.boxHandoff) tags.push(el('span', { className: 'gx-bi-tag', 'data-gx-bi-tag': 'handoff', text: '等你接手' }));
  let badge = null;
  if (r.unread > 0) badge = el('span', { className: 'gx-bi-badge', title: `${r.unread} 条未读`, text: r.unread > 99 ? '99+' : String(r.unread) });
  else if (r.hasUnread) badge = el('span', { className: 'gx-bi-badge', 'data-gx-bi-dot': true, title: '有未读' });
  return el('div', {
    className: 'gx-bi-row',
    'data-gx-bi-cls': r.cls,
    'data-gx-bi-selected': r.id && r.id === selectedId ? true : null,
  }, [
    el('span', { className: 'gx-bi-dot', 'aria-hidden': 'true' }),
    el('div', { className: 'gx-bi-main' }, [
      el('div', { className: 'gx-bi-line' }, [
        el('span', { className: 'gx-bi-name', title: r.name, text: r.name }),
        r.relative ? el('span', { className: 'gx-bi-time', text: r.relative }) : null,
      ]),
      el('div', { className: 'gx-bi-line' }, [
        el('span', { className: 'gx-bi-status', text: statusText(r) }),
        ...tags,
        badge,
      ]),
      r.preview ? el('div', { className: 'gx-bi-preview', title: r.preview, text: r.preview }) : null,
    ]),
  ]);
}

function renderCounts(box, counts) {
  box.textContent = '';
  for (const item of COUNT_ITEMS) {
    const n = counts[item.key] || 0;
    box.appendChild(el('div', {
      className: 'gx-bi-count',
      'data-gx-bi-count': item.key,
      'data-gx-bi-hot': item.key !== 'total' && item.key !== 'idle' && n > 0 ? true : null,
    }, [
      el('span', { className: 'gx-bi-count-n', text: String(n) }),
      el('span', { className: 'gx-bi-count-l', text: item.label }),
    ]));
  }
}

function render(panel, snapshot) {
  const sub = panel.querySelector('.gx-bi-sub');
  if (sub) {
    sub.textContent = snapshot.kind === 'ok' ? `全部 ${snapshot.counts.total} 个 Bot · 只读` : '只读';
  }
  renderCounts(panel.querySelector('.gx-bi-counts'), snapshot.counts);
  const list = panel.querySelector('.gx-bi-list');
  list.textContent = '';
  if (snapshot.kind !== 'ok') {
    list.appendChild(el('p', { className: 'gx-bi-empty', text: EMPTY_ROSTER }));
    return;
  }
  if (!snapshot.rows.length) {
    list.appendChild(el('p', { className: 'gx-bi-empty', text: '名册里还没有 Bot。' }));
    return;
  }
  for (const r of snapshot.rows) list.appendChild(renderRow(r, snapshot.selectedId));
}

function setOpen(open) {
  state.open = !!open;
  const panel = document.getElementById(PANEL_ID);
  const toggle = document.getElementById(TOGGLE_ID);
  if (panel) panel.hidden = !state.open;
  if (toggle) {
    toggle.classList.toggle('gx-bi-toggle-on', state.open);
    toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
  }
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
  state.lastJson = '';
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
    snapshot = stripState(page.roster, Date.now(), undefined, page.currentAgentId);
  } catch {
    snapshot = { kind: 'no-roster', selectedId: '', counts: emptyCounts(), rows: [] };
  }
  const json = JSON.stringify(snapshot);
  if (json === state.lastJson) return;
  state.lastJson = json;
  render(panel, snapshot);
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
      setOpen(!state.open);
    }, false);
    (document.body || document.documentElement).appendChild(toggle);
  }

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = mark(el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Bot 透视' }, [
      el('div', { className: 'gx-bi-header' }, [
        el('div', { className: 'gx-bi-titles' }, [
          el('div', { className: 'gx-bi-title', text: 'Bot 透视' }),
          el('div', { className: 'gx-bi-sub', text: '只读' }),
        ]),
        el('button', { type: 'button', className: 'gx-bi-close', title: '关闭', 'aria-label': '关闭', text: '×' }),
      ]),
      el('div', { className: 'gx-bi-counts' }),
      el('div', { className: 'gx-bi-divider' }),
      el('div', { className: 'gx-bi-list', role: 'list' }),
      el('div', { className: 'gx-bi-foot', text: '只读 · 每 1.5 秒从本地名册刷新' }),
    ]));
    panel.querySelector('.gx-bi-close').addEventListener('click', (ev) => {
      ev.preventDefault();
      setOpen(false);
    }, false);
    (document.body || document.documentElement).appendChild(panel);
  }

  setOpen(state.open);
}

ensure();
