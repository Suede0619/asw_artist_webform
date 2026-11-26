import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = 'https://github.com/Suede0619/sw-arts-website.git';
const revision = (process.env.CATALOG_REF || readFileSync(new URL('../catalog-release.txt', import.meta.url), 'utf8')).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Set CATALOG_REF to the full Git commit SHA of the reviewed catalog.');
const checkout = await mkdtemp(join(tmpdir(), 'asw-catalog-'));
const output = resolve('build/catalog');
const command = (command, args) => execFileSync(command, args, { cwd: checkout, stdio: 'inherit', timeout: 120_000 });
try {
  command('git', ['init', '--quiet']);
  command('git', ['fetch', '--quiet', '--depth=1', source, revision]);
  command('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD']);
  command(process.execPath, ['tools/build-production.mjs']);
  await mkdir(resolve('build'), { recursive: true });
  await rm(output, { recursive: true, force: true });
  await cp(join(checkout, 'production-release'), output, { recursive: true });
  console.log('Staged the verified catalog revision ' + revision.slice(0, 12) + ' in ' + output);
} finally {
  await rm(checkout, { recursive: true, force: true });
}
