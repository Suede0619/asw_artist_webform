import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { emptyWork } from '../shared/intake.mjs';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { prepareImage } from '../server/media.mjs';
import { backupIntake } from '../scripts/backup.mjs';
import { retain } from '../scripts/retention.mjs';
import { DAY } from '../server/security.mjs';

test('production fails closed without its required deployment settings', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'http://localhost:4080' }),
    /Production requires HTTPS/);
  assert.throws(() => loadConfig({ SMTP_URL: 'smtp://example.invalid:bad' }), /SMTP_URL must be a valid/);
});

const createJpeg = (width) => sharp({ create: {
  width, height: 720, channels: 3, background: '#a36a56',
} }).jpeg().toBuffer();

async function setup(t, customDelivery) {
  const root = resolve('data/test');
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, 'api-'));
  const deliveries = [];
  const config = loadConfig({ DATA_DIR: folder, REVIEWER_PASSWORD: 'fictional-review-password-for-tests' });
  const instance = createApp(config, { serveUi: false,
    sendMail: customDelivery || (async (message) => { deliveries.push(message); }) });
  const server = await new Promise((done, reject) =>
    instance.app.listen(0, '127.0.0.1', function () { done(this); }).once('error', reject));
  const url = 'http://127.0.0.1:' + server.address().port;

  t.after(async () => {
    await new Promise((done) => server.close(done));
    await instance.outbox.drain();
    instance.db.close();
    await rm(folder, { recursive: true, force: true });
  });
  function client() {
    let session = '';
    return async (path, method = 'GET', body, extra = {}) => {
      const binary = Buffer.isBuffer(body);
      const response = await fetch(url + '/api' + path, {
        method,
        headers: {
          'X-Intake-Request': '1',
          ...(session ? { Cookie: session } : {}),
          ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
          ...extra,
        },
        body: body === undefined || binary ? body : JSON.stringify(body),
      });
      const newCookie = response.headers.get('set-cookie')?.split(';')[0];
      if (newCookie) session = newCookie;
      const content = response.headers.get('content-type')?.includes('application/json') ? await response.json() :
        response.status === 204 ? null : Buffer.from(await response.arrayBuffer());
      return { status: response.status, content, headers: response.headers };
    };
  }

  const start = async (current, email, mode = 'start') => {
    assert.equal((await current('/start', 'POST', { email, mode, campaign: 'taos-artists' })).status, 202);
    await instance.outbox.pump();
    const message = deliveries.filter((mail) => mail.to === email).at(-1);
    assert.ok(message);
    return message.text.match(/\/resume#([\w-]+)/)[1];
  };
  return { ...instance, config, folder, deliveries, client, start };
}

function artistHeader(app) {
  return { 'X-Application-Id': app.id };
}

