// 设置与域名工具函数，background / popup / options 共用

export const DEFAULTS = {
  enabled: true,
  groupBy: 'root',          // 'root' 主域名(a.b.example.com -> example.com) | 'host' 完整主机名
  titleStyle: 'short',      // 'short' github | 'full' github.com
  minTabs: 2,               // 至少几个同域标签才建组
  pullOnNavigate: true,     // 在已有标签里跳转到别的域名时，也把该域的组吸过来
  collapseOthers: false,    // 只展开当前标签所在的组
  ignore: [],               // 不参与分组的域名
  rulesText: '',            // 自定义分组规则，每行「组名 = 模式, 模式」
  idleMinutes: 30,          // 组闲置多少分钟后自动折叠，0 为关闭
  idleDiscard: true,        // 闲置时同时让组内页面休眠
  pullAcrossWindows: false, // 吸附时把其他窗口的同域标签也拉过来
  autoSort: false           // 切换到某个组时把它移到最左边
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// 常见的多段公共后缀；完整列表见 publicsuffix.org，这里只收常用的
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'org.tw', 'edu.tw', 'com.sg', 'com.my',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'com.br', 'com.mx', 'co.za',
  // 托管平台：不同用户的子域名应视为不同网站
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'workers.dev', 'herokuapp.com', 'blogspot.com', 'web.app', 'firebaseapp.com'
]);

function suffixOf(host) {
  const parts = host.split('.');
  if (parts.length >= 3 && MULTI_SUFFIXES.has(parts.slice(-2).join('.'))) return parts.slice(-2).join('.');
  return parts.slice(-1)[0];
}

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// 「购物 = taobao.com, tmall.com」「github.com/owner/repo」
// 模式匹配该域名及其子域名，带路径时还要求路径前缀一致；不写组名时取模式最后一段
const rulesCache = { text: null, rules: [] };
export function parseRules(text) {
  if (rulesCache.text === text) return rulesCache.rules;
  const rules = (text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(line => {
    const eq = line.indexOf('=');
    let name = eq >= 0 ? line.slice(0, eq).trim() : '';
    const patterns = (eq >= 0 ? line.slice(eq + 1) : line).split(/[,，\s]+/)
      .map(p => p.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''))
      .filter(Boolean)
      .map(p => {
        const slash = p.indexOf('/');
        return slash < 0 ? { host: p, path: '' } : { host: p.slice(0, slash), path: p.slice(slash) };
      });
    if (!name && patterns[0]) name = patterns[0].path.split('/').filter(Boolean).pop() || patterns[0].host;
    return { name, patterns };
  }).filter(r => r.name && r.patterns.length);
  rulesCache.text = text;
  rulesCache.rules = rules;
  return rules;
}

function matchRule(host, path, settings) {
  for (const r of parseRules(settings.rulesText)) {
    const hit = r.patterns.some(p =>
      (host === p.host || host.endsWith('.' + p.host)) &&
      (!p.path || path === p.path || path.startsWith(p.path + '/')));
    if (hit) return 'rule:' + r.name;
  }
  return null;
}

// 返回分组用的 key；不应分组的页面（新标签页、chrome:// 等）返回 null
export function keyFor(url, settings) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const ruleKey = matchRule(host, u.pathname.toLowerCase(), settings);
  if (ruleKey) return ruleKey;
  if (isIp(host) || !host.includes('.')) return u.port ? `${host}:${u.port}` : host;
  if (settings.groupBy === 'host') return host;
  const parts = host.split('.');
  const suffixLen = suffixOf(host).split('.').length;
  return parts.slice(-(suffixLen + 1)).join('.');
}

export function isIgnored(key, settings) {
  if (key.startsWith('rule:')) return false;
  return settings.ignore.some(d => key === d || key.endsWith('.' + d));
}

export function titleFor(key, settings) {
  if (key.startsWith('rule:')) return key.slice(5);
  if (settings.titleStyle === 'full' || isIp(key) || !key.includes('.')) return key;
  const suffix = suffixOf(key);
  return key === suffix ? key : key.slice(0, -(suffix.length + 1));
}

const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

// 同一域名总是同一颜色
export function colorFor(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
