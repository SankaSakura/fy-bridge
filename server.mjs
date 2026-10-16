import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, MODEL, mapRequest, completion } from './protocol.mjs';
import { bridgeDataDirectory } from './local-paths.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('FY 本地反代需要 Node.js 22 或更高版本。');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 缺少值`);
  return args[i + 1];
};
for (let i = 0; i < args.length; i += 2) if (!['--port', '--app-id', '--timeout-seconds', '--native-managed'].includes(args[i])) throw new Error(`未知参数 ${args[i]}`);
const port = Number(option('--port', '43119'));
const timeoutSeconds = Number(option('--timeout-seconds', '180'));
let appId = option('--app-id', null)?.toLowerCase() ?? null;
const nativeMode = option('--native-managed', 'off');
if (!['on', 'off'].includes(nativeMode)) throw new Error('native-managed 参数必须是 on 或 off。');
const nativeManaged = nativeMode === 'on';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需要在 1024—65535 之间。');
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) throw new Error('超时需要在 30—1800 秒之间。');
if (appId !== null && !appId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) throw new Error('app-id 必须是空白卡 UUID。');

const dataDir = await bridgeDataDirectory(root);
await mkdir(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, 'token.txt');
let token;
try { token = (await readFile(tokenFile, 'utf8')).trim(); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!token) {
  token = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
}
if (!token.match(/^[A-Za-z0-9_-]{43}$/)) throw new Error('本地 API 密钥文件格式无效。请备份 .local/fy-bridge/token.txt 后将其移走，再重新启动并更新客户端密钥。');
const baseUrl = `http://127.0.0.1:${port}`;
await writeFile(path.join(dataDir, 'connection.txt'), `API 地址：${baseUrl}/v1\nAPI 密钥：${token}\n客户端模型名：${MODEL}\n首次安装：运行“安装FY反代.cmd”，然后按安装引导加载浏览器扩展。\n开始使用：在扩展中选择专用卡，点击“启动反代”。密钥会自动填入扩展。\n本地服务地址：${baseUrl}\n客户端超时建议至少 ${timeoutSeconds + 30} 秒。\n本文件是连接信息备份，包含密钥，请勿分享。\n`, { mode: 0o600 });

const jobs = new Map();
const queue = [];
let active = null;
let worker = null;
let dirty = false;
let claimWaiter = null;
let stopping = false;

