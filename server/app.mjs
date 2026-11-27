import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { callbackSchema, campaignId, cleanEmail, MAX_BYTES, reportSchema, reviewerActionSchema, revisionSchema, saveSchema } from '../shared/intake.mjs';
import { createStore } from './store.mjs';
import { createObjectMedia } from './object-media.mjs';
import { IntakeError } from './errors.mjs';
import { createEditorial } from './editorial.mjs';
import { installEditorial } from './editorial-routes.mjs';
import { createIntake, editable } from './intake.mjs';
import { itineraryRequest, planItinerary } from './itinerary.mjs';
import { createOutbox, retryMail } from './mail.mjs';
import { assetDirectory, mediaPath, prepareImage, MAX_ASSETS_PER_APPLICATION, writeAsset } from './media.mjs';
import { cookie, DAY, digest, HOUR, rateLimit, sameSecret, secret } from './security.mjs';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const ARTIST_COOKIE = 'asw_artist';
const REVIEWER_COOKIE = 'asw_review';
const uuid = z.uuid();
const token = z.string().regex(/^[\w-]{43}$/);
const eventRequest = z.object({ campaign: z.string().optional(), session: uuid });

export function createApp(config, { sendMail, serveUi = true, getPublications, onPublicationChange, onEditorialChange, cacheCalendar } = {}) {
  const db = createStore(config);
  const media = config.objectStorage ? createObjectMedia(config.objectStorage) : null;
  const intake = createIntake(db, config);
  const outbox = createOutbox(db, config, sendMail);
  const app = express();
  let activeUploads = 0;
  async function updatePublications() {
    await onPublicationChange?.().catch(() => console.error('The public catalog will refresh on its next read.'));
  }
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:" +
        (config.editorial && config.reviewerPassword ? ' ' + config.editorial.origin + "; style-src 'self' 'unsafe-inline'" : '') +
        "; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    if (config.secureCookie) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  function cookieOptions(path, maxAge) {
    return { httpOnly: true, secure: config.secureCookie, sameSite: 'lax', path, ...(maxAge ? { maxAge } : {}) };
  }

  async function requireRate(req, scope, limit, period = HOUR) {
    if (!(await rateLimit(db, config.mailKey, scope, req.ip || 'unknown', limit, period))) {
      throw new IntakeError(429, 'Please wait before trying again.');
    }
  }

  function authenticate(table, name, req) {
    const raw = cookie(req, name);
    if (!raw) return null;
    return db.prepare('SELECT * FROM ' + table + ' WHERE hash=? AND expires_at>?').get(digest(raw), Date.now());
  }

  async function artistId(req) {
    const session = await authenticate('artist_sessions', ARTIST_COOKIE, req);
    if (!session) throw new IntakeError(401, 'Return in the browser you used to start this submission.');
    return session.app_id;
  }

  async function writableArtist(req) {
    const id = await artistId(req);
    if (req.get('X-Application-Id') !== id) {
      throw new IntakeError(409, 'This tab no longer matches the open submission. Reopen your private link.');
    }
    return id;
  }

  async function reviewer(req, _res, next) {
    if (!(await authenticate('reviewer_sessions', REVIEWER_COOKIE, req))) {
      throw new IntakeError(401, 'Sign in to the review desk.');
    }
    next();
  }

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Intake-Request') !== '1' ||
          (req.get('Origin') && req.get('Origin') !== config.publicUrl) ||
          req.get('Sec-Fetch-Site') === 'cross-site') {
        throw new IntakeError(403, 'This request must come from the ArtSouthwest form.');
      }
    }
    next();
  });
  api.use(express.json({ limit: '80kb' }));

  api.get('/health', async (_req, res) => {
    await db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });

  api.post('/itinerary', async (req, res) => {
    if (!config.catalogDir) throw new IntakeError(404, 'Not found.');
    await requireRate(req, 'itinerary-ip', 15);
    const input = itineraryRequest.parse(req.body);
    const useModel = config.itineraryKey && await rateLimit(db, config.mailKey, 'itinerary-model', 'global', 60, DAY);
    res.json(await planItinerary(input, { ...config, itineraryKey: useModel ? config.itineraryKey : '' }));
  });

  api.post('/visit', async (req, res) => {
    await requireRate(req, 'visit', 150);
    const { campaign, session } = eventRequest.parse(req.body);
    await db.prepare('INSERT INTO landing_sessions(id,campaign,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(session, campaignId(campaign), Date.now());
    res.sendStatus(204);
  });

  api.post('/start', async (req, res) => {
    if (config.mailEnabled === false) throw new IntakeError(503, 'Email links are unavailable. Return on the browser you used to start your submission.');
    await requireRate(req, 'mail-ip', 30);
    const data = z.object({ email: cleanEmail, mode: z.enum(['start', 'resume']), campaign: z.string().optional() }).parse(req.body);
    if (await rateLimit(db, config.mailKey, 'mail-email', data.email, 4, HOUR)) {
      await intake.start(data.email, campaignId(data.campaign), data.mode === 'start');
    }
    res.status(202).json({ accepted: true });
  });

  api.post('/callbacks', async (req, res) => {
    await requireRate(req, 'call', 25);
    await intake.callback(callbackSchema.parse(req.body));
    res.status(202).json({ accepted: true });
  });

  api.post('/session/redeem', async (req, res) => {
    await requireRate(req, 'redeem', 60);
    const { token: link } = z.object({ token }).parse(req.body);
    const { session, application } = await intake.redeem(link);
    const current = cookie(req, ARTIST_COOKIE);
    if (current) await db.prepare('DELETE FROM artist_sessions WHERE hash=?').run(digest(current));
    res.cookie(ARTIST_COOKIE, session, cookieOptions('/', 7 * DAY)).json(application);
  });

  api.post('/session/logout', async (req, res) => {
    const raw = cookie(req, ARTIST_COOKIE);
    if (raw) await db.prepare('DELETE FROM artist_sessions WHERE hash=?').run(digest(raw));
    res.clearCookie(ARTIST_COOKIE, cookieOptions('/')).sendStatus(204);
  });

  api.get('/application', async (req, res) => res.json(await intake.view(await intake.get(await artistId(req)))));
  api.post('/application', async (req, res) => {
    const current = await authenticate('artist_sessions', ARTIST_COOKIE, req);
    if (current) return res.json(await intake.view(await intake.get(current.app_id)));
    await requireRate(req, 'draft-start', 8);
    const { campaign } = z.object({ campaign: z.string().optional() }).parse(req.body);
    const { session, application } = await intake.createDraft(campaignId(campaign));
    res.cookie(ARTIST_COOKIE, session, cookieOptions('/', 7 * DAY)).status(201).json(application);
  });
  api.put('/application', async (req, res) => {
    const id = await writableArtist(req);
    const { revision, draft } = saveSchema.parse(req.body);
    res.json(await intake.save(id, revision, draft));
  });
  api.post('/application/submit', async (req, res) => {
    const id = await writableArtist(req);
    const { revision } = z.object({ revision: revisionSchema }).parse(req.body);
    res.json(await intake.submit(id, revision));
  });
  api.post('/application/revise', async (req, res) => {
    const id = await writableArtist(req);
    const { revision } = z.object({ revision: revisionSchema }).parse(req.body);
    res.json(await intake.beginRevision(id, revision));
  });
  api.post('/application/link', async (req, res) => {
    const id = await writableArtist(req);
    if (config.mailEnabled === false) throw new IntakeError(503, 'Email links are unavailable. Return on this browser to continue.');
    await requireRate(req, 'mail-ip', 30);
    await intake.sendLink(id);
    res.status(202).json({ accepted: true });
  });
  api.post('/application/saved-link', async (req, res) => {
    const id = await writableArtist(req);
    if (!(await rateLimit(db, config.mailKey, 'artist-saved-link', id, 4, DAY))) {
      throw new IntakeError(429, 'You’ve made several private links today. Use one you saved or try again tomorrow.');
    }
    res.json({ url: await intake.issueSavedLink(id) });
  });
  api.post('/application/report', async (req, res) => {
    const id = await writableArtist(req);
    const input = reportSchema.parse(req.body);
    const result = await intake.report(id, input);
    if (['sale', 'withdrawal'].includes(input.kind)) await updatePublications();
    res.json(result);
  });

  const assetByRequest = db.prepare(`SELECT id,width,height,bytes,role FROM assets
    WHERE app_id=? AND request_key=?`);
  const logUpload = db.prepare(`INSERT INTO audit(subject_kind,subject_id,actor,action,note,created_at)
    VALUES('application',?,'artist',?,?,?)`);
  function uploadEvent(upload, event, note = '') {
    return logUpload.run(upload.id, event, upload.role + ' ' + upload.key.slice(0, 8) + (note ? ' · ' + note : ''), Date.now());
  }

  api.post('/application/assets', async (req, res, next) => {
    const id = await writableArtist(req);
    await requireRate(req, 'upload', 180);
    const role = z.enum(['portrait', 'work']).parse(req.query.role);
    const key = uuid.parse(req.get('Idempotency-Key'));
    const previous = await assetByRequest.get(id, key);
    if (previous) {
      if (previous.role !== role) throw new IntakeError(409, 'Retry this file in its original upload field.');
      return res.json(previous);
    }
    if (!editable((await intake.get(id)).status)) throw new IntakeError(409, 'This submission is closed for editing.');
    if (activeUploads >= 3) throw new IntakeError(503, 'Photo uploads are busy. Try this file again in a moment.');
    if (!req.is('application/octet-stream')) throw new IntakeError(415, 'Choose a supported photo file.');
    const upload = { id, role, key, processing: false, finished: false };
    activeUploads++;
    req.intakeUpload = upload;
    upload.finish = (event, note) => {
      if (upload.finished) return;
      upload.finished = true;
      activeUploads--;
      void uploadEvent(upload, event, note).catch(() => console.error('The upload audit could not be recorded.'));
    };
    res.once('close', () => {
      if (!upload.processing) upload.finish('upload_failed', 'Upload connection closed.');
    });
    await uploadEvent(upload, 'upload_started');
    if (!upload.finished) next();
  }, express.raw({ type: 'application/octet-stream', limit: MAX_BYTES, inflate: false }), async (req, res) => {
    const upload = req.intakeUpload;
    const { id, role, key } = upload;
    upload.processing = true;
    let storedId;
    let adopted = false;
    try {
      const prepared = await prepareImage(req.body);
      storedId = media ? await media.write(req.body, prepared) : await writeAsset(config.dataDir, req.body, prepared);
      const record = await db.transaction(async () => {
        const saved = await assetByRequest.get(id, key);
        if (saved) {
          if (saved.role !== role) throw new IntakeError(409, 'Retry this file in its original upload field.');
          return saved;
        }
        if (!editable((await intake.get(id)).status)) throw new IntakeError(409, 'This submission is closed for editing.');
        if ((await db.prepare('SELECT COUNT(*) AS n FROM assets WHERE app_id=?').get(id)).n >= MAX_ASSETS_PER_APPLICATION) {
          throw new IntakeError(422, 'This submission has reached its photo upload limit. Contact the team for help.');
        }
        await db.prepare('INSERT INTO assets(id,app_id,request_key,role,format,width,height,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(storedId, id, key, role, prepared.format, prepared.width, prepared.height, prepared.bytes, Date.now());
        return { id: storedId, role, width: prepared.width, height: prepared.height, bytes: prepared.bytes };
      });
      adopted = record.id === storedId;
      upload.finish('upload_stored');
      res.status(adopted ? 201 : 200).json(record);
    } finally {
      if (storedId && !adopted) {
        const cleanup = media ? (async () => {
          // On a lost commit response, keep objects if Postgres did register the upload.
          if (!(await db.prepare('SELECT 1 FROM assets WHERE id=?').get(storedId))) await media.remove(storedId);
        })() : rm(assetDirectory(config.dataDir, storedId), { recursive: true, force: true });
        await cleanup.catch(() => console.error('An unused image needs cleanup.'));
      }
    }
  });

  async function imageResponse(res, id) {
    if (media) {
      try {
        res.type('jpeg').send(await media.get(id, 'preview.jpg'));
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
          throw new IntakeError(404, 'Photo not found.');
        }
        throw error;
      }
      return;
    }
    res.type('jpeg').sendFile(mediaPath(config.dataDir, id), {
      cacheControl: false, dotfiles: 'deny', acceptRanges: false, lastModified: false,
    });
  }

  api.get('/application/assets/:id', async (req, res) => {
    const owner = await artistId(req);
    const id = uuid.parse(req.params.id);
    if (!(await db.prepare('SELECT 1 FROM assets WHERE id=? AND app_id=?').get(id, owner))) {
      throw new IntakeError(404, 'Photo not found.');
    }
    await imageResponse(res, id);
  });

  api.post('/review/login', async (req, res) => {
    await requireRate(req, 'review-login', 15);
    if (!config.reviewerPassword) throw new IntakeError(503, 'The review desk needs a configured password.');
    const { password, teamKey } = z.object({ password: z.string().max(400), teamKey: token.optional() }).parse(req.body);
    const staffSignIn = sameSecret(password, config.reviewerPassword);
    const teamSignIn = teamKey && config.reviewerTeamAccess &&
      sameSecret(teamKey + ':' + password, config.reviewerTeamAccess);
    if (!staffSignIn && !teamSignIn) throw new IntakeError(401, 'That password didn’t match.');
    const tokenValue = secret();
    const now = Date.now();
    const raw = cookie(req, REVIEWER_COOKIE);
    if (raw) await db.prepare('DELETE FROM reviewer_sessions WHERE hash=?').run(digest(raw));
    await db.prepare('INSERT INTO reviewer_sessions(hash,expires_at) VALUES(?,?)')
      .run(digest(tokenValue), now + 8 * HOUR);
    res.cookie(REVIEWER_COOKIE, tokenValue, cookieOptions('/api/review', 8 * HOUR)).json({ signedIn: true });
  });

  api.post('/review/logout', async (req, res) => {
    const raw = cookie(req, REVIEWER_COOKIE);
    if (raw) await db.prepare('DELETE FROM reviewer_sessions WHERE hash=?').run(digest(raw));
    res.clearCookie(REVIEWER_COOKIE, cookieOptions('/api/review')).sendStatus(204);
  });

  api.get('/review', reviewer, async (_req, res) => res.json({ ...await intake.overview(), editorialEnabled:Boolean(config.editorial) }));
  api.get('/review/applications/:id', reviewer, async (req, res) => res.json(await intake.detail(uuid.parse(req.params.id))));
  api.post('/review/applications/:id', reviewer, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const decision = reviewerActionSchema.parse(req.body);
    await intake.review(id, decision);
    if (['publish', 'pause'].includes(decision.action)) await updatePublications();
    res.json(await intake.detail(id));
  });
  api.get('/review/assets/:id', reviewer, async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (!(await db.prepare('SELECT 1 FROM assets WHERE id=?').get(id))) throw new IntakeError(404, 'Photo not found.');
    await imageResponse(res, id);
  });
  api.post('/review/callbacks/:id', reviewer, async (req, res) => {
    const { status, note } = z.object({
      status: z.enum(['acknowledged', 'completed', 'closed']), note: z.string().trim().max(900),
    }).parse(req.body);
    await intake.updateCallback(uuid.parse(req.params.id), status, note);
    res.sendStatus(204);
  });
  api.post('/review/mail/:id/retry', reviewer, async (req, res) => {
    if (config.mailEnabled === false) throw new IntakeError(503, 'Connect email delivery before retrying.');
    if (!(await retryMail(db, config, uuid.parse(req.params.id)))) throw new IntakeError(409, 'This message is unavailable for retry.');
    res.sendStatus(204);
  });

  function publicHeaders(res) {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  }
  api.get('/catalog', async (_req, res) => {
    publicHeaders(res);
    const artists = getPublications ? getPublications() :
      (await db.prepare('SELECT data FROM publications ORDER BY published_at DESC').all())
        .map((row) => JSON.parse(row.data));
    res.json({ version: 1, artists });
  });
  api.get('/catalog/media/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (!(await db.prepare('SELECT 1 FROM public_assets WHERE asset_id=? LIMIT 1').get(id))) {
      throw new IntakeError(404, 'Photo not found.');
    }
    publicHeaders(res);
    await imageResponse(res, id);
  });
  const editorial = config.editorial ? createEditorial({ db,config,media,imageResponse,cacheCalendar }) : null;
  const editorialRoutes = editorial && installEditorial({ app,api,editorial,config,reviewer,requireRate,publicHeaders,getPublications,onEditorialChange });
  api.use((_req, _res, next) => next(new IntakeError(404, 'Not found.')));
  app.use('/api', api);

  if (serveUi) {
    if (config.catalogDir) {
      if (!existsSync(join(config.catalogDir, 'index.html'))) throw new Error('Build the catalog before setting CATALOG_DIR.');
      app.use('/discover', express.static(config.catalogDir, { dotfiles: 'deny', maxAge: 0 }));
    }
    const directory = resolve(root);
    if (existsSync(join(directory, 'index.html'))) {
      app.use(express.static(directory, { dotfiles: 'deny', index: false, maxAge: '1h' }));
      app.get('/start', (req, res) => {
        const campaign = campaignId(req.query.campaign);
        res.set('Cache-Control', 'no-store').redirect(302, '/apply' + (campaign === 'taos-artists' ? '?campaign=taos-artists' : ''));
      });
      if (config.mailEnabled === false) {
        app.get('/resume', (_req, res) => {
          const html = readFileSync(join(directory, 'index.html'), 'utf8');
          res.set('Cache-Control', 'no-store').type('html').send(html.replace('<body>', '<body data-email-unavailable>'));
        });
      }
      app.get(['/', '/resume', '/apply', '/callback', '/review', '/privacy'], (_req, res) => {
        res.set('Cache-Control', 'no-store').sendFile(join(directory, 'index.html'), { cacheControl: false });
      });
    } else {
      app.get('/', (_req, res) => res.status(503).send('Build the webform with npm run build first.'));
    }
  }
  app.use((_req, _res, next) => next(new IntakeError(404, 'Not found.')));
  app.use((error, req, res, next) => {
    req.intakeUpload?.finish('upload_failed', error instanceof IntakeError ? error.message : 'Image could not be stored.');
    if (res.headersSent) return next(error);
    if (error instanceof IntakeError) return res.status(error.status).json({ message: error.message, fields: error.fields });
    if (error instanceof z.ZodError || error.type === 'entity.parse.failed') {
      return res.status(400).json({ message: 'Check the information you entered and try again.' });
    }
    if (error.status === 413 || error.type === 'entity.too.large') {
      return res.status(413).json({ message: 'This upload is too large. Choose an image no larger than 12 MB.' });
    }
    if (error.status === 404 || error.code === 'ENOENT') return res.status(404).json({ message: 'Not found.' });
    if (error.status === 415) return res.status(415).json({ message: 'This request uses an unsupported format.' });
    // Error responses and logs do not echo contact information or resume links.
    const incident = randomUUID();
    console.error('Intake request failed:', incident, error.code || error.name);
    return res.status(500).json({ message: 'We couldn’t finish that request. Please try again.', incident });
  });

  return { app, db: db.sqlite || db, intake, outbox, editorial, newsletter: editorialRoutes?.newsletter,
    payments: editorialRoutes?.payments };
}