test('a direct draft saves email with the profile and only opens through its own session or link', async (t) => {
  const app = await setup(t);
  const artist = app.client();
  const visitor = app.client();
  const opened = await artist('/application', 'POST', { campaign: 'taos-artists' });
  assert.equal(opened.status, 201);
  const original = opened.content;
  const headers = artistHeader(original);
  assert.equal(original.draft.profile.email, '');
  assert.equal((await artist('/application', 'POST', {})).content.id, original.id);
  assert.equal((await visitor('/application')).status, 401);
  const draft = original.draft;
  draft.profile.bio = 'A fictional artist bio.';
  draft.profile.email = 'unfinished@example';
  const saved = await artist('/application', 'PUT', { revision: original.revision, draft }, headers);
  assert.equal(saved.status, 200);
  assert.equal((await artist('/application')).content.draft.profile.email, draft.profile.email);
  const submitted = await artist('/application/submit', 'POST', { revision: saved.content.revision }, headers);
  assert.equal(submitted.status, 422);
  assert.ok(submitted.content.fields['profile.email']);
  draft.profile.email = 'direct-draft@example.test';
  const completed = await artist('/application', 'PUT', { revision: saved.content.revision, draft }, headers);
  assert.equal(completed.status, 200);
  assert.equal((await visitor('/start', 'POST', { email: draft.profile.email, mode: 'resume' })).status, 202);
  await app.outbox.pump();
  assert.equal(app.deliveries.length, 0);
  assert.equal((await artist('/application/link', 'POST', undefined, headers)).status, 202);
  await app.outbox.pump();
  const link = app.deliveries[0].text.match(/\/resume#([\w-]+)/)[1];
  const resumed = await visitor('/session/redeem', 'POST', { token: link });
  assert.equal(resumed.content.id, original.id);
  assert.equal(resumed.content.draft.profile.bio, draft.profile.bio);
  assert.equal((await visitor('/session/redeem', 'POST', { token: link })).status, 410);
});

test('decode an exact-size photo and reject undersize, unsupported and damaged photos', async () => {
  const accepted = await prepareImage(await createJpeg(1080));
  assert.deepEqual([accepted.width, accepted.height], [1080, 720]);
  const derived = await sharp(accepted.preview).metadata();
  assert.equal(derived.width, 1080);
  assert.equal(derived.exif, undefined);
  await assert.rejects(prepareImage(await createJpeg(1079)), { status: 422 });
  await assert.rejects(prepareImage(Buffer.from('not an image')), { status: 415 });
  await assert.rejects(prepareImage((await createJpeg(1080)).subarray(0, 24)), { status: 422 });
});

test('draft, email resume, media isolation, versioning, publication, sale, withdrawal and restore', async (t) => {
  const app = await setup(t);
  const artist = app.client();
  const other = app.client();
  const staff = app.client();
  assert.equal((await other('/application')).status, 401);
  assert.equal((await other('/review')).status, 401);
  assert.deepEqual((await other('/catalog')).content.artists, []);
  const email = 'artist-one@example.test';
  const link = await app.start(artist, email);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM resume_links WHERE hash=?').get(link).n, 0);
  const started = await artist('/session/redeem', 'POST', { token: link });
  assert.equal(started.status, 200);
  assert.equal((await other('/session/redeem', 'POST', { token: link })).status, 410);
  const record = started.content;
  const headers = artistHeader(record);
  assert.equal((await artist('/application/submit', 'POST', { revision: record.revision }, headers)).status, 422);
  const jpeg = await createJpeg(1080);
  const upload = async (role) => {
    const key = randomUUID();
    const requestHeaders = { ...headers, 'Idempotency-Key': key };
    const first = await artist('/application/assets?role=' + role, 'POST', jpeg, requestHeaders);
    assert.equal(first.status, 201);
    const retry = await artist('/application/assets?role=' + role, 'POST', jpeg, requestHeaders);
    assert.equal(retry.status, 200);
    assert.equal(retry.content.id, first.content.id);
    return { id: first.content.id, credit: 'Fictional photo credit', alt: 'Test image' };
  };
  const portrait = await upload('portrait');
  const { draft } = record;
  draft.profile = { ...draft.profile, name: 'Sample Artist', phone: '505 555 0134', city: 'Taos',
    bio: 'I make fictional pieces for testing.', portrait, portraitRights: true, studio: 'Private visit instructions.' };
  const privateMedia = await artist('/application/assets/' + portrait.id);
  assert.equal(privateMedia.status, 200);
  assert.equal(privateMedia.headers.get('cache-control'), 'no-store');
  assert.equal((await other('/catalog/media/' + portrait.id)).status, 404);
  const otherEmail = 'artist-two@example.test';
  const otherLink = await app.start(other, otherEmail);
  assert.equal((await other('/session/redeem', 'POST', { token: otherLink })).status, 200);
  assert.equal((await other('/application/assets/' + portrait.id)).status, 404);
  assert.equal((await other('/application', 'PUT', { revision: 1, draft }, headers)).status, 409);

  for (let i = 0; i < 3; i++) {
    draft.works.push({ ...emptyWork(randomUUID()), title: 'Test work ' + i, medium: 'Oil', story: 'A fictional test work.',
      height: '12', width: '17', units: 'in', price: '120.50', availability: 'available', rights: true, seller: 'artist',
      restrictions: 'Private test instructions.', images: [await upload('work')] });
  }
  draft.permissions = { review: true, publicUse: false, commission: true, limitations: '' };
  draft.step = 'review';
  const saved = await artist('/application', 'PUT', { revision: record.revision, draft }, headers);
  assert.equal(saved.status, 200);
  const same = await artist('/application', 'PUT', { revision: record.revision, draft }, headers);
  assert.deepEqual(same.content, saved.content);
  const stale = structuredClone(draft);
  stale.profile.bio += ' Stale edit.';
  assert.equal((await artist('/application', 'PUT', { revision: record.revision, draft: stale }, headers)).status, 409);

  const sameArtist = app.client();
  const resume = await app.start(sameArtist, email, 'resume');
  const recovered = (await sameArtist('/session/redeem', 'POST', { token: resume })).content;
  assert.equal(recovered.draft.profile.bio, draft.profile.bio);
  assert.equal(recovered.draft.step, 'review');
  assert.equal(recovered.assets.length, 4);

  const missingPermission = await sameArtist('/application/submit', 'POST', { revision: saved.content.revision }, headers);
  assert.equal(missingPermission.status, 422);
  assert.ok(missingPermission.content.fields['permissions.publicUse']);
  recovered.draft.permissions.publicUse = true;
  const withPermission = await sameArtist('/application', 'PUT', { revision: saved.content.revision, draft: recovered.draft }, headers);
  assert.equal(withPermission.status, 200);

  const submit = await sameArtist('/application/submit', 'POST', { revision: withPermission.content.revision }, headers);
  assert.equal(submit.status, 200);
  assert.equal(submit.content.status, 'submitted');
  assert.deepEqual((await sameArtist('/application/submit', 'POST', { revision: withPermission.content.revision }, headers)).content, submit.content);
  await app.outbox.pump();
  const receipts = app.deliveries.filter((mail) => mail.to === email && mail.subject.includes('received'));
  assert.equal(receipts.length, 1);
  assert.match(receipts[0].text, /will review it before your profile and artwork appear on ArtSouthwest/);
  assert.deepEqual((await other('/catalog')).content.artists, []);

  assert.equal((await staff('/review/login', 'POST', { password: app.config.reviewerPassword })).status, 200);
  const path = '/review/applications/' + record.id;
  const publish = (revision, clearance = true) => staff(path, 'POST',
    { revision, action: 'publish', note: 'Fictional clearance and availability evidence.', clearance });
  assert.equal((await publish(submit.content.revision, false)).status, 422);
  const corrections = await staff(path, 'POST', {
    revision: submit.content.revision, action: 'changes', note: 'Please update the fictional artist bio.',
  });
  assert.equal(corrections.status, 200);
  await app.outbox.pump();
  const correctionMail = app.deliveries.at(-1);
  assert.match(correctionMail.text, /update the fictional artist bio/);
  const current = (await sameArtist('/application')).content;
  current.draft.profile.bio = 'I make fictional artwork in Taos.';
  const updated = await sameArtist('/application', 'PUT', { revision: current.revision, draft: current.draft }, headers);
  assert.equal(updated.status, 200);
  const resent = await sameArtist('/application/submit', 'POST', { revision: updated.content.revision }, headers);
  assert.equal(resent.status, 200);
  assert.equal((await publish(resent.content.revision, false)).status, 422);
  assert.equal((await publish(resent.content.revision)).status, 200);

  const { content: catalog, headers: publicHeaders } = await other('/catalog');
  assert.equal(publicHeaders.get('access-control-allow-origin'), '*');
  assert.equal(catalog.artists.length, 1);
  assert.equal(catalog.artists[0].works[0].price.amountMinor, 12050);
  assert.ok(!JSON.stringify(catalog).includes(email));
  assert.ok(!JSON.stringify(catalog).includes('Private'));
  assert.equal((await other('/catalog/media/' + portrait.id)).status, 200);

  const beforeRevision = (await sameArtist('/application')).content;
  assert.equal((await other('/application/revise', 'POST', { revision: beforeRevision.revision }, headers)).status, 409);
  const opened = await sameArtist('/application/revise', 'POST', { revision: beforeRevision.revision }, headers);
  assert.equal(opened.content.status, 'changes_requested');
  const retryRevision = await sameArtist('/application/revise', 'POST', { revision: beforeRevision.revision }, headers);
  assert.equal(retryRevision.content.revision, opened.content.revision);
  const revisedDraft = opened.content.draft;
  revisedDraft.works[0].price = '170.50';
  const changedPrice = await sameArtist('/application', 'PUT', { revision: opened.content.revision, draft: revisedDraft }, headers);
  const submittedRevision = await sameArtist('/application/submit', 'POST', { revision: changedPrice.content.revision }, headers);
  assert.equal(submittedRevision.status, 200);
  assert.equal((await other('/catalog')).content.artists[0].works[0].price.amountMinor, 12050);
  assert.equal((await publish(submittedRevision.content.revision)).status, 200);
  assert.equal((await other('/catalog')).content.artists[0].works[0].price.amountMinor, 17050);

  const backup = join(app.folder, 'restore-check');
  assert.equal(await backupIntake(app.folder, backup), 4);
  const restored = createApp({ ...app.config, dataDir: backup }, { serveUi: false, sendMail: async () => {} });
  try {
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM publications').get().count, 1);
    assert.equal((await readFile(join(backup, 'media', portrait.id, 'original'))).length, jpeg.length);
  } finally {
    restored.db.close();
  }

  const firstWork = catalog.artists[0].works[0];
  const sale = { key: randomUUID(), kind: 'sale', workId: firstWork.id };
  assert.equal((await sameArtist('/application/report', 'POST', sale, headers)).status, 200);
  const secondSale = await sameArtist('/application/report', 'POST', sale, headers);
  assert.equal(secondSale.status, 200);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports WHERE kind=\'sale\'').get().n, 1);
  assert.equal((await other('/catalog')).content.artists[0].works.length, 2);
  assert.equal((await other('/catalog/media/' + firstWork.images[0].id)).status, 404);
  assert.equal((await sameArtist('/application/report', 'POST', { key: randomUUID(), kind: 'withdrawal' }, headers)).status, 200);
  assert.deepEqual((await other('/catalog')).content.artists, []);
  assert.equal((await other('/catalog/media/' + portrait.id)).status, 404);
  const future = Date.now() + 35 * DAY;
  assert.equal((await retain(app.folder, { now: future })).applications, 2);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM applications').get().n, 2);
  assert.equal((await retain(app.folder, { now: future, apply: true })).applications, 2);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM applications').get().n, 0);
});

