import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MISSING, POLL_MS, CONNECTION_NOTE, EMPTY_ROSTER, EMPTY_ROW, PREVIEW_MAX, MAX_DEPTH,
  displayValue, displayText, displayCount, listLength,
  runningStatus, unreadLabel, groupLabel, botTitle,
  formatAbsolute, formatRelative, formatTimestamp,
  isRoster, getAgent, selectedRow, resolveSelectedId, getRootFiber, findRoster, findPageState, readRoster,
  buildNowFields, buildTimelineFields, buildConnectionFields, panelState,
} from '../features/bot-inspector/format.mjs';
import feature from '../features/bot-inspector/feature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const injectPath = path.join(root, 'features/bot-inspector/inject.js');
const formatPath = path.join(root, 'features/bot-inspector/format.mjs');

const TZ = 'Asia/Shanghai';
// 2026-11-12 18:00:00 CST (UTC+8)
const NOW = Date.parse('2026-11-12T10:00:00.000Z');

function classicFromFormat(src) {
  const body = [];
  let started = false;
  for (const line of src.split('\n')) {
    if (!started) {
      if (line.startsWith('export ')) started = true;
      else continue;
    }
    body.push(line.startsWith('export ') ? line.slice(7) : line);
  }
  return body.join('\n').trim();
}

function fiber(partial = {}) {
  return {
    child: null,
    sibling: null,
    alternate: null,
    memoizedProps: null,
    memoizedState: null,
    stateNode: null,
    dependencies: null,
    ...partial,
  };
}

function sampleRow(over = {}) {
  return {
    id: 'bot-1',
    name: '调研助手',
    title: 'unused-title',
    origin: 'native',
    isGroup: false,
    memberIds: ['u1'],
    viewerIsOwner: true,
    visibility: 'private',
    sharedWithOthers: false,
    serverId: 'srv-1',
    path: '/bots/bot-1',
    isActive: true,
    isRunning: true,
    isRunningTurn: true,
    isComposingMessage: false,
    currentActivity: { kind: 'tool', tool: 'web_search', detail: 'searching docs' },
    runningSessionIds: ['s1', 's2'],
    awaitingUserResponse: false,
    lastMessagePreview: '正在查找资料',
    lastMessageId: 'm9',
    newestEntryId: 'e9',
    hasUnread: true,
    unreadCount: 2,
    isRetrying: false,
    createdAt: NOW - 2 * 60 * 60 * 1000,
    updatedAt: NOW - 90 * 1000,
    localActivityAt: NOW - 30 * 1000,
    lastActivityAt: NOW - 3 * 60 * 1000,
    lastViewedAt: NOW - 10 * 1000,
    snapshotSeq: 17,
    snapshotEpoch: 3,
    harness: 'sand',
    slackStatus: 'connected',
    notificationsEnabled: true,
    notifyOnUpdatesEnabled: false,
    voiceId: 'alloy',
    voiceSpeed: 1,
    voiceLanguage: 'zh-CN',
    isHiddenFromSidebar: false,
    boxHandoff: null,
    unreadThreadCount: 0,
    ...over,
  };
}

function sampleRoster(rowOver, rosterOver = {}) {
  const row = sampleRow(rowOver);
  return { selectedId: row.id, agentsById: { [row.id]: row }, ...rosterOver };
}

test('feature manifest matches the directory and has a page script', () => {
  assert.equal(feature.name, 'bot-inspector');
  assert.deepEqual(feature.messageTypes, []);
  assert.equal(feature.pageScript, 'inject.js');
  assert.ok(fs.existsSync(injectPath));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  assert.equal(cfg.features['bot-inspector'].enabled, true);
});