const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const failure = (res, e) => json(res, e.status || 500, { error: { message: e.message || '桥接内部错误', type: 'bridge_error', code: e.code || 'bridge_error', param: null } });
const authenticated = req => {
  const value = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
};
async function body(req, max = 2 * 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError(415, 'json_required', '需要 application/json。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new BridgeError(413, 'request_too_large', '请求超过桥接大小限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError(400, 'invalid_json', 'JSON 格式无效。'); }
}
function settle(job, error, output) {
  if (job.settled) return;
  job.settled = true;
  job.payload = null;
  if (error) job.reject(error); else job.resolve(output);
}
function cancel(job, reason, status = 504, code = 'cancelled_or_timeout') {
  job.cancelled = true;
  settle(job, new BridgeError(status, code, reason));
  if (active !== job) {
    jobs.delete(job.id);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }
}
function claim(req, res, id) {
  if (claimWaiter) throw new BridgeError(409, 'worker_busy', '已有一个扩展后台正在领取任务。');
  if (worker && worker.id !== id && Date.now() - worker.seen < 45000) throw new BridgeError(409, 'worker_busy', '只能连接一个扩展后台。');
  worker = { id, seen: Date.now() };
  const deliver = () => {
    if (res.destroyed || res.writableEnded) return true;
    while (queue.length && (queue[0].settled || queue[0].deadline <= Date.now())) {
      const skipped = queue.shift();
      if (!skipped.settled) cancel(skipped, '请求在队列中超时，未发起生成。');
    }
    if (dirty || active || !queue.length) return false;
    const job = queue.shift();
    job.worker = id;
    active = job;
    json(res, 200, { id: job.id, deadline: job.deadline, appId: job.appId, ...job.payload });
    job.payload = null;
    return true;
  };
  if (deliver()) return;
  const timer = setTimeout(() => { if (claimWaiter?.res === res) claimWaiter = null; if (!res.destroyed) { res.writeHead(204); res.end(); } }, 20000);
  claimWaiter = { res, deliver, timer };
  res.on('close', () => { clearTimeout(timer); if (claimWaiter?.res === res) claimWaiter = null; });
}
function wake() {
  const waiter = claimWaiter;
  if (waiter?.deliver()) { clearTimeout(waiter.timer); if (claimWaiter === waiter) claimWaiter = null; }
}
function owner(req, job) {
  if (!job || req.headers['x-bridge-worker'] !== job.worker) throw new BridgeError(409, 'job_not_owned', '任务不存在，或由另一个扩展后台处理。');
  worker = { id: job.worker, seen: Date.now() };
}
function sendCompletion(res, mapped, output) {
  if (res.destroyed || res.writableEnded) return;
  const value = completion(output.text, output.finishReason);
  if (!mapped.stream) return json(res, 200, value);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-FY-Stream-Mode': 'buffered' });
  const chunk = (delta, finish) => ({ id: value.id, object: 'chat.completion.chunk', created: value.created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }, null))}\n\n`);
  let piece = '';
  for (const character of output.text) {
    piece += character;
    if (piece.length >= 16000) {
      res.write(`data: ${JSON.stringify(chunk({ content: piece }, null))}\n\n`);
      piece = '';
    }
  }
  if (piece) res.write(`data: ${JSON.stringify(chunk({ content: piece }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, output.finishReason))}\n\n`);
  if (mapped.includeUsage) res.write(`data: ${JSON.stringify({ id: value.id, object: 'chat.completion.chunk', created: value.created, model: MODEL, choices: [], usage: null })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (stopping) throw new BridgeError(503, 'stopping', '桥接正在退出。');
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw new BridgeError(403, 'invalid_host', '仅接受本机地址。');
    const origin = req.headers.origin;
    if (origin && !origin.match(/^chrome-extension:\/\/[a-p]{32}$/)) throw new BridgeError(403, 'invalid_origin', '普通网页不能访问桥接。');
    const url = new URL(req.url, baseUrl);
    if (!authenticated(req)) throw new BridgeError(401, 'unauthorized', '本地 API 密钥不正确。');
    if (req.method === 'GET' && ['/v1/models', '/models'].includes(url.pathname)) return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'local-fy-bridge' }] });
    if (req.method === 'GET' && url.pathname === '/bridge/status') return json(res, 200, { version: 1, service: 'fy-bridge', nativeManaged, configurableCard: true, appId, dirty, queued: queue.filter(j => !j.settled).length, active: active?.id || null, workerConnected: !!worker && Date.now() - worker.seen < 45000, streamMode: 'buffered' });
    if (req.method === 'POST' && url.pathname === '/bridge/shutdown') {
      await body(req, 1024);
      if (!nativeManaged) throw new BridgeError(409, 'manual_service', '此服务由 CMD 手动启动，请在原终端按 Ctrl+C 停止。');
      if (dirty || active || queue.some(job => !job.settled) || claimWaiter || (worker && Date.now() - worker.seen < 45000)) throw new BridgeError(409, 'bridge_busy', '请先停止接收请求，等待当前任务结束并恢复原配置。');
      json(res, 200, { stopped: true });
      shutdown();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/configure') {
      const value = await body(req);
      if (typeof value?.appId !== 'string' || !value.appId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) throw new BridgeError(400, 'invalid_app_id', '专用卡地址中的 UUID 无效。');
      if (dirty) throw new BridgeError(423, 'restore_required', '请先恢复上一张卡的原配置，再切换专用卡。');
      if (active || queue.some(job => !job.settled) || claimWaiter || (worker && Date.now() - worker.seen < 45000)) throw new BridgeError(409, 'bridge_busy', '请先停止反代，等待原配置恢复后再更换专用卡。');
      appId = value.appId.toLowerCase();
      worker = null;
      return json(res, 200, { appId });
    }
    if (req.method === 'GET' && url.pathname === '/bridge/claim') {
      if (!appId) throw new BridgeError(409, 'card_required', '尚未配置专用卡，请在扩展中填写自己的专用空白卡地址并保存连接。');
      const id = req.headers['x-bridge-worker'];
      if (typeof id !== 'string' || !id.match(/^[a-zA-Z0-9-]{1,80}$/)) throw new BridgeError(400, 'worker_required', '缺少扩展后台标识，请重新加载插件。');
      return claim(req, res, id);
    }
    if (req.method === 'POST' && url.pathname === '/bridge/disconnect') {
      if (worker && worker.id !== req.headers['x-bridge-worker']) throw new BridgeError(409, 'worker_not_owned', '连接属于另一个扩展后台，请先在那里停止反代。');
      if (active) throw new BridgeError(409, 'still_running', '请等待当前任务恢复配置。');
      if (claimWaiter) {
        clearTimeout(claimWaiter.timer);
        claimWaiter.res.writeHead(204); claimWaiter.res.end(); claimWaiter = null;
      }
      for (const job of [...queue]) cancel(job, '反代已停止，排队请求未发送。请重新启动反代后再提交。', 503, 'bridge_stopped');
      worker = null;
      json(res, 200, { disconnected: true });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/bridge/jobs/')) {
      const job = jobs.get(url.pathname.slice('/bridge/jobs/'.length));
      owner(req, job);
      return json(res, 200, { cancelled: job.cancelled, deadline: job.deadline });
    }
    if (req.method === 'POST' && url.pathname === '/bridge/result') {
      const result = await body(req, 8 * 1024 * 1024);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BridgeError(400, 'invalid_result', '任务结果必须是 JSON 对象。');
      const job = jobs.get(result.id);
      owner(req, job);
      if (active !== job) throw new BridgeError(409, 'job_not_active', '任务不是当前活动任务。');
      if (result.restored !== true) dirty = true;
      if (result.error) settle(job, new BridgeError(502, 'fy_error', String(result.error).slice(0, 600)));
      else if (result.restored !== true) settle(job, new BridgeError(502, 'restore_failed', 'FY 原配置尚未恢复；请在扩展设置页完成恢复。'));
      else if (typeof result.text !== 'string' || !result.text.length || result.text.length > 4 * 1024 * 1024 || !['stop', 'length', 'content_filter'].includes(result.finishReason)) settle(job, new BridgeError(502, 'invalid_upstream_result', 'fy 回复格式不受支持。'));
      else settle(job, null, { text: result.text, finishReason: result.finishReason });
      jobs.delete(job.id);
      active = null;
      json(res, 200, { accepted: true, dirty });
      wake();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/unlock') {
      const value = await body(req);
      if (value?.restored !== true || value.confirm !== 'configuration-restored') throw new BridgeError(400, 'restore_required', '请先在扩展设置页确认原配置已恢复。');
      if (active && worker && Date.now() - worker.seen < 15000) throw new BridgeError(409, 'still_running', '当前任务仍在处理或恢复配置。');
      if (active) { cancel(active, '原任务已中断，未自动重发。请确认已有结果后再提交。', 503, 'task_interrupted'); jobs.delete(active.id); active = null; }
      dirty = false;
      worker = null;
      json(res, 200, { unlocked: true });
      wake();
      return;
    }
    if (req.method === 'POST' && ['/v1/chat/completions', '/chat/completions'].includes(url.pathname)) {
      if (!appId) throw new BridgeError(409, 'card_required', '尚未配置专用卡，请在扩展中填写自己的专用空白卡地址并保存连接。');
      if (dirty) throw new BridgeError(423, 'restore_required', '上次任务未确认恢复配置；请先在扩展设置页完成恢复。');
      if (!worker || Date.now() - worker.seen > 45000) throw new BridgeError(503, 'browser_offline', '扩展后台未连接。请打开 FY 扩展设置查看连接状态。');
      if (queue.filter(j => !j.settled).length >= 8) throw new BridgeError(429, 'queue_full', '桥接队列已满。');
      const mapped = mapRequest(await body(req));
      if (dirty || !worker || Date.now() - worker.seen > 45000) throw new BridgeError(503, 'browser_not_ready', '扩展后台当前不可用。');
      if (queue.filter(j => !j.settled).length >= 8) throw new BridgeError(429, 'queue_full', '桥接队列已满。');
      let resolve, reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; });
      const job = { id: randomUUID(), appId, deadline: Date.now() + timeoutSeconds * 1000, payload: { system: mapped.system, query: mapped.query }, resolve, reject, settled: false, cancelled: false };
      jobs.set(job.id, job);
      queue.push(job);
      res.on('close', () => { if (!job.settled) cancel(job, '客户端已断开；不会自动重发，网站上已开始的生成仍可能扣费。'); });
      wake();
      sendCompletion(res, mapped, await result);
      return;
    }
    throw new BridgeError(404, 'not_found', '接口不存在。');
  } catch (e) { failure(res, e); }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
