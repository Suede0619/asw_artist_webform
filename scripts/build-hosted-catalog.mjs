import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createObjectMedia } from '../server/object-media.mjs';

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
  const release = join(checkout, 'production-release');
  const photos = JSON.parse(await readFile(join(release, 'venue-photos.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  }));
  const storage = {
    bucket: process.env.NEON_MEDIA_BUCKET || 'uploads',
    endpoint: process.env.AWS_ENDPOINT_URL_S3, region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
  if (photos.length && Object.values(storage).every(Boolean)) {
    const media = createObjectMedia(storage);
    try {
      for (const path of photos) {
        if (!/^assets\/[a-z0-9-]+-[a-f0-9]{12}\.webp$/.test(path)) throw new Error('Invalid venue photo path.');
        const bytes = await media.get('venue-photos', basename(path));
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        if (!path.endsWith('-' + hash + '.webp')) throw new Error('Venue photo content does not match ' + path);
        await writeFile(join(release, 'public', path), bytes);
      }
    } finally {
      media.close();
    }
    console.log('Packaged ' + photos.length + ' venue photos from Object Storage.');
  } else if (photos.length) {
    if (process.env.NODE_ENV === 'production') throw new Error('Configure Object Storage to package venue photos.');
    console.log('Verified venue photo references. Set the Object Storage credentials to package the files.');
  }
  await mkdir(resolve('build'), { recursive: true });
  await rm(output, { recursive: true, force: true });
  await cp(release, output, { recursive: true });
  console.log('Staged the verified catalog revision ' + revision.slice(0, 12) + ' in ' + output);
} finally {
  await rm(checkout, { recursive: true, force: true });
}
