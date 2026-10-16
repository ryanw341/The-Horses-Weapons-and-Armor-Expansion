import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'module.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Package and manifest versions differ.');
if (!manifest.download.endsWith(`/v${manifest.version}/${manifest.id}-${manifest.version}.zip`)) {
  throw new Error('Download URL does not match the packaged version.');
}
for (const file of [...manifest.esmodules, ...(manifest.styles ?? [])]) await stat(path.join(root, file));
for (const file of await readdir(path.join(root, 'scripts'))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'scripts', file)], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
}
console.log('Manifest paths, versions, download URL, and JavaScript syntax checked.');
