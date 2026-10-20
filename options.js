import { getSettings } from './lib.js';

const form = document.getElementById('form');
const saved = document.getElementById('saved');
const s = await getSettings();

for (const el of form.elements) {
  const v = s[el.name];
  if (el.type === 'checkbox') el.checked = v;
  else if (el.type === 'radio') el.checked = el.value === v;
  else if (el.name === 'ignore') el.value = v.join('\n');
  else if (el.name) el.value = v;
}

const int = (v, min, fallback) => { const n = parseInt(v, 10); return Number.isNaN(n) ? fallback : Math.max(min, n); };

let timer;
form.addEventListener('input', async () => {
  const f = new FormData(form);
  const checked = name => form.elements[name].checked;
  await chrome.storage.sync.set({
    enabled: checked('enabled'),
    groupBy: f.get('groupBy'),
    titleStyle: f.get('titleStyle'),
    minTabs: int(f.get('minTabs'), 1, 2),
    pullOnNavigate: checked('pullOnNavigate'),
    collapseOthers: checked('collapseOthers'),
    pullAcrossWindows: checked('pullAcrossWindows'),
    autoSort: checked('autoSort'),
    idleMinutes: int(f.get('idleMinutes'), 0, 0),
    idleDiscard: checked('idleDiscard'),
    rulesText: f.get('rulesText'),
    ignore: f.get('ignore').split(/[\s,]+/).map(d => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean)
  });
  saved.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => saved.classList.remove('show'), 1200);
});
