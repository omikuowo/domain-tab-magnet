import { DEFAULTS, getSettings, keyFor, isIgnored, titleFor, colorFor } from './lib.js';

let settings = { ...DEFAULTS };
const ready = getSettings().then(s => { settings = s; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
});

// groupId -> 分组 key。存在 session 里，Service Worker 重启后仍在，浏览器关闭即清空
let groupKeys = {};
const groupKeysReady = chrome.storage.session.get('groupKeys').then(r => { groupKeys = r.groupKeys || {}; });
const saveGroupKeys = () => chrome.storage.session.set({ groupKeys });
const isManaged = groupId => groupId != null && groupId !== -1 && groupId in groupKeys;

const freshTabs = new Set();   // 刚创建、还没确定域名的标签
const lastKey = new Map();     // tabId -> 上一次的分组 key

// 所有操作串行执行，避免多个事件（包括跨窗口移动）同时挪标签打架
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue
    .then(async () => { await ready; await groupKeysReady; return fn(); })
    .catch(e => console.warn('[tab-magnet]', e));
  return queue;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 用户正在拖动标签时 Chrome 会拒绝修改，稍后重试
async function retry(fn, times = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= times || !/dragging|cannot be edited/i.test(e.message)) throw e;
      await sleep(150 * (i + 1));
    }
  }
}

const tabKey = t => keyFor(t.url || t.pendingUrl, settings);
const getTab = id => chrome.tabs.get(id).catch(() => null);
const getGroup = id => (id == null || id === -1) ? Promise.resolve(null) : chrome.tabGroups.get(id).catch(() => null);

async function findGroup(windowId, key) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find(g => groupKeys[g.id] === key)
    || groups.find(g => !(g.id in groupKeys) && g.title === titleFor(key, settings))
    || null;
}