test('inject.js inlines format.mjs and stays a classic script', () => {
  const inject = fs.readFileSync(injectPath, 'utf8');
  const formatSrc = fs.readFileSync(formatPath, 'utf8');
  const m = inject.match(/\/\* --- format:start --- \*\/\n([\s\S]*?)\n\/\* --- format:end --- \*\//);
  assert.ok(m, 'format markers missing from inject.js');
  assert.equal(m[1].trim(), classicFromFormat(formatSrc));
  assert.doesNotMatch(inject, /^\s*export /m);
  assert.doesNotMatch(inject, /^\s*import /m);
  assert.match(inject, /data-grokbotx-feature/);
  assert.match(inject, /gx-bi-/);
  assert.match(inject, /Bot 透视/);
  assert.match(inject, /setInterval\(refresh, POLL_MS\)/);
  assert.doesNotMatch(inject, /isAnysphereUser/);
  assert.doesNotMatch(inject, /showFullConversation|showAsyncTasks|getConversationOutline/);
  assert.doesNotMatch(inject, /\.retain\s*\(|snapshotsFor\s*\(/);
  assert.doesNotMatch(inject, /innerHTML/);
});

test('displayValue and displayText handle missing and special values', () => {
  assert.equal(displayValue(undefined), MISSING);
  assert.equal(displayValue(null), MISSING);
  assert.equal(displayValue(''), MISSING);
  assert.equal(displayValue('   '), MISSING);
  assert.equal(displayValue(true), '是');
  assert.equal(displayValue(false), '否');
  assert.equal(displayValue(0), '0');
  assert.equal(displayValue(12), '12');
  assert.equal(displayValue(Number.NaN), MISSING);
  assert.equal(displayValue(Infinity), MISSING);
  assert.equal(displayValue('sand'), 'sand');
  assert.equal(displayValue({ a: 1 }), MISSING);
  assert.equal(displayText(null), MISSING);
  assert.equal(displayText('hello'), 'hello');
  const long = 'x'.repeat(PREVIEW_MAX + 8);
  assert.equal(displayText(long), 'x'.repeat(PREVIEW_MAX) + '…');
  assert.equal(displayCount(['a', 'b']), '2');
  assert.equal(displayCount(undefined), MISSING);
  assert.equal(listLength(null), null);
  assert.equal(listLength({ length: 4 }), 4);
});

test('runningStatus synthesizes a human-readable state', () => {
  assert.equal(runningStatus(null), '空闲');
  assert.equal(runningStatus({}), '空闲');
  assert.equal(runningStatus({ awaitingUserResponse: true, isRunning: true }), '等待你回复');
  assert.equal(runningStatus({ isRunning: true, isRunningTurn: true, isComposingMessage: true }), '运行中·正在撰写');
  assert.equal(runningStatus({ isRunning: true, isRunningTurn: true, currentActivity: { tool: 'search' } }), '运行中·执行工具');
  assert.equal(runningStatus({ isRunningTurn: true, currentActivity: { kind: 'tool' } }), '运行中·执行工具');
  assert.equal(runningStatus({ isRunningTurn: true }), '运行中·回合中');
  assert.equal(runningStatus({ isRunning: true }), '运行中');
  assert.equal(runningStatus({ isComposingMessage: true }), '正在撰写');
});

test('unreadLabel and groupLabel', () => {
  assert.equal(unreadLabel({ unreadCount: 3, hasUnread: true }), '3');
  assert.equal(unreadLabel({ unreadCount: 0 }), '0');
  assert.equal(unreadLabel({ hasUnread: true }), '有');
  assert.equal(unreadLabel({ hasUnread: false }), '无');
  assert.equal(unreadLabel({}), MISSING);
  assert.equal(groupLabel({ isGroup: true, memberIds: ['a', 'b'] }), '是（2 名成员）');
  assert.equal(groupLabel({ isGroup: true }), '是');
  assert.equal(groupLabel({ isGroup: false }), '否');
  assert.equal(groupLabel({ isGroup: false, memberIds: [] }), '否（0 名成员）');
  assert.equal(groupLabel({ memberIds: ['a'] }), '1 名成员');
  assert.equal(groupLabel({}), MISSING);
  assert.equal(botTitle({ name: ' 甲 ', title: '乙', id: 'id' }), '甲');
  assert.equal(botTitle({ title: '乙', id: 'id' }), '乙');
  assert.equal(botTitle({ id: 'id-only' }), 'id-only');
  assert.equal(botTitle({}), '');
});

test('formatAbsolute, formatRelative and formatTimestamp', () => {
  assert.equal(formatAbsolute(NOW, NOW, TZ), '2026-11-12 18:00:00');
  assert.equal(formatAbsolute(undefined, NOW, TZ), MISSING);
  assert.equal(formatAbsolute(0, NOW, TZ), MISSING);
  assert.equal(formatAbsolute('nope', NOW, TZ), MISSING);
  assert.equal(formatAbsolute(-1, NOW, TZ), MISSING);

  assert.equal(formatRelative(NOW, NOW), '刚刚');
  assert.equal(formatRelative(NOW - 4000, NOW), '刚刚');
  assert.equal(formatRelative(NOW - 8000, NOW), '8 秒前');
  assert.equal(formatRelative(NOW - 3 * 60 * 1000, NOW), '3 分钟前');
  assert.equal(formatRelative(NOW - 3 * 60 * 1000 - 59 * 1000, NOW), '3 分钟前');
  assert.equal(formatRelative(NOW - 2 * 60 * 60 * 1000, NOW), '2 小时前');
  assert.equal(formatRelative(NOW - 26 * 60 * 60 * 1000, NOW), '1 天前');
  assert.equal(formatRelative(NOW + 10 * 60 * 1000, NOW), '10 分钟后');
  assert.equal(formatRelative(null, NOW), MISSING);

  assert.equal(formatTimestamp(NOW - 3 * 60 * 1000, NOW, TZ), '2026-11-12 17:57:00（3 分钟前）');
  assert.equal(formatTimestamp(undefined, NOW, TZ), MISSING);
});

test('selectedRow reads Map and plain object agentsById without calling roster methods', () => {
  const row = sampleRow();
  assert.equal(isRoster({ selectedId: 1, agentsById: {} }), false);
  assert.equal(isRoster({ selectedId: 'x' }), false);
  assert.equal(isRoster(null), false);
  assert.equal(isRoster({ selectedId: null, agentsById: {} }), true);
  assert.equal(isRoster({ agentsById: {} }), false);
  assert.equal(selectedRow({ selectedId: 'bot-1', agentsById: { 'bot-1': row } }), row);
  assert.equal(selectedRow({ selectedId: null, agentsById: { 'bot-1': row } }), null);
  assert.equal(selectedRow({ selectedId: null, agentsById: { 'bot-1': row } }, 'bot-1'), row);
  assert.equal(resolveSelectedId({ selectedId: 'bot-1', agentsById: {} }, 'other'), 'bot-1');
  assert.equal(resolveSelectedId({ selectedId: null, agentsById: {} }, 'bot-1'), 'bot-1');
  const map = new Map([['bot-1', row]]);
  assert.equal(selectedRow({ selectedId: 'bot-1', agentsById: map }), row);
  assert.equal(selectedRow({ selectedId: 'missing', agentsById: { 'bot-1': row } }), null);
  assert.equal(getAgent({ 'bot-1': row }, ''), null);
  assert.equal(selectedRow({ selectedId: 'bot-1', retain() { throw new Error('should not call'); }, agentsById: { 'bot-1': row } }), row);
});

test('findRoster walks props, hooks, context, stateNode and alternate; bounds cycles', () => {
  const roster = sampleRoster();
  assert.equal(findRoster(fiber({ memoizedProps: { value: roster } })), roster);
  assert.equal(findRoster(fiber({
    memoizedState: { memoizedState: { skip: true }, next: { memoizedState: roster, next: null } },
  })), roster);
  assert.equal(findRoster(fiber({
    memoizedState: { memoizedState: 1, queue: { lastRenderedState: roster }, next: null },
  })), roster);
  assert.equal(findRoster(fiber({
    memoizedState: { memoizedState: [roster, []], next: null },
  })), roster);
  assert.equal(findRoster(fiber({
    stateNode: { state: { selectedId: 0 }, props: roster },
  })), roster);
  assert.equal(findRoster(fiber({
    dependencies: { firstContext: { memoizedValue: { no: true }, next: { memoizedValue: roster, next: null } } },
  })), roster);

  const deep = fiber({ memoizedProps: { value: roster } });
  let cur = deep;
  for (let i = 0; i < 5; i++) cur = fiber({ child: cur });
  assert.equal(findRoster(cur), roster);

  let leaf = fiber({ memoizedProps: { value: roster } });
  for (let i = 0; i < MAX_DEPTH + 5; i++) leaf = fiber({ child: leaf });
  assert.equal(findRoster(leaf), null);

  const a = fiber();
  const b = fiber({ child: a });
  a.child = b;
  a.sibling = b;
  a.alternate = b;
  b.alternate = a;
  assert.equal(findRoster(a), null);

  const altRoot = fiber({ alternate: fiber({ memoizedProps: { value: roster } }) });
  assert.equal(findRoster(altRoot), roster);
});

test('getRootFiber reads __reactContainer$ and __reactFiber$ on #root', () => {
  const current = fiber({ memoizedProps: { value: sampleRoster() } });
  const el = { __reactContainer$abc: { stateNode: { current } } };
  const doc = { getElementById: (id) => (id === 'root' ? el : null) };
  assert.equal(getRootFiber(doc), current);
  assert.equal(readRoster(doc), current.memoizedProps.value);
  assert.equal(getRootFiber({ getElementById: () => null }), null);

  const fiberEl = { __reactFiber$xyz: { stateNode: current } };
  assert.equal(getRootFiber({ getElementById: (id) => (id === 'root' ? fiberEl : null) }), current);
});

test('buildNowFields, timeline and connection cover the specified keys', () => {
  const row = sampleRow();
  const nowFields = Object.fromEntries(buildNowFields(row).map((f) => [f.label, f.value]));
  assert.equal(nowFields['状态'], '运行中·执行工具');
  assert.equal(nowFields['活动类型'], 'tool');
  assert.equal(nowFields['工具'], 'web_search');
  assert.equal(nowFields['详情'], 'searching docs');
  assert.equal(nowFields['运行中的会话'], '2');
  assert.equal(nowFields['最近消息'], '正在查找资料');
  assert.equal(nowFields['未读'], '2');
  assert.equal(nowFields['正在重试'], '否');

  const idle = Object.fromEntries(buildNowFields({}).map((f) => [f.label, f.value]));
  assert.equal(idle['状态'], '空闲');
  assert.equal(idle['工具'], MISSING);
  assert.equal(idle['运行中的会话'], MISSING);

  const tl = Object.fromEntries(buildTimelineFields(row, NOW, TZ).map((f) => [f.label, f.value]));
  assert.equal(tl['创建时间'], '2026-11-12 16:00:00（2 小时前）');
  assert.equal(tl['更新时间'], '2026-11-12 17:58:30（1 分钟前）');
  assert.equal(tl['最近活动'], '2026-11-12 17:57:00（3 分钟前）');
  assert.equal(tl['本地活动'], '2026-11-12 17:59:30（30 秒前）');
  assert.equal(tl['最近查看'], '2026-11-12 17:59:50（10 秒前）');
  assert.equal(tl['活动序号'], '17');
  assert.equal(buildTimelineFields({}, NOW, TZ)[0].value, MISSING);

  const conn = Object.fromEntries(buildConnectionFields(row).map((f) => [f.label, f.value]));
  assert.equal(CONNECTION_NOTE, '额度用量需走账号接口，此处仅显示连接与配置');
  assert.equal(conn.harness, 'sand');
  assert.equal(conn['来源'], 'native');
  assert.equal(conn['可见性'], 'private');
  assert.equal(conn['已分享给他人'], '否');
  assert.equal(conn['我是所有者'], '是');
  assert.equal(conn['群组 / 成员'], '否（1 名成员）');
  assert.equal(conn['Slack 状态'], 'connected');
  assert.equal(conn['通知'], '是');
  assert.equal(conn['更新时通知'], '否');
  assert.equal(conn['语音 ID'], 'alloy');
  assert.equal(conn['语速'], '1');
  assert.equal(conn['语音语言'], 'zh-CN');
  assert.equal(conn.serverId, 'srv-1');
  assert.equal(conn['路径'], '/bots/bot-1');
  assert.ok(!buildConnectionFields(row).some((f) => /\d+ ?token|额度|剩余/.test(f.value) && /\d{2,}/.test(f.value) && f.label.includes('额度')));
});

test('findPageState keeps walking for currentAgentId when selectedId is null', () => {
  const row = { id: 'bot-1', name: 'Hint' };
  const roster = { selectedId: null, agentsById: { 'bot-1': row } };
  const root = fiber({
    memoizedState: { memoizedState: roster, next: null },
    child: fiber({ memoizedProps: { currentAgentId: 'bot-1' } }),
  });
  const page = findPageState(root);
  assert.equal(page.roster, roster);
  assert.equal(page.currentAgentId, 'bot-1');
  assert.equal(panelState(page.roster, NOW, TZ, page.currentAgentId).title, 'Hint');
});

test('panelState reports empty kinds without inventing a selected row', () => {
  assert.equal(POLL_MS, 1500);
  assert.deepEqual(panelState(null, NOW, TZ).kind, 'no-roster');
  assert.equal(panelState({ selectedId: 'gone', agentsById: {} }, NOW, TZ).kind, 'no-row');
  const viaFallback = panelState({ selectedId: null, agentsById: { 'bot-1': { id: 'bot-1', name: 'Fallback', isRunning: false } } }, NOW, TZ, 'bot-1');
  assert.equal(viaFallback.kind, 'ok');
  assert.equal(viaFallback.title, 'Fallback');
  assert.equal(viaFallback.selectedId, 'bot-1');
  const ok = panelState(sampleRoster(), NOW, TZ);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.title, '调研助手');
  assert.equal(ok.now.length, 8);
  assert.equal(ok.timeline.length, 6);
  assert.equal(ok.connection.length, 14);
  assert.equal(EMPTY_ROSTER.includes('未找到'), true);
  assert.equal(EMPTY_ROW.includes('没有选中'), true);
});