test('callback deduplication, queue completion, and safe retry after email delivery failure', async (t) => {
  let fail = true;
  const messages = [];
  const app = await setup(t, async (mail) => {
    if (fail) throw new Error('Simulated email failure');
    messages.push(mail);
  });
  const visitor = app.client();
  const staff = app.client();
  const data = { key: randomUUID(), name: 'Test Artist', phone: '505-555-0105',
    bestTime: 'Afternoon', question: '', consent: true, campaign: 'taos-artists' };
  assert.equal((await visitor('/callbacks', 'POST', data, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await visitor('/callbacks', 'POST', { ...data, consent: false })).status, 400);
  assert.equal((await visitor('/callbacks', 'POST', data)).status, 202);
  assert.equal((await visitor('/callbacks', 'POST', { ...data, key: randomUUID(), phone: '(505) 555 0105' })).status, 202);

  const email = 'retry@example.test';
  assert.equal((await visitor('/start', 'POST', { email, mode: 'start' })).status, 202);
  for (let i = 0; i < 5; i++) {
    app.db.prepare("UPDATE outbox SET next_at=0 WHERE state='pending'").run();
    await app.outbox.pump();
  }
  assert.equal((await staff('/review/login', 'POST', { password: app.config.reviewerPassword })).status, 200);
  const { content: review } = await staff('/review');
  assert.equal(review.callbacks.length, 1);
  assert.equal(review.callbacks[0].owner, app.config.callbackOwner);
  assert.equal(review.notifications[0].state, 'failed');
  assert.equal(review.notifications[0].attempts, 5);
  assert.equal((await staff('/review/callbacks/' + review.callbacks[0].id, 'POST', { status: 'completed', note: 'Test call complete.' })).status, 204);
  fail = false;
  assert.equal((await staff('/review/mail/' + review.notifications[0].id + '/retry', 'POST')).status, 204);
  await app.outbox.pump();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, email);
  assert.match(messages[0].text, /\/resume#[\w-]{43}/);
  const { content: done } = await staff('/review');
  assert.equal(done.metrics.callbacks_completed, 1);
  assert.equal(done.campaignMetrics.callbacks_completed, 1);
  assert.equal(done.campaignMetrics.started, 0);
  assert.equal(done.notifications[0].state, 'sent');
});
