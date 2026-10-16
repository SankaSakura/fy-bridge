import { readFile, mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeDataDirectory } from '../local-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await bridgeDataDirectory(root);
const tokenPath = path.join(dataDir, 'token.txt');

async function key() {
  try {
    const value = (await readFile(tokenPath, 'utf8')).trim();
    if (!value) return null;
    if (!value.match(/^[A-Za-z0-9_-]{43}$/)) throw new Error('本地密钥格式无效，请保留文件并查看使用说明。');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function status(port) {
  const token = await key();
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/bridge/status`, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error('本地端口无响应，未重复启动服务；请确认地址和端口。');
  }
  if (!response.ok) throw new Error('本地端口已被使用，或密钥不匹配；未结束已有进程。');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new Error('本地端口返回了不支持的信息。'); }
    chunks.push(next.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (value.service !== 'fy-bridge' || value.version !== 1 || !token) throw new Error('端口上运行的服务版本不匹配，请先关闭旧桥接服务再启动。');
  return { token, nativeManaged: value.nativeManaged === true };
}

async function start(port) {
  const existing = await status(port);
  if (existing) return { ...existing, started: false };
  await mkdir(dataDir, { recursive: true });
  const log = await open(path.join(dataDir, 'native-start.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--native-managed', 'on'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await delay(250);
    const ready = await status(port);
    if (ready) return { ...ready, started: true };
  }
  throw new Error('服务未在等待时间内就绪；未重复启动，请查看 .local/fy-bridge/native-start.log。');
}

async function handle(request) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('浏览器启动器需要 Windows 和 Node.js 22 或更高版本。');
  if (request?.action !== 'start' || !Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) throw new Error('启动器只接受本地桥接启动请求和有效端口。');
  return { ok: true, nativeProtocol: 2, base: `http://127.0.0.1:${request.port}`, ...await start(request.port) };
}

function reply(result) {
  const message = Buffer.from(JSON.stringify(result), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(message.length);
  process.stdout.write(Buffer.concat([header, message]));
}
// Remain alive until Chrome closes stdin. No periodic shell commands, service
// restart or generation retries are performed by this native connection.
let pending = Buffer.alloc(0);
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (!length || length > 65536) throw new Error('原生消息过大。');
      if (pending.length < length + 4) break;
      const frame = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      try { reply(await handle(JSON.parse(frame.toString('utf8')))); }
      catch (error) { reply({ ok: false, error: error.message || '本地启动失败。' }); }
    }
    if (pending.length > 65540) throw new Error('原生消息过大。');
  }
} catch { reply({ ok: false, error: '原生消息格式无效，连接已关闭。' }); }
