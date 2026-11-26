import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { cookie } from '../server/security.mjs';
import { createPublicationFeed } from '../server/publications.mjs';

process.umask(0o077);
const host = process.env.HOST || '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR || 'data/callback-intake');
const artistUrl = process.env.ARTIST_ORIGIN || 'https://artist.artsouthwest.com';
const curatorUrl = process.env.CURATOR_ORIGIN || 'https://curator.artsouthwest.com';
const catalogUrl = process.env.CATALOG_ORIGIN || 'https://artsouthwest.com';
const env = {
  ...process.env,
  HOST: host,
  PUBLIC_URL: artistUrl,
  TRUST_PROXY_HOPS: '1',
  PORT: process.env.PORT || '4280',
  DATA_DIR: dataDir,
  REVIEWER_PASSWORD: process.env.REVIEWER_PASSWORD || readFileSync(resolve(dataDir, 'reviewer-password'), 'utf8').trim(),
};
const config = loadConfig(env);
if (!config.databaseUrl) throw new Error('The production origin requires Neon and Object Storage.');
if (!config.catalogDir) throw new Error('Build and configure CATALOG_DIR.');
const rendererPath = resolve(config.catalogDir, 'catalog-renderer.mjs');
const renderer = existsSync(rendererPath) ? (await import(pathToFileURL(rendererPath))).catalog : null;
const publicCatalogDir = renderer ? resolve(config.catalogDir, 'public') : config.catalogDir;
if (!existsSync(resolve(publicCatalogDir, 'index.html'))) throw new Error('Build the catalog before starting the app.');
if (config.reviewerPassword.length < 24) throw new Error('Configure the private reviewer password.');

