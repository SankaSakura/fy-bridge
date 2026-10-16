import { stat, rename } from 'node:fs/promises';
import path from 'node:path';

// Migrate local credentials without changing their values. The old spelling
// exists here only for upgrades from installations made before the rename.
export async function bridgeDataDirectory(root) {
  const current = path.join(root, '.local/fy-bridge');
  try { await stat(current); return current; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(path.join(root, '.local/aifun-bridge'), current); }
  catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  return current;
}
