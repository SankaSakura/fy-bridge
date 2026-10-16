import { cardAddress, listCardTabs, serviceAddress } from './cards.js';
const $ = id => document.getElementById(id);
let latest = {}, pending = false, lastBase = '', lastCard = '', initialized = false, configurationEstablished = false;
async function send(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...extra });
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应，请重新加载扩展。');
  return response.value;
}
function render(value) {
  latest = value;
  if (initialized && value.base !== lastBase) $('api-url-status').textContent = '';
  if ($('token').value !== value.token) $('token-status').textContent = '';
  const configured = !!value.cardUrl;
  if (!initialized) {
    $('connection-config').open = !configured;
    configurationEstablished = configured;
  } else if (!configurationEstablished && configured && value.running) {
    $('connection-config').open = false;
    configurationEstablished = true;
  }
  if (!initialized || !$('server').value || $('server').value === lastBase) $('server').value = value.base;
  if (!initialized || !$('card').value || $('card').value === lastCard) $('card').value = value.cardUrl;
  lastBase = value.base; lastCard = value.cardUrl;
  initialized = true;
  $('api-url').value = `${value.base.replace(/\/$/, '')}/v1`;
  $('token').value = value.token;
  $('status').textContent = value.status;
  $('details').textContent = value.details;
  $('close-page-hint').hidden = !value.running || value.stopping;
  const recoveryIdle = !value.busy && !value.connecting && !value.stopping;
  $('recovery').hidden = !recoveryIdle || !value.recovery;
  $('manual').hidden = !recoveryIdle || value.recovery || !value.serverDirty;
  const active = value.running || value.busy || value.polling || value.stopping || value.stopIncomplete;
  const configLocked = !!(pending || value.running || value.busy || value.connecting || value.polling || value.stopping);
  $('connection-config').classList.toggle('is-locked', configLocked);
  $('config-lock-label').hidden = !configLocked;
  for (const id of ['connect', 'server', 'card', 'open-cards', 'refresh-cards', 'save-config', 'restore', 'unlock']) $(id).disabled = configLocked;
  $('connect').disabled = configLocked || value.recovery || value.serverDirty;
  $('connect').hidden = !!active && !value.connecting;
  $('connect').textContent = value.connecting ? '正在启动…' : '启动反代';
  $('disconnect').hidden = !active || value.connecting;
  $('disconnect').disabled = pending || value.stopping || value.busy && !value.polling;
  $('disconnect').textContent = value.stopping ? '正在停止…' : '停止反代';
  $('copy-token').disabled = !value.token;
}
function showFailure(message) {
  $('status').textContent = '操作未完成';
  $('details').textContent = `请处理以下问题后重试：${message}`;
}
async function run(action, extra = {}) {
  pending = true; render(latest);
  let failure = '';
  try {
    const value = await send(action, extra);
    if (value?.status) render(value);
  } catch (error) { failure = error.message; }
  finally {
    pending = false;
    try { render(await send('state')); } catch (error) { failure ||= error.message; }
    if (failure) {
      showFailure(failure);
    }
  }
  return !failure;
}
async function refreshCards() {
  const groups = new Map();
  for (const { tab, card } of await listCardTabs()) {
    const group = groups.get(card.appId);
    if (group) group.count++; else groups.set(card.appId, { ...card, title: tab.title || '未命名卡片', count: 1 });
  }
  $('open-cards').replaceChildren(new Option(groups.size ? '选择专用空白卡，或在上方直接粘贴链接（仅首次或换卡时需要）' : '没有找到已打开的卡片，可在上方直接粘贴链接', ''));
  for (const card of groups.values()) $('open-cards').add(new Option(`${card.title}${card.count > 1 ? `（${card.count} 个标签）` : ''} · ${card.appId}`, card.url));
  $('open-cards-hint').textContent = groups.size ? '' : '首次请在此浏览器打开自己的 fy 专用空白卡，再刷新；也可填写地址。';
}
function subscribe() {
  const port = chrome.runtime.connect({ name: 'fy-settings' });
  port.onMessage.addListener(render);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    $('close-page-hint').hidden = true;
    $('status').textContent = '正在重新连接扩展后台…';
    $('details').textContent = '请稍候；若持续无法连接，请在扩展管理页重新加载插件。';
    setTimeout(subscribe, 1000);
  });
}
$('connection').addEventListener('submit', event => {
  event.preventDefault();
  try { void run('connect', { base: serviceAddress($('server').value), cardUrl: cardAddress($('card').value).url }); }
  catch (error) { showFailure(error.message); }
});
$('connection').addEventListener('invalid', event => {
  if ($('connection-config').contains(event.target)) $('connection-config').open = true;
}, true);
$('save-config').addEventListener('click', async () => {
  if (!$('connection').reportValidity()) return;
  try {
    const options = { base: serviceAddress($('server').value), cardUrl: cardAddress($('card').value).url };
    if (await run('save-config', options)) {
      configurationEstablished = true;
      $('connection-config').open = false;
    }
  } catch (error) { showFailure(error.message); }
});
$('disconnect').addEventListener('click', () => void run('stop'));
$('restore').addEventListener('click', () => { if (confirm('恢复上次任务前保存的专用卡配置？')) void run('restore'); });
$('unlock').addEventListener('click', () => { if (confirm('确认已在 fy 手动恢复原配置，并且没有正在运行的生成？')) void run('unlock'); });
$('refresh-cards').addEventListener('click', () => void refreshCards().catch(error => { $('open-cards-hint').textContent = error.message; }));
$('open-cards').addEventListener('change', () => { if ($('open-cards').value) $('card').value = $('open-cards').value; });
$('copy-token').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(latest.token); $('token-status').textContent = '密钥已复制。'; }
  catch { $('token-status').textContent = '复制失败，请检查浏览器的剪贴板权限后重试。'; }
});
$('copy-model').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('model').value); $('model-status').textContent = '模型名已复制。'; }
  catch { $('model-status').textContent = '复制失败，可直接选中上方模型名复制。'; }
});
$('copy-api-url').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('api-url').value); $('api-url-status').textContent = 'API 地址已复制。'; }
  catch { $('api-url-status').textContent = '复制失败，可直接选中上方 API 地址复制。'; }
});
render(await send('state')); subscribe();
void refreshCards().catch(error => { $('open-cards-hint').textContent = error.message; });
void run('resume');
