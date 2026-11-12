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

export function isRoster(value) {
  return !!(
    value
    && typeof value === 'object'
    && typeof value.selectedId === 'string'
    && value.agentsById != null
    && typeof value.agentsById === 'object'
  );
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

export function selectedRow(roster) {
  if (!isRoster(roster)) return null;
  return getAgent(roster.agentsById, roster.selectedId);
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

export function findRoster(fiberRoot) {
  let found = null;
  const seen = new Set();
  function visitValue(value) {
    const hit = isRosterIn(value);
    if (hit) {
      found = hit;
      return true;
    }
    return false;
  }
  function visitFiber(fiber, depth) {
    if (found) return true;
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
  return found;
}

export function readRoster(doc) {
  return findRoster(getRootFiber(doc));
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

export function panelState(roster, now = Date.now(), timeZone) {
  if (!isRoster(roster)) {
    return { kind: 'no-roster', title: '', selectedId: '', now: [], timeline: [], connection: [] };
  }
  const row = selectedRow(roster);
  if (!row) {
    return { kind: 'no-row', title: '', selectedId: roster.selectedId, now: [], timeline: [], connection: [] };
  }
  return {
    kind: 'ok',
    title: botTitle(row),
    selectedId: roster.selectedId,
    now: buildNowFields(row),
    timeline: buildTimelineFields(row, now, timeZone),
    connection: buildConnectionFields(row),
  };
}
