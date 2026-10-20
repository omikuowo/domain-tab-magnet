import { getSettings } from './lib.js';

const status = document.getElementById('status');
const enabled = document.getElementById('enabled');

enabled.checked = (await getSettings()).enabled;
enabled.addEventListener('change', () => chrome.storage.sync.set({ enabled: enabled.checked }));

document.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const { id: windowId } = await chrome.windows.getCurrent();
    const res = await chrome.runtime.sendMessage({ action: btn.dataset.action, windowId });
    const n = res?.result ?? 0;
    status.textContent = {
      closeDuplicates: `已关闭 ${n} 个重复标签`,
      mergeWindows: `从其他窗口移来 ${n} 个标签`
    }[btn.dataset.action] || '完成';
  });
});

document.getElementById('options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