function atOrigin(url, overrides = {}) {
  const origin = new URL(url);
  if (origin.origin !== url || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Configure an exact origin.');
  return { ...config, publicUrl: origin.origin, artistPublicUrl: artistUrl,
    secureCookie: origin.protocol === 'https:', ...overrides };
}

let publications;
const publicationCallbacks = { onPublicationChange: () => publications.invalidate() };
const mailEnabled = config.mailEnabled && Boolean(config.smtpUrl);
const artist = createApp(atOrigin(artistUrl, {
  catalogDir: null, mailEnabled, reviewerPassword: '', reviewerTeamAccess: '',
}), publicationCallbacks);
const curator = createApp(atOrigin(curatorUrl, { catalogDir: null, mailEnabled }), {
  ...publicationCallbacks, onEditorialChange: () => catalog.editorial?.invalidateCalendar(),
});
const catalog = createApp(atOrigin(catalogUrl, { mailEnabled: false, reviewerPassword: '', reviewerTeamAccess: '' }), {
  serveUi: false, getPublications: () => publications.read(), cacheCalendar: true,
});
publications = createPublicationFeed(catalog.db);
const sites = new Map();
const artistAssets = /^\/(?:assets\/[^/]+|adobe-door\.jpg|ArtSouthwest-wordmark\.png|ArtSouthwest\.svg|fonts\/[^/]+)$/;
const artistPages = new Set(['/', '/apply', '/start', '/resume', '/callback', '/privacy']);
const artistApi = /^\/api\/(?:health|visit|start|callbacks|session\/(?:redeem|logout)|application(?:\/(?:submit|revise|link|saved-link|report|assets(?:\/[^/]+)?))?)\/?$/;
const catalogApi = /^\/api\/(?:health|catalog(?:\/media\/[^/]+)?|itinerary|editorial(?:\/.*)?)\/?$/;
const reviewApi = /^\/api\/review(?:\/.*)?$/;
const legacyArtistPages = new Set(['/apply', '/start', '/resume', '/callback', '/privacy']);
const hostOf = (url) => new URL(url).host;

function addSite(url, route) {
  const name = hostOf(url);
  if (sites.has(name)) throw new Error('Configure a different hostname for each site.');
  sites.set(name, route);
}
function noPage(res) {
  res.status(404).send('Page not found.');
}
function getPage(req) {
  return req.path.replace(/\/+$/, '') || '/';
}

const artistSite = express().disable('x-powered-by');
artistSite.use((req, res, next) => {
  if (artistPages.has(getPage(req)) || artistAssets.test(req.path) || artistApi.test(req.path)) return next();
  noPage(res);
});
artistSite.use(artist.app);
addSite(artistUrl, artistSite);

const curatorSite = express().disable('x-powered-by');
curatorSite.get('/', (_req, res) => res.redirect(302, '/review'));
curatorSite.use((req, res, next) => {
  if (getPage(req) === '/review' || artistAssets.test(req.path) || reviewApi.test(req.path)) return next();
  noPage(res);
});
curatorSite.use(curator.app);
addSite(curatorUrl, curatorSite);

const catalogSite = express().disable('x-powered-by');
catalogSite.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  if (catalogUrl.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
catalogSite.use(async (req, res, next) => {
  if (!['GET','HEAD'].includes(req.method)) return next();
  const path = getPage(req);
  const query = new URL(req.originalUrl, catalogUrl).searchParams;
  const oldCampaign = path === '/' && query.get('campaign') === 'taos-artists';
  if (path === '/discover') return res.redirect(302, '/');
  if (!oldCampaign && !legacyArtistPages.has(path)) return next();
  const oldCookie = cookie(req, 'asw_artist');
  if (req.method === 'GET' && oldCookie && ['/apply','/start'].includes(path)) {
    const transfer = await catalog.intake.transferSession(oldCookie);
    if (transfer) return res.redirect(302, artistUrl + '/resume#' + transfer);
  }
  const target = new URL(path, artistUrl);
  if (query.get('campaign') === 'taos-artists') target.searchParams.set('campaign', 'taos-artists');
  if (path === '/apply' && query.get('manage') === '1') target.searchParams.set('manage', '1');
  res.redirect(302, target.href);
});
catalogSite.use((req, res, next) => {
  if (catalogApi.test(req.path)) return catalog.app(req, res);
  if (req.path.startsWith('/api/')) return noPage(res);
  next();
});
if (renderer) {
  if (config.editorial) catalogSite.get('/ArtSouthwest-wordmark.png', (_req,res) => {
    res.sendFile(resolve('dist/ArtSouthwest-wordmark.png'),{ maxAge:'1h' });
  });
  catalogSite.use('/assets', express.static(resolve(publicCatalogDir, 'assets'), {
    dotfiles: 'deny', maxAge: '1d', setHeaders: (res, file) => {
      if (/catalog-[a-f0-9]+\.(css|mjs)$/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
      if (/santa-fe-[a-z0-9-]+-[a-f0-9]{12}\.webp$/.test(file)) {
        res.set('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    },
  }));
  catalogSite.get(/^(?!\/assets\/).*$/, async (req, res) => {
    const path = getPage(req);
    let editorial = null;
    if (catalog.editorial) {
      const needsCalendar = /^\/(?:$|(?:taos|santa-fe)(?:$|\/whats-on(?:\/|$)))/.test(path);
      const date = /^\/weekly\/(\d{4}-\d{2}-\d{2})$/.exec(path)?.[1];
      const issueList = path === '/weekly' ? (await catalog.newsletter.list()).filter(issue=>issue.state==='sent') : [];
      const issue = date ? await catalog.newsletter.get(date).catch(error => {
        if (error.status !== 404) throw error;
        return null;
      }) : null;
      editorial = { ...(needsCalendar ? await catalog.editorial.calendar() : {}),
        signup:config.editorial.signup, issue:issue?.state==='sent' ? issue.contents : null, issueList,
        sponsorEnabled:config.editorial.sponsorPrice>0 && Boolean(config.editorial.stripe.key && config.editorial.stripe.webhook),
        sponsorPrice:config.editorial.sponsorPrice };
    }
    const page = renderer.render(path, renderer.usesPublications(path) ? publications.read() : [],
      { artistOrigin:artistUrl,editorial,query:new URL(req.originalUrl,catalogUrl).searchParams });
    res.status(page.status).type('html').send(page.html);
  });
} else catalogSite.use(express.static(publicCatalogDir, { dotfiles: 'deny', cacheControl: false }));
catalogSite.use((_req, res) => noPage(res));
catalogSite.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Catalog request stopped:', error.code || error.name);
  res.status(500).send('ArtSouthwest is temporarily unavailable.');
});
addSite(catalogUrl, catalogSite);

const appInstances = [artist, curator, catalog];
try {
  const schema = await artist.db.prepare('SELECT version FROM asw_schema_migrations WHERE version=1').get();
  if (!schema) throw new Error('Run the Neon schema migration first.');
  if (config.editorial && !(await artist.db.prepare('SELECT version FROM asw_schema_migrations WHERE version=2').get())) {
    throw new Error('Run the editorial migration before enabling MVP2.');
  }
  await publications.refresh();
  await catalog.editorial?.calendar();
} catch (error) {
  await Promise.all(appInstances.map(instance => instance.db.close()));
  console.error('Neon startup check failed.', error.code || error.name);
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
  }
  const route = sites.get(String(req.headers.host || '').toLowerCase());
  if (route) return route(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Page not found.');
});
server.requestTimeout = 90_000;
server.headersTimeout = 20_000;
server.listen(config.port, host, () => {
  console.log('ArtSouthwest catalog, artist submissions, and the curator desk are ready on private port ' + config.port + '.');
  console.log('Storage: Neon Postgres and private Object Storage.');
});
const queue = mailEnabled ? setInterval(() => {
  artist.outbox.pump().catch(() => console.error('The transactional email queue needs attention.'));
}, 2000) : null;
queue?.unref();
let editorialRun;
const editorialQueue = config.editorial?.jobs ? setInterval(() => {
  if (editorialRun) return;
  editorialRun = catalog.newsletter.jobs().catch(() => console.error('Editorial jobs need attention.'))
    .finally(() => { editorialRun = null; });
}, 60_000) : null;
editorialQueue?.unref();

function stop() {
  if (queue) clearInterval(queue);
  if (editorialQueue) clearInterval(editorialQueue);
  server.close(async () => {
    await artist.outbox.drain()?.catch(() => null);
    await editorialRun;
    await Promise.all(appInstances.map(instance => instance.db.close()));
  });
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
