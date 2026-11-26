import { randomUUID } from 'node:crypto';
import {
  checkDraft, cleanEmail, emptyDraft, trustedLink, cents, POLICY_VERSION, campaignId, normalPhone,
} from '../shared/intake.mjs';
import { IntakeError } from './errors.mjs';
import { draftLinkRecipient, queueDraftLink, queueReceipt } from './mail.mjs';
import { DAY, HOUR, digest, rateLimit, secret } from './security.mjs';

export const editable = (status) => ['draft', 'changes_requested'].includes(status);

async function activity(db, kind, id, actor, action, note, now) {
  await db.prepare(`INSERT INTO audit(subject_kind,subject_id,actor,action,note,created_at)
    VALUES(?,?,?,?,?,?)`).run(kind, id, actor, action, note, now);
}

async function versionRecord(db, application, kind, now) {
  await db.prepare(`INSERT INTO versions(app_id,revision,kind,data,policy_version,created_at)
    VALUES(?,?,?,?,?,?)`).run(application.id, application.revision, kind, application.draft, application.policy_version, now);
}

function assetView(row) {
  return { id: row.id, role: row.role, width: row.width, height: row.height, bytes: row.bytes };
}

async function checkAssets(db, appId, draft) {
  const assets = new Map((await db.prepare('SELECT id,role FROM assets WHERE app_id=?').all(appId)).map((row) => [row.id, row.role]));
  if ((draft.profile.portrait && assets.get(draft.profile.portrait.id) !== 'portrait') ||
      draft.works.some((work) => work.images.some((image) => assets.get(image.id) !== 'work'))) {
    throw new IntakeError(422, 'A photo is unavailable. Please upload it again.');
  }
}

function checkComplete(draft, publishing = false) {
  const issues = checkDraft(draft, { publishing });
  if (Object.keys(issues).length) throw new IntakeError(422, 'Review the highlighted details and try again.', issues);
}

function blockedIfStale(app, revision) {
  if (app.revision !== revision) {
    throw new IntakeError(409, 'A newer version of this submission is saved. Review it before you continue.');
  }
}

function reference(id) {
  return id.slice(0, 8).toUpperCase();
}

export function publicProjection(application, timestamp, slug) {
  const { profile: p, works } = JSON.parse(application.draft);
  const asset = ({ id, credit, alt }, defaultAlt) => ({
    id, src: '/api/catalog/media/' + id, credit: credit.trim(), alt: alt.trim() || defaultAlt,
  });
  return {
    slug, name: p.name.trim(), city: p.city.trim(), region: p.region.trim(), bio: p.bio.trim(),
    pronouns: p.pronouns.trim() || null, website: trustedLink(p.website) || null,
    contactLink: trustedLink(p.contactLink) || null, portrait: asset(p.portrait, 'Portrait of ' + p.name.trim()),
    updatedAt: new Date(timestamp).toISOString(),
    works: works.filter((work) => work.availability === 'available').map((w) => ({
      id: w.id, title: w.title.trim(), story: w.story.trim(), medium: w.medium.trim(),
      year: w.year.trim() || null, edition: w.edition.trim() || null,
      dimensions: { height: Number(w.height), width: Number(w.width), depth: w.depth.trim() ? Number(w.depth) : null, unit: w.units },
      price: { amountMinor: cents(w.price), currency: w.currency },
      availability: 'available', verifiedAt: new Date(timestamp).toISOString(),
      images: w.images.map((image) => asset(image, w.title.trim())),
    })),
  };
}

async function replacePublication(db, app, projection, now) {
  await db.prepare(`INSERT INTO publications(app_id,slug,data,revision,published_at) VALUES(?,?,?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,published_at=excluded.published_at`)
    .run(app.id, projection.slug, JSON.stringify(projection), app.revision, now);
  await db.prepare('DELETE FROM public_assets WHERE app_id=?').run(app.id);
  const insert = db.prepare('INSERT INTO public_assets(app_id,asset_id) VALUES(?,?)');
  await insert.run(app.id, projection.portrait.id);
  for (const work of projection.works) {
    for (const image of work.images) await insert.run(app.id, image.id);
  }
}

