import { fyPage } from './page-adapter.js';
import { cardAddress, listCardTabs, serviceAddress } from './cards.js';
import { fyTrafficRelay } from './traffic-relay.js';

const workerId = crypto.randomUUID();
let running = false, busy = false, connecting = false, polling = false, stopping = false;
let loopTask = null;
let connection = null, currentTab = null, activeJob = null, cancelRequested = false;
let nativePort = null, nativeRequest = null, pollController = null;
let managedService = false, serverDirty = false, stopIncomplete = false;
let statusText = '反代未启动', detailText = '请填写连接配置，然后点击“启动反代”。';
let connectAttempt = 0;
const views = new Set();
const trafficCaptures = new Map();
const boot = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
async function state() {
  const saved = await chrome.storage.local.get(['pairedConnection', 'cardUrl', 'recovery', 'autoConnect']);
  return { running, busy, connecting, polling, stopping, managedService, serverDirty, stopIncomplete, status: statusText, details: detailText,
    base: connection?.base || saved.pairedConnection?.base || 'http://127.0.0.1:43119',
    token: connection?.token || saved.pairedConnection?.token || '', cardUrl: saved.cardUrl || '',
    recovery: !!saved.recovery, autoConnect: saved.autoConnect !== false };
}
async function publish() {
  const value = await state();
  for (const view of views) { try { view.postMessage(value); } catch { views.delete(view); } }
  await chrome.action.setBadgeText({ text: busy ? '…' : running ? 'ON' : serverDirty ? '!' : '' });
}
function note(text, detail = '') { statusText = text; detailText = detail; void publish(); }
function buttons() { void publish(); }
async function recoveryUi(dirty = false) { serverDirty = dirty; void publish(); return (await chrome.storage.local.get('recovery')).recovery; }
function trusted(sender) { return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('bridge.html'); }
async function request(route, payload, signal) {
  if (!connection) throw new Error('本地服务尚未连接。');
  const res = await fetch(connection.base + route, {
    method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
    headers: { Authorization: 'Bearer ' + connection.token, 'X-Bridge-Worker': workerId,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: signal || AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message || `本地服务 HTTP ${res.status}`);
  return value;
}
async function page(action, input, tabId = currentTab) {
  if (!Number.isInteger(tabId)) throw new Error('专用卡标签未连接。');
  if (action === 'cancel') {
    const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fyPage, args: [action, input] });
    return result[0]?.result;
  }
  const channel = crypto.randomUUID();
  trafficCaptures.set(channel, { tabId, action, appId: input.appId, jobId: input.id || activeJob?.id || null });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: fyTrafficRelay, args: [channel] });
    const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fyPage, args: [action, { ...input, trafficChannel: channel }] });
    const value = result[0]?.result;
    if (!value || typeof value !== 'object') throw new Error('浏览器未返回桥接结果。');
    if (value.trafficLogIncomplete) console.error('FY traffic log is incomplete for capture:', channel);
    return value;
  } finally {
    trafficCaptures.delete(channel);
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: fyTrafficRelay, args: [channel, true] }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.action !== 'traffic-record') return false;
  const capture = trafficCaptures.get(message.channel);
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !capture || sender.tab?.id !== capture.tabId) {
    reply({ ok: false, error: 'Traffic capture is no longer active.' }); return false;
  }
  const { tabId, ...metadata } = capture;
  request('/bridge/traffic', { captureId: message.channel, ...metadata, record: message.record })
    .then(() => reply({ ok: true }), error => {
      console.error('FY traffic log write failed:', error.message);
      reply({ ok: false, error: error.message });
    });
  return true;
});
async function findTab(appId, open = false) {
  let candidates = (await listCardTabs()).filter(item => item.card.appId === appId);
  if (!candidates.length && open) {
    const tab = await chrome.tabs.create({ url: `https://aifun.wiki/zh/explore/installed/${appId}?preview=1`, active: false });
    currentTab = tab.id;
    const deadline = Date.now() + 30000;
    while ((await chrome.tabs.get(tab.id)).status !== 'complete') {
      if (Date.now() >= deadline) throw new Error('专用卡加载超时，请检查登录和网络后重新连接。');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    candidates = (await listCardTabs()).filter(item => item.card.appId === appId);
  }
  if (candidates.length !== 1) throw new Error('同一张专用卡必须只保留一个对话标签；请关闭重复标签后重新连接。');
  return candidates[0].tab.id;
}
function closeNative() { const port = nativePort; nativePort = null; port?.disconnect(); }
async function nativeStart(base) {
  closeNative();
  const port = chrome.runtime.connectNative('local.fy.bridge'); nativePort = port;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { nativeRequest = null; closeNative(); reject(new Error('启动器响应超时，请运行统一安装器更新启动器。')); }, 20000);
    nativeRequest = { reject, timeout };
    port.onMessage.addListener(value => {
      if (nativePort !== port || !nativeRequest) return;
      clearTimeout(timeout); nativeRequest = null;
      if (!value?.ok || value.nativeProtocol !== 2 || value.base !== base || typeof value.token !== 'string' || !value.token.match(/^[A-Za-z0-9_-]{43}$/)) {
        closeNative(); reject(new Error(value?.error || '启动器版本不支持后台连接，请运行“安装FY反代.cmd”更新。')); return;
      }
      resolve(value);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (nativePort !== port) return;
      nativePort = null;
      if (nativeRequest) {
        clearTimeout(nativeRequest.timeout);
        nativeRequest.reject(new Error('本地启动器不可用，请运行“安装FY反代.cmd”。' + (error?.message || '')));
        nativeRequest = null;
      }
      if (running || busy) {
        running = false; pollController?.abort(); cancelRequested = true;
        if (activeJob) void page('cancel', { id: activeJob.id, appId: activeJob.appId }).catch(() => {});
        note('启动器连接中断', '请保留专用卡标签；如有配置备份，请先恢复原配置。');
      }
    });
    port.postMessage({ action: 'start', port: Number(new URL(base).port) });
  });
}
async function serviceStatus(base) {
  // Chrome keeps the MV3 worker alive while this native port is connected.
  const result = await nativeStart(base);
  connection = { base, token: result.token };
  await chrome.storage.local.set({ pairedConnection: connection });
  const status = await request('/bridge/status');
  if (status.service !== 'fy-bridge' || status.version !== 1) throw new Error('本地服务版本不匹配。');
  managedService = status.nativeManaged === true; serverDirty = status.dirty === true;
  return status;
}
async function connect(options = {}) {
  await boot;
  if (running || busy || connecting || polling || stopping || stopIncomplete) return;
  connecting = true;
  const attempt = ++connectAttempt;
  const ensureCurrent = () => { if (attempt !== connectAttempt || !nativePort) throw new Error('连接已取消或启动器连接已断开。'); };
  try {
    const saved = await chrome.storage.local.get(['pairedConnection', 'cardUrl', 'recovery', 'autoConnect']);
    if (options.automatic && saved.autoConnect === false) return;
    if (saved.recovery) throw new Error('上次任务有配置备份，请先恢复；请求不会自动重发。');
    const address = options.cardUrl || saved.cardUrl;
    if (!address) { note('尚未配置专用卡', '请在连接配置中选择卡片或粘贴链接，然后点击“启动反代”。'); return; }
    const card = cardAddress(address);
    const base = serviceAddress(options.base || saved.pairedConnection?.base || 'http://127.0.0.1:43119');
    if (!options.automatic) await chrome.storage.local.set({ cardUrl: card.url, autoConnect: true, pairedConnection: { base, token: saved.pairedConnection?.token || '' } });
    note('正在连接', '请等待连接完成，并保留专用卡标签。');
    const status = await serviceStatus(base);
    ensureCurrent();
    if (status.dirty) throw new Error('服务需要恢复原配置，请先处理下方恢复提示。');
    if (status.active || status.queued || status.workerConnected) throw new Error('已有任务或其他连接尚未退出。请先在原连接停止反代；若刚重新加载插件，请稍候再试。');
    currentTab = await findTab(card.appId, true);
    ensureCurrent();
    const ready = await page('prepare', { appId: card.appId, deadline: Date.now() + 25000 });
    if (ready.error || !ready.original) throw new Error(ready.error || '无法读取专用卡，请确认已登录。');
    const configured = await request('/bridge/configure', { appId: card.appId });
    if (configured.appId !== card.appId) throw new Error('服务未确认专用卡。');
    ensureCurrent();
    connection.appId = card.appId;
    await chrome.storage.local.set({ cardUrl: card.url, autoConnect: true });
    ensureCurrent();
    running = true; polling = true;
    note('反代已启动，等待客户端请求', '请保留 FY 卡片标签和浏览器。'); loopTask = loop();
  } catch (error) { note('未连接', '请处理以下问题后重新连接：' + error.message); closeNative(); }
  finally { connecting = false; void publish(); }
}
async function disconnect() {
  connectAttempt++;
  await chrome.storage.local.set({ autoConnect: false });
  running = false; cancelRequested = true; pollController?.abort();
  if (activeJob) {
    note('正在停止并恢复原配置', '请等待恢复完成，不要关闭专用卡标签。');
    await page('cancel', { id: activeJob.id, appId: activeJob.appId }).catch(() => {});
  } else if (!polling && !stopping) closeNative();
}
async function stop() {
  if (stopping) return;
  if (connecting || busy && !polling) throw new Error('请等待当前操作完成后再停止反代。');
  stopping = true;
  stopIncomplete = true;
  note('正在停止反代', '请等待任务结束和原配置恢复，不要关闭专用卡标签。');
  try {
    await disconnect();
    if (loopTask) await loopTask;
    const saved = await chrome.storage.local.get('recovery');
    if (saved.recovery || serverDirty) throw new Error('请先使用下方恢复入口完成原配置恢复，再点击“停止反代”。');
    if (managedService) {
      await request('/bridge/shutdown', {});
      managedService = false;
    }
    closeNative();
    stopIncomplete = false;
    note('反代已停止', '点击“启动反代”可重新启动。');
  } catch (error) {
    stopIncomplete = serverDirty || !!(await chrome.storage.local.get('recovery')).recovery;
    note('反代停止未完成', '请处理以下问题：' + error.message);
  } finally { stopping = false; void publish(); }
}
async function saveConfiguration(options) {
  if (running || busy || connecting || polling || stopping || stopIncomplete) throw new Error('请先完成反代停止和原配置恢复，再保存配置。');
  const card = cardAddress(options.cardUrl);
  const base = serviceAddress(options.base);
  connecting = true;
  try {
    const saved = await chrome.storage.local.get(['pairedConnection', 'recovery']);
    if (saved.recovery || serverDirty) throw new Error('请先完成原配置恢复，再保存连接配置。');
    await chrome.storage.local.set({ cardUrl: card.url, pairedConnection: {
      base, token: saved.pairedConnection?.base === base ? saved.pairedConnection.token || '' : '',
    } });
    if (connection && connection.base !== base) {
      closeNative(); connection = null; managedService = false;
    }
    note('连接配置已保存', '点击“启动反代”使用已保存的配置。');
  } finally { connecting = false; void publish(); }
}
async function recover(manual = false) {
  if (running || busy || connecting || polling || stopping) throw new Error('请先停止反代并等待任务结束。');
  busy = true; void publish();
  try {
    const saved = await chrome.storage.local.get(['pairedConnection', 'recovery']);
    await serviceStatus(serviceAddress(saved.pairedConnection?.base || 'http://127.0.0.1:43119'));
    if (!manual) {
      if (!saved.recovery) throw new Error('没有配置备份。');
      currentTab = await findTab(saved.recovery.appId, true);
      const result = await page('recover', { ...saved.recovery, deadline: Date.now() + 25000 });
      if (result.error || result.restored !== true) throw new Error(result.error || '配置未恢复。');
    }
    await request('/bridge/unlock', { restored: true, confirm: 'configuration-restored' });
    await chrome.storage.local.remove('recovery'); serverDirty = false;
    note('原配置已恢复', stopIncomplete ? '点击“停止反代”完成关闭，然后可重新启动。' : '点击“启动反代”继续。');
  } finally { busy = false; closeNative(); void publish(); }
}
async function command(message) {
  await boot;
  switch (message.action) {
    case 'state': return state();
    case 'resume': await connect({ automatic: true }); break;
    case 'connect': await connect({ base: message.base, cardUrl: message.cardUrl }); break;
    case 'save-config': await saveConfiguration({ base: message.base, cardUrl: message.cardUrl }); break;
    case 'stop': await stop(); break;
    case 'restore': await recover(); break;
    case 'unlock': await recover(true); break;
    default: throw new Error('不支持的扩展操作。');
  }
  return state();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!trusted(sender)) return false;
  command(message).then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message })); return true;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'fy-settings' || !trusted(port.sender)) { port.disconnect(); return; }
  views.add(port); port.onDisconnect.addListener(() => views.delete(port)); void publish();
});
const resume = () => { void chrome.alarms.create('fy-resume', { periodInMinutes: 1 }); void connect({ automatic: true }); };
chrome.runtime.onStartup.addListener(resume);
chrome.runtime.onInstalled.addListener(resume);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'fy-resume') void connect({ automatic: true }); });
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId !== currentTab || (!running && !busy)) return;
  running = false; cancelRequested = true; pollController?.abort();
  note('专用卡标签已关闭', busy ? '请先查看已有结果，再恢复原配置。' : '请等待专用卡重新打开并连接。');
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== currentTab || !change.url || (!running && !busy)) return;
  try { if (cardAddress(change.url).appId === connection?.appId) return; } catch { /* The card was left. */ }
  running = false; cancelRequested = true; pollController?.abort();
  note('专用卡已离开对话页', busy ? '请先查看已有结果，并检查是否需要恢复原配置。' : '请等待专用卡重新打开并连接。');
});
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('bridge.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url });
});
async function perform(job) {
  busy = true;
  activeJob = job;
  cancelRequested = false;
  buttons();
  let result = { error: '请求尚未发送。', restored: true };
  let backupWritten = false, inRun = false, monitoring = false;
  const cancelPage = async () => {
    if (inRun && currentTab != null) await page('cancel', { id: job.id, appId: job.appId }).catch(() => {});
  };
  const monitor = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      const state = await request('/bridge/jobs/' + encodeURIComponent(job.id));
      if (state.cancelled || !running || Date.now() >= state.deadline) { cancelRequested = true; await cancelPage(); }
    } catch { cancelRequested = true; await cancelPage(); }
    finally { monitoring = false; }
  }, 2000);
  try {
    note('正在准备专用卡', '请保留专用卡标签，等待生成开始。');
    if (job.appId !== connection.appId) throw new Error('服务的专用卡与后台选择不同，请停止反代后重新连接。');
    currentTab = await findTab(job.appId);
    if ((await chrome.storage.local.get('recovery')).recovery) throw new Error('尚有未恢复的配置备份。');
    const prepared = await page('prepare', { appId: job.appId, deadline: Math.min(job.deadline, Date.now() + 20000) });
    if (prepared.error || !prepared.original) throw new Error(prepared.error || '无法取得原配置备份。');
    if (cancelRequested || !running || Date.now() >= job.deadline) throw new Error('请求在生成前已取消或超时。');
    // Persist only the original configuration, not the incoming prompt/query.
    if (prepared.conversationId !== null && (typeof prepared.conversationId !== 'string' || !prepared.conversationId)) throw new Error('网站当前会话格式不受支持，未发起生成。');
    await chrome.storage.local.set({ recovery: { appId: job.appId, conversationId: prepared.conversationId, original: prepared.original, jobId: job.id } });
    backupWritten = true;
    const finalState = await request('/bridge/jobs/' + encodeURIComponent(job.id));
    if (finalState.cancelled || cancelRequested || !running || Date.now() >= job.deadline) throw new Error('请求在生成前已取消或超时。');
    note('正在生成回复', '请保持专用卡标签打开，不要切换会话。');
    inRun = true;
    result = { restored: false, error: '页面任务中断，恢复状态未知。' };
    result = await page('run', { ...job, conversationId: prepared.conversationId, original: prepared.original });
    inRun = false;
  } catch (error) {
    result = { error: String(error.message || '桥接失败'), restored: !inRun };
  } finally {
    clearInterval(monitor);
    if (result.streamFailure) {
      // Session-only evidence belongs to the failed job, never to a retry.
      // Storage failure must not interrupt configuration recovery/result delivery.
      try { await chrome.storage.session.set({ lastStreamFailure: { jobId: job.id, ...result.streamFailure } }); }
      catch (error) { console.warn('FY stream diagnostics could not be saved:', error.message); }
      delete result.streamFailure;
    }
    if (backupWritten && result.restored === true) await chrome.storage.local.remove('recovery');
    if (result.restored !== true) running = false;
    try {
      const reply = await request('/bridge/result', { id: job.id, ...result });
      if (reply.dirty) running = false;
      note(result.error ? '本次请求失败' : '本次请求已返回，等待客户端请求', result.error ? '请先查看已有结果，并处理以下问题：' + result.error : '请保留卡片标签和浏览器。');
      await recoveryUi(reply.dirty);
    } catch (error) {
      running = false;
      note('结果回传失败', '请先查看客户端和 FY 的已有结果，再恢复连接。错误详情：' + error.message);
      await recoveryUi(true);
    }
    activeJob = null;
    busy = false;
    buttons();
  }
}

async function loop() {
  try {
    while (running) {
      pollController = new AbortController();
      const timeout = setTimeout(() => pollController?.abort(), 25000);
      let job;
      try { job = await request('/bridge/claim', undefined, pollController.signal); }
      finally { clearTimeout(timeout); pollController = null; }
      if (job) await perform(job);
    }
  } catch (error) {
    const intended = !running;
    running = false;
    if (!intended) note('连接已停止', '请处理以下问题后重新连接：' + error.message);
  } finally {
    running = false;
    if (!busy) await request('/bridge/disconnect', {}).catch(() => {});
    polling = false; if (!stopping) closeNative();
    buttons();
  }
}


