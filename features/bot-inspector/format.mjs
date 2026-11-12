// features/bot-inspector: pure readout helpers shared by the page script and tests.
// Read-only: never call roster methods, never write state.

export const MISSING = '—';
export const POLL_MS = 1500;
export const MAX_FIBERS = 8000;
export const MAX_DEPTH = 300;
export const MAX_HOOK_HOPS = 40;
export const PREVIEW_MAX = 300;
export const CONNECTION_NOTE = '额度用量需走账号接口，此处仅显示连接与配置';
export const EMPTY_ROSTER = '未找到 Bot 数据。请确认已打开 Grok Bot 主界面。';
export const EMPTY_ROW = '当前没有选中的 Bot。';

export function displayValue(value) {
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

export function displayText(value, max = PREVIEW_MAX) {
  if (value == null) return MISSING;
  if (typeof value === 'boolean') return displayValue(value);
  if (typeof value !== 'string' && typeof value !== 'number') return MISSING;
  const s = String(value);
  if (!s) return MISSING;
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

export function listLength(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && typeof value.length === 'number' && Number.isFinite(value.length)) return value.length;
  return null;
}

export function displayCount(value) {
  const n = listLength(value);
  return n == null ? MISSING : String(n);
}

export function runningStatus(row) {
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

export function unreadLabel(row) {
  if (!row || typeof row !== 'object') return MISSING;
  if (typeof row.unreadCount === 'number' && Number.isFinite(row.unreadCount)) return String(row.unreadCount);
  if (row.hasUnread === true) return '有';
  if (row.hasUnread === false) return '无';
  return MISSING;
}

export function groupLabel(row) {
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

export function formatAbsolute(ms, _now = Date.now(), timeZone) {
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

export function formatRelative(ms, now = Date.now()) {
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

export function formatTimestamp(ms, now = Date.now(), timeZone) {
  const abs = formatAbsolute(ms, now, timeZone);
  if (abs === MISSING) return MISSING;
  return `${abs}（${formatRelative(ms, now)}）`;
}

export function isSelectedId(value) {
  return typeof value === 'string' && value.length > 0;
}

export function isRoster(value) {
  return !!(
    value
    && typeof value === 'object'
    && 'selectedId' in value
    && (typeof value.selectedId === 'string' || value.selectedId === null)
    && value.agentsById != null
    && typeof value.agentsById === 'object'
  );
}

export function resolveSelectedId(roster, fallbackId) {
  if (roster && isSelectedId(roster.selectedId)) return roster.selectedId;
  if (isSelectedId(fallbackId)) return fallbackId;
  return '';
}

export function hintAgentId(value) {
  if (!value || typeof value !== 'object') return '';
  if (isSelectedId(value.currentAgentId)) return value.currentAgentId;
  if (isSelectedId(value.revealAgentId)) return value.revealAgentId;
  return '';
}

export function getAgent(agentsById, id) {
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

export function selectedRow(roster, fallbackId) {
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

export function getRootFiber(doc) {
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

export function findPageState(fiberRoot) {
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

export function findRoster(fiberRoot) {
  return findPageState(fiberRoot).roster;
}

export function readPageState(doc) {
  return findPageState(getRootFiber(doc));
}

export function readRoster(doc) {
  return readPageState(doc).roster;
}

function activityOf(row) {
  return row && row.currentActivity && typeof row.currentActivity === 'object' && !Array.isArray(row.currentActivity)
    ? row.currentActivity
    : null;
}

export function botTitle(row) {
  if (!row || typeof row !== 'object') return '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name) return name;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (title) return title;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  return id;
}

export function buildNowFields(row) {
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

export function buildTimelineFields(row, now = Date.now(), timeZone) {
  return [
    { label: '创建时间', value: formatTimestamp(row && row.createdAt, now, timeZone) },
    { label: '更新时间', value: formatTimestamp(row && row.updatedAt, now, timeZone) },
    { label: '最近活动', value: formatTimestamp(row && row.lastActivityAt, now, timeZone) },
    { label: '本地活动', value: formatTimestamp(row && row.localActivityAt, now, timeZone) },
    { label: '最近查看', value: formatTimestamp(row && row.lastViewedAt, now, timeZone) },
    { label: '活动序号', value: displayValue(row && row.snapshotSeq) },
  ];
}

export function buildConnectionFields(row) {
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

export function panelState(roster, now = Date.now(), timeZone, fallbackId) {
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

export const STRIP_PREVIEW_MAX = 80;
export const CLASS_ORDER = { waiting: 0, running: 1, retrying: 1, idle: 2 };
export const ACTIVITY_KIND_LABELS = {
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

export function allRows(roster) {
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

export function classify(row) {
  if (!row || typeof row !== 'object') return 'idle';
  if (row.awaitingUserResponse || row.boxHandoff) return 'waiting';
  if (row.isRetrying) return 'retrying';
  if (row.isRunning || row.isRunningTurn || row.isComposingMessage) return 'running';
  return 'idle';
}

export function activityLabel(row) {
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

export function oneLine(value, max = STRIP_PREVIEW_MAX) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

export function rowSummary(row, now = Date.now(), _timeZone) {
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

export function compareSummaries(a, b) {
  const d = (CLASS_ORDER[a.cls] ?? 3) - (CLASS_ORDER[b.cls] ?? 3);
  if (d) return d;
  if (b.at !== a.at) return b.at - a.at;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function emptyCounts() {
  return { total: 0, running: 0, waiting: 0, idle: 0, unread: 0 };
}

export function stripState(roster, now = Date.now(), timeZone, fallbackId) {
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
