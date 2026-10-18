import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function createTrafficLog(dataDir) {
  const directory = path.join(dataDir, 'logs');
  await mkdir(directory, { recursive: true });
  let pending = Promise.resolve();
  return record => {
    const now = new Date();
    const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const line = JSON.stringify({ version: 1, recordedAt: now.toISOString(), ...record }) + '\n';
    // Serialize appends, but allow the next record after a failed disk write.
    const write = pending.then(() => appendFile(path.join(directory, `fy-traffic-${day}.log`), line, { encoding: 'utf8', mode: 0o600 }));
    pending = write.catch(() => {});
    return write;
  };
}