const timer = setInterval(() => {
  for (const job of jobs.values()) if (!job.settled && Date.now() >= job.deadline) cancel(job, '桥接超时；未自动重发，请先查看 fy 中是否已有结果。');
  if (active && worker && Date.now() - worker.seen > 15000) {
    dirty = true;
    active.cancelled = true;
    settle(active, new BridgeError(502, 'browser_lost', '浏览器任务失联，配置恢复状态未知；请在扩展设置页完成恢复。'));
  }
}, 1000);
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : '本地服务无法启动。'); process.exitCode = 1; clearInterval(timer); });
server.listen(port, '127.0.0.1', () => {
  console.log(`FY 本地反代服务已启动\nAPI 地址：${baseUrl}/v1\n客户端模型名：${MODEL}\n连接信息备份：${path.join(dataDir, 'connection.txt')}`);
  console.log('在浏览器中打开 FY 本地反代扩展，选择专用卡并启动反代。按 Ctrl+C 关闭手动启动的服务。');
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const job of jobs.values()) cancel(job, '桥接服务已关闭；不会自动重发。');
  clearInterval(timer);
  if (claimWaiter) { clearTimeout(claimWaiter.timer); claimWaiter.res.end(); claimWaiter = null; }
  server.close();
  setTimeout(() => { server.closeAllConnections(); process.exit(); }, 1200).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