// 把若干标签放进 key 对应的组：本窗口的组还在就复用，否则按 styleGroup 的样式新建
async function putInGroup(tabIds, key, windowId, styleGroup) {
  const existing = styleGroup && await getGroup(styleGroup.id);
  if (existing && existing.windowId === windowId) {
    await retry(() => chrome.tabs.group({ groupId: existing.id, tabIds }));
    return existing.id;
  }
  const groupId = await retry(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
  await retry(() => chrome.tabGroups.update(groupId, {
    title: styleGroup?.title ?? titleFor(key, settings),
    color: styleGroup?.color ?? colorFor(key),
    collapsed: false
  }));
  groupKeys[groupId] = key;
  await saveGroupKeys();
  return groupId;
}

// 由本插件管理的组如果剩下的标签不够数，就解散
async function cleanupGroup(groupId) {
  if (!isManaged(groupId)) return;
  const tabs = await chrome.tabs.query({ groupId });
  if (tabs.length === 0) {
    delete groupKeys[groupId];
    await saveGroupKeys();
  } else if (tabs.length < settings.minTabs) {
    await retry(() => chrome.tabs.ungroup(tabs.map(t => t.id)));
  }
}

async function cleanupWindow(windowId) {
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  for (const g of groups) await cleanupGroup(g.id);
}

async function sameKeyTabs(tab, key) {
  const query = settings.pullAcrossWindows ? { windowType: 'normal' } : { windowId: tab.windowId };
  return (await chrome.tabs.query(query))
    .filter(t => t.id !== tab.id && !t.pinned && t.incognito === tab.incognito && tabKey(t) === key);
}

// 其他窗口里同 key 的组，用来沿用它的组名和颜色
async function remoteGroupStyle(remote, key) {
  for (const t of remote) if (groupKeys[t.groupId] === key) return getGroup(t.groupId);
  return null;
}

// 核心：标签打开/跳转到某域名后，把同域的其他标签吸附到它身边
async function attract(tabId) {
  let tab = await getTab(tabId);
  if (!tab || tab.pinned || !settings.enabled) return;

  const key = tabKey(tab);
  // Service Worker 被回收后内存记录会丢，退而用所在组推断上一次的 key
  const prev = lastKey.has(tabId) ? lastKey.get(tabId) : (isManaged(tab.groupId) ? groupKeys[tab.groupId] : undefined);
  lastKey.set(tabId, key);
  const isNew = freshTabs.delete(tabId) || prev == null;
  if (key === prev && !isNew) return;   // 同域内跳转，什么都不做

  const oldGroupId = tab.groupId;
  const leaveOldGroup = async () => {
    if (isManaged(oldGroupId) && groupKeys[oldGroupId] !== key) {
      await retry(() => chrome.tabs.ungroup(tabId));
      await cleanupGroup(oldGroupId);
    }
  };
  if (!key || isIgnored(key, settings)) return leaveOldGroup();

  const windowId = tab.windowId;
  const others = await sameKeyTabs(tab, key);
  if (others.length + 1 < settings.minTabs) return leaveOldGroup();

  const group = await findGroup(windowId, key);
  if (group && tab.groupId === group.id && others.every(t => t.groupId === group.id)) return;

  const remote = others.filter(t => t.windowId !== windowId);
  const remoteWindows = new Set(remote.map(t => t.windowId));
  const style = group || await remoteGroupStyle(remote, key);
  // 吸附模式：已有的同域标签移动到当前标签的位置；传统模式：当前标签加入已有的组
  const pull = isNew || settings.pullOnNavigate || !group;

  if (tab.groupId !== -1 && tab.groupId !== group?.id) await retry(() => chrome.tabs.ungroup(tabId));
  if (remote.length) {
    tab = await getTab(tabId);
    if (!tab) return;
    await retry(() => chrome.tabs.move(remote.map(t => t.id), { windowId, index: pull ? tab.index : -1 }));
  }

  let finalGroupId;
  if (!pull) {
    finalGroupId = await putInGroup([tabId, ...remote.map(t => t.id)], key, windowId, style);
  } else {
    tab = await getTab(tabId);
    if (!tab) return;
    const local = (await chrome.tabs.query({ windowId }))
      .filter(t => t.id !== tabId && !t.pinned && tabKey(t) === key)
      .sort((a, b) => a.index - b.index);
    const before = local.filter(t => t.index < tab.index).length;
    const ids = local.map(t => t.id);
    // local 被拿走后当前标签左移 before 位；把它们放在当前标签左边，当前标签成为组的最后一个
    await retry(() => chrome.tabs.move(ids, { index: tab.index - before }));
    finalGroupId = await putInGroup([...ids, tabId], key, windowId, style);
  }

  if (oldGroupId !== -1 && oldGroupId !== finalGroupId) await cleanupGroup(oldGroupId);
  for (const w of remoteWindows) await cleanupWindow(w);
  if (settings.collapseOthers) await collapseOthers(windowId, finalGroupId);
}

async function collapseOthers(windowId, keepGroupId) {
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) {
    if (g.id !== keepGroupId && !g.collapsed && isManaged(g.id)) {
      await retry(() => chrome.tabGroups.update(g.id, { collapsed: true })).catch(() => {});
    }
  }
}

// 一键整理：把窗口内所有标签按域名分组
async function groupAll(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned);
  const byKey = new Map();
  for (const t of tabs) {
    const k = tabKey(t);
    lastKey.set(t.id, k);
    if (!k || isIgnored(k, settings)) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t.id);
  }
  for (const [k, ids] of byKey) {
    if (ids.length < settings.minTabs) continue;
    await putInGroup(ids, k, windowId, await findGroup(windowId, k));
  }
  await cleanupWindow(windowId);
}