export function createIntake(db, config) {
  const findApp = db.prepare('SELECT * FROM applications WHERE id=?');
  const findEmail = db.prepare('SELECT * FROM applications WHERE lower(email)=lower(?)');
  const assets = db.prepare('SELECT id,role,width,height,bytes FROM assets WHERE app_id=? ORDER BY created_at');
  const publication = db.prepare('SELECT * FROM publications WHERE app_id=?');

  async function get(id) {
    const app = await findApp.get(id);
    if (!app) throw new IntakeError(404, 'We couldn’t find this submission.');
    return app;
  }

  async function view(app) {
    const live = await publication.get(app.id);
    const draft = JSON.parse(app.draft);
    return {
      id: app.id, reference: reference(app.id), email: draft.profile.email, status: app.status, revision: app.revision,
      draft, canEmailLink: config.mailEnabled !== false, reviewNote: app.review_note, policyVersion: app.policy_version,
      updatedAt: app.updated_at, submittedAt: app.submitted_at, assets: (await assets.all(app.id)).map(assetView),
      isPublished: Boolean(live),
      publishedWorks: live ? JSON.parse(live.data).works.map(({ id, title }) => ({ id, title })) : [],
    };
  }

  async function insertDraft(email, campaign, now) {
    const id = randomUUID();
    const draft = emptyDraft();
    draft.profile.email = email || '';
    await db.prepare(`INSERT INTO applications(id,email,campaign,status,revision,draft,created_at,updated_at)
      VALUES(?,?,?,'draft',1,?,?,?)`).run(id, email, campaign, JSON.stringify(draft), now, now);
    await activity(db, 'application', id, 'artist', 'started', '', now);
    return get(id);
  }

  async function openSession(app, now) {
    const session = secret();
    await db.prepare('INSERT INTO artist_sessions(hash,app_id,expires_at) VALUES(?,?,?)')
      .run(digest(session), app.id, now + 7 * DAY);
    return { session, application: await view(app) };
  }

  function createDraft(campaign) {
    return db.transaction(async () => {
      const now = Date.now();
      return openSession(await insertDraft(null, campaign, now), now);
    });
  }

  function start(email, campaign, create) {
    return db.transaction(async () => {
      const now = Date.now();
      let app = await findEmail.get(email);
      if (!app && create) app = await insertDraft(email, campaign, now);
      if (app) await queueDraftLink(db, config, app, now);
    });
  }

  async function sendLink(id) {
    const recipient = draftLinkRecipient(await get(id));
    if (!recipient) throw new IntakeError(422, 'Enter a valid email address in your profile before requesting a link.');
    if (!(await rateLimit(db, config.mailKey, 'mail-email', recipient, 4, HOUR))) {
      throw new IntakeError(429, 'Please wait before requesting another link.');
    }
    return db.transaction(async () => {
      const app = await get(id);
      if (draftLinkRecipient(app) !== recipient) throw new IntakeError(409, 'Your contact details changed. Request a new link.');
      await queueDraftLink(db, config, app, Date.now());
    });
  }

  function redeem(linkToken) {
    return db.transaction(async () => {
      const now = Date.now();
      const tokenHash = digest(linkToken);
      const link = await db.prepare('SELECT * FROM resume_links WHERE hash=? AND used_at IS NULL AND expires_at>?').get(tokenHash, now);
      if (!link) throw new IntakeError(410, 'This link has expired or has already been opened. Request a new link.');
      let app = await get(link.app_id);
      if (link.recipient) {
        if (draftLinkRecipient(app) !== link.recipient) throw new IntakeError(410, 'Your contact details changed. Request a new link from your submission.');
        if (!app.email && !(await findEmail.get(link.recipient))) {
          await db.prepare('UPDATE applications SET email=? WHERE id=?').run(link.recipient, app.id);
          app = await get(app.id);
        }
      }
      await db.prepare('UPDATE resume_links SET used_at=? WHERE hash=?').run(now, tokenHash);
      return openSession(app, now);
    });
  }

  function save(id, revision, draft) {
    return db.transaction(async () => {
      const app = await get(id);
      if (!editable(app.status)) throw new IntakeError(409, 'This submission is under review. You can send a correction from its status page.');
      const previous = JSON.parse(app.draft);
      draft.profile.email ??= previous.profile.email ?? app.email ?? '';
      const document = JSON.stringify(draft);
      if (document === app.draft) return { revision: app.revision, updatedAt: app.updated_at };
      blockedIfStale(app, revision);
      await checkAssets(db, id, draft);
      const now = Date.now();
      await db.prepare('UPDATE applications SET draft=?,revision=revision+1,updated_at=? WHERE id=?').run(document, now, id);
      return { revision: app.revision + 1, updatedAt: now };
    });
  }

  function submit(id, revision) {
    return db.transaction(async () => {
      const app = await get(id);
      if (['submitted', 'published'].includes(app.status)) return view(app);
      if (!editable(app.status)) throw new IntakeError(409, 'This submission has been withdrawn.');
      blockedIfStale(app, revision);
      const draft = JSON.parse(app.draft);
      checkComplete(draft);
      await checkAssets(db, id, draft);
      const now = Date.now();
      await db.prepare(`UPDATE applications SET status='submitted', revision=revision+1, updated_at=?, submitted_at=?,
        first_submitted_at=COALESCE(first_submitted_at,?), review_note='', policy_version=? WHERE id=?`)
        .run(now, now, now, POLICY_VERSION, id);
      const updated = await get(id);
      await versionRecord(db, updated, 'submitted', now);
      await activity(db, 'application', id, 'artist', 'submitted', '', now);
      if (config.mailEnabled !== false) await queueReceipt(db, config, updated, now);
      return view(updated);
    });
  }

  function beginRevision(id, revision) {
    return db.transaction(async () => {
      const app = await get(id);
      if (app.status === 'changes_requested') return view(app);
      if (app.status !== 'published') throw new IntakeError(409, 'A published profile is required to start an update.');
      blockedIfStale(app, revision);
      const now = Date.now();
      const draft = { ...JSON.parse(app.draft), step: 'profile' };
      await db.prepare(`UPDATE applications SET status='changes_requested', draft=?, revision=revision+1,
        updated_at=?, review_note='' WHERE id=?`).run(JSON.stringify(draft), now, id);
      await activity(db, 'application', id, 'artist', 'revision_started', '', now);
      return view(await get(id));
    });
  }

  function report(id, { key, kind, workId, note = '' }) {
    return db.transaction(async () => {
      const app = await get(id);
      if (await db.prepare('SELECT 1 FROM reports WHERE app_id=? AND request_key=?').get(id, key)) return view(app);
      if (app.status === 'withdrawn' || (app.status === 'draft' && kind !== 'withdrawal')) {
        throw new IntakeError(409, 'This action is unavailable for the current submission.');
      }
      if (kind === 'correction' && !note) throw new IntakeError(422, 'Tell us what needs to change.');
      const now = Date.now();
      const draft = JSON.parse(app.draft);
      const live = await publication.get(id);
      if (kind === 'sale') {
        const work = draft.works.find((item) => item.id === workId);
        const publicWork = live && JSON.parse(live.data).works.some((item) => item.id === workId);
        if (!work && !publicWork) throw new IntakeError(404, 'We couldn’t find that work.');
        if (work) work.availability = 'sold';
      }
      await db.prepare('INSERT INTO reports(app_id,request_key,kind,work_id,note,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, key, kind, kind === 'sale' ? workId : null, note, now);
      let status = app.status;
      if (kind === 'withdrawal') {
        status = 'withdrawn';
        await db.prepare('DELETE FROM publications WHERE app_id=?').run(id);
      }
      await db.prepare('UPDATE applications SET status=?,revision=revision+1,draft=?,updated_at=? WHERE id=?')
        .run(status, JSON.stringify(draft), now, id);
      const updated = await get(id);
      if (kind === 'sale' && live) {
        const projection = JSON.parse(live.data);
        projection.works = projection.works.filter((item) => item.id !== workId);
        projection.updatedAt = new Date(now).toISOString();
        await replacePublication(db, updated, projection, now);
      }
      await versionRecord(db, updated, kind, now);
      await activity(db, 'application', id, 'artist', kind, (kind === 'sale' ? workId + ' ' : '') + note, now);
      return view(updated);
    });
  }

  function review(id, { revision, action, note, clearance }) {
    return db.transaction(async () => {
      const app = await get(id);
      blockedIfStale(app, revision);
      const live = await publication.get(id);
      if (!['submitted', 'published', 'changes_requested'].includes(app.status)) {
        throw new IntakeError(409, 'This submission is unavailable for editorial review.');
      }
      const now = Date.now();
      if (action === 'publish') {
        if (app.status === 'changes_requested') throw new IntakeError(409, 'Wait for the artist to send the updated submission.');
        if (!clearance || !note) throw new IntakeError(422, 'Confirm clearance and record the evidence before publishing.');
        checkComplete(JSON.parse(app.draft), true);
        await checkAssets(db, id, JSON.parse(app.draft));
        await db.prepare("UPDATE applications SET status='published',revision=revision+1,updated_at=?,review_note='' WHERE id=?")
          .run(now, id);
        const updated = await get(id);
        await replacePublication(db, updated, publicProjection(updated, now, live?.slug || 'artist-' + id), now);
        await versionRecord(db, updated, 'published', now);
      }
      if (action === 'changes') {
        if (!note) throw new IntakeError(422, 'Write the changes you want the artist to make.');
        await db.prepare("UPDATE applications SET status='changes_requested',revision=revision+1,updated_at=?,review_note=? WHERE id=?")
          .run(now, note, id);
        if (config.mailEnabled !== false && app.email) await queueDraftLink(db, config, app, now, note);
      }
      if (action === 'pause') {
        if (!live || !note) throw new IntakeError(422, 'Record why this profile needs to come down.');
        await db.prepare('DELETE FROM publications WHERE app_id=?').run(id);
        await db.prepare('UPDATE applications SET status=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(app.status === 'published' ? 'submitted' : app.status, now, id);
      }
      await activity(db, 'application', id, config.reviewerId, action, note, now);
      return view(await get(id));
    });
  }

  function callback(input) {
    const campaign = campaignId(input.campaign);
    const phone = normalPhone(input.phone);
    if (!phone) throw new IntakeError(422, 'Enter a phone number with its area code.', { phone: 'Check the area code and digits.' });
    return db.transaction(async () => {
      const existing = await db.prepare(`SELECT id FROM callbacks WHERE request_key=? OR
        (campaign=? AND phone=? AND status IN ('open','acknowledged'))`).get(input.key, campaign, phone);
      if (existing) return;
      const now = Date.now();
      const id = randomUUID();
      await db.prepare(`INSERT INTO callbacks(id,request_key,campaign,name,phone,best_time,question,consent_at,owner,status,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'open',?)`)
        .run(id, input.key, campaign, input.name, phone, input.bestTime, input.question, now, config.callbackOwner, now);
      await activity(db, 'callback', id, 'artist', 'requested', '', now);
    });
  }

  function updateCallback(id, status, note) {
    return db.transaction(async () => {
      const previous = await db.prepare('SELECT status FROM callbacks WHERE id=?').get(id);
      if (!previous) throw new IntakeError(404, 'We couldn’t find that call request.');
      if (['closed', 'completed'].includes(previous.status)) throw new IntakeError(409, 'This request has already closed.');
      const now = Date.now();
      await db.prepare('UPDATE callbacks SET status=?,note=?,updated_at=? WHERE id=?').run(status, note, now, id);
      await activity(db, 'callback', id, config.reviewerId, status, note, now);
    });
  }

  async function detail(id) {
    return {
      ...await view(await get(id)),
      history: await db.prepare(`SELECT actor,action,note,created_at FROM audit
        WHERE subject_kind='application' AND subject_id=? ORDER BY id DESC LIMIT 100`).all(id),
      reports: await db.prepare('SELECT kind,work_id,created_at,note FROM reports WHERE app_id=? ORDER BY created_at DESC').all(id),
    };
  }

  async function overview() {
    const email = db.postgres ? "draft::jsonb #>> '{profile,email}'" : "json_extract(draft,'$.profile.email')";
    const name = db.postgres ? "draft::jsonb #>> '{profile,name}'" : "json_extract(draft,'$.profile.name')";
    const workCount = db.postgres ? "jsonb_array_length(draft::jsonb->'works')" : "json_array_length(draft,'$.works')";
    const applications = await db.prepare(`SELECT id,COALESCE(${email},email,'') AS email,status,updated_at,submitted_at,
      COALESCE(NULLIF(${name},''),'Untitled submission') AS name,
      ${workCount} AS work_count,
      EXISTS(SELECT 1 FROM publications p WHERE p.app_id=applications.id) AS published
      FROM applications ORDER BY updated_at DESC LIMIT 250`).all();
    const callbacks = await db.prepare(`SELECT id,name,phone,best_time,question,consent_at,owner,status,note,updated_at
      FROM callbacks ORDER BY status IN ('open','acknowledged') DESC,updated_at DESC LIMIT 250`).all();
    const notifications = await db.prepare(`SELECT id,app_id,kind,state,attempts,created_at,sent_at,last_error,next_at
      FROM outbox ORDER BY state='failed' DESC,created_at DESC LIMIT 100`).all();
    const metrics = await db.prepare(`SELECT
      (SELECT count(*) FROM landing_sessions) AS visits,
      (SELECT count(*) FROM applications) AS started,
      (SELECT count(*) FROM applications WHERE first_submitted_at IS NOT NULL) AS submitted,
      (SELECT count(*) FROM callbacks) AS callback_requests,
      (SELECT count(*) FROM callbacks WHERE status='completed') AS callbacks_completed,
      (SELECT count(*) FROM assets) AS validated_assets,
      (SELECT count(*) FROM publications) AS published`).get();
    const campaignMetrics = await db.prepare(`WITH selected_campaign AS (SELECT CAST(? AS TEXT) AS id)
      SELECT
      (SELECT count(*) FROM landing_sessions WHERE campaign=(SELECT id FROM selected_campaign)) AS visits,
      (SELECT count(*) FROM applications WHERE campaign=(SELECT id FROM selected_campaign)) AS started,
      (SELECT count(*) FROM applications WHERE campaign=(SELECT id FROM selected_campaign) AND first_submitted_at IS NOT NULL) AS submitted,
      (SELECT count(*) FROM callbacks WHERE campaign=(SELECT id FROM selected_campaign)) AS callback_requests,
      (SELECT count(*) FROM callbacks WHERE campaign=(SELECT id FROM selected_campaign) AND status='completed') AS callbacks_completed,
      (SELECT count(*) FROM assets m JOIN applications a ON a.id=m.app_id WHERE a.campaign=(SELECT id FROM selected_campaign)) AS validated_assets,
      (SELECT count(*) FROM publications p JOIN applications a ON a.id=p.app_id WHERE a.campaign=(SELECT id FROM selected_campaign)) AS published`)
      .get('taos-artists');
    return { applications: applications.map(item => ({ ...item, reference: reference(item.id) })),
      callbacks, notifications, metrics, campaignMetrics, storage: db.postgres ? 'Neon' : 'SQLite' };
  }

  return { get, view, createDraft, start, sendLink, redeem, save, submit, beginRevision, report, review, detail, overview, callback, updateCallback };
}