// 跨窗口合并：同一个 key 分散在多个窗口时，全部收到当前窗口再整理
async function mergeWindows(windowId) {
  const win = await chrome.windows.get(windowId);
  const tabs = (await chrome.tabs.query({ windowType: 'normal' }))
    .filter(t => !t.pinned && t.incognito === win.incognito);
  const byKey = new Map();
  for (const t of tabs) {
    const k = tabKey(t);
    if (!k || isIgnored(k, settings)) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const toMove = [];
  const touched = new Set();
  for (const list of byKey.values()) {
    if (new Set(list.map(t => t.windowId)).size < 2) continue;
    for (const t of list) if (t.windowId !== windowId) { toMove.push(t.id); touched.add(t.windowId); }
  }
  if (toMove.length) await retry(() => chrome.tabs.move(toMove, { windowId, index: -1 }));
  await groupAll(windowId);
  for (const w of touched) await cleanupWindow(w);
  return toMove.length;
}

const lastUsed = tabs => Math.max(...tabs.map(t => t.lastAccessed || 0));

// 按最近使用排序：最近用过的组排最左边（固定标签之后）
async function sortByRecent(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const byGroup = new Map();
  for (const t of tabs) {
    if (t.groupId === -1) continue;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  }
  const order = [...byGroup.entries()].sort((a, b) => lastUsed(b[1]) - lastUsed(a[1]));
  let index = tabs.filter(t => t.pinned).length;
  for (const [groupId, list] of order) {
    await retry(() => chrome.tabGroups.move(groupId, { index }));
    index += list.length;
  }
}

async function moveGroupToFront(tabId) {
  const tab = await getTab(tabId);
  if (!tab?.active || !isManaged(tab.groupId)) return;
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const pinned = tabs.filter(t => t.pinned).length;
  if (tabs[pinned]?.groupId === tab.groupId) return;
  await retry(() => chrome.tabGroups.move(tab.groupId, { index: pinned }));
}

// 闲置的组自动折叠，并让组内页面休眠释放内存（正在播放声音的不动）
async function sleepIdleGroups() {
  if (!settings.enabled || !settings.idleMinutes) return;
  const cutoff = Date.now() - settings.idleMinutes * 60_000;
  const byGroup = new Map();
  for (const t of await chrome.tabs.query({})) {
    if (!isManaged(t.groupId)) continue;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  }
  for (const [groupId, tabs] of byGroup) {
    if (tabs.some(t => t.active) || lastUsed(tabs) === 0 || lastUsed(tabs) > cutoff) continue;
    const group = await getGroup(groupId);
    if (group && !group.collapsed) await retry(() => chrome.tabGroups.update(groupId, { collapsed: true })).catch(() => {});
    if (!settings.idleDiscard) continue;
    for (const t of tabs) {
      if (!t.discarded && !t.audible) await chrome.tabs.discard(t.id).catch(() => {});
    }
  }
}

async function ungroupAll(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const ids = tabs.filter(t => isManaged(t.groupId)).map(t => t.id);
  if (ids.length) await retry(() => chrome.tabs.ungroup(ids));
}

// 关闭网址完全相同的重复标签（忽略 #hash），保留当前激活的或最新打开的
async function closeDuplicates(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const seen = new Set();
  const toClose = [];
  const norm = u => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
  for (const t of tabs.sort((a, b) => (b.active - a.active) || (b.id - a.id))) {
    if (t.pinned || !t.url) continue;
    const u = norm(t.url);
    if (seen.has(u)) toClose.push(t.id); else seen.add(u);
  }
  if (toClose.length) await chrome.tabs.remove(toClose);
  return toClose.length;
}

// ---- 事件 ----
chrome.tabs.onCreated.addListener(tab => {
  freshTabs.add(tab.id);
  if (tab.pendingUrl || tab.url) enqueue(() => attract(tab.id));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) enqueue(() => attract(tabId));
});

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  freshTabs.delete(tabId);
  lastKey.delete(tabId);
  if (!isWindowClosing) enqueue(() => cleanupWindow(windowId));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!settings.enabled) return;
  if (settings.collapseOthers) {
    enqueue(async () => {
      const tab = await getTab(tabId);
      if (tab) await collapseOthers(windowId, tab.groupId);
    });
  }
  // 停留一会儿再挪，快速切换标签时不会乱跳
  if (settings.autoSort) setTimeout(() => enqueue(() => moveGroupToFront(tabId)), 1500);
});

chrome.tabGroups.onRemoved.addListener(g => {
  if (g.id in groupKeys) { delete groupKeys[g.id]; saveGroupKeys(); }
});

chrome.alarms.create('idle-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'idle-check') enqueue(sleepIdleGroups);
});

const actions = { groupAll, ungroupAll, closeDuplicates, mergeWindows, sortByRecent };

chrome.commands.onCommand.addListener(async cmd => {
  const { id: windowId } = await chrome.windows.getLastFocused();
  if (cmd === 'group-all') enqueue(() => groupAll(windowId));
  if (cmd === 'sort-recent') enqueue(() => sortByRecent(windowId));
  if (cmd === 'toggle-enabled') {
    await ready;
    await chrome.storage.sync.set({ enabled: !settings.enabled });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = actions[msg?.action];
  if (!fn) return;
  enqueue(() => fn(msg.windowId)).then(r => sendResponse({ ok: true, result: r }));
  return true;
});
