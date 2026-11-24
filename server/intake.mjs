import { randomUUID } from 'node:crypto';
import {
  checkDraft, emptyDraft, trustedLink, cents, POLICY_VERSION, campaignId, normalPhone,
} from '../shared/intake.mjs';
import { transaction } from './database.mjs';
import { IntakeError } from './errors.mjs';
import { queueDraftLink, queueReceipt } from './mail.mjs';
import { DAY, digest, secret } from './security.mjs';

export const editable = (status) => ['draft', 'changes_requested'].includes(status);

function activity(db, kind, id, actor, action, note, now) {
  db.prepare(`INSERT INTO audit(subject_kind,subject_id,actor,action,note,created_at)
    VALUES(?,?,?,?,?,?)`).run(kind, id, actor, action, note, now);
}

function versionRecord(db, application, kind, now) {
  db.prepare(`INSERT INTO versions(app_id,revision,kind,data,policy_version,created_at)
    VALUES(?,?,?,?,?,?)`).run(application.id, application.revision, kind, application.draft, application.policy_version, now);
}

function assetView(row) {
  return { id: row.id, role: row.role, width: row.width, height: row.height, bytes: row.bytes };
}

function checkAssets(db, appId, draft) {
  const assets = new Map(db.prepare('SELECT id,role FROM assets WHERE app_id=?').all(appId).map((row) => [row.id, row.role]));
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

function replacePublication(db, app, projection, now) {
  db.prepare(`INSERT INTO publications(app_id,slug,data,revision,published_at) VALUES(?,?,?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,published_at=excluded.published_at`)
    .run(app.id, projection.slug, JSON.stringify(projection), app.revision, now);
  db.prepare('DELETE FROM public_assets WHERE app_id=?').run(app.id);
  const insert = db.prepare('INSERT INTO public_assets(app_id,asset_id) VALUES(?,?)');
  insert.run(app.id, projection.portrait.id);
  for (const work of projection.works) {
    for (const image of work.images) insert.run(app.id, image.id);
  }
}

export function createIntake(db, config) {
  const findApp = db.prepare('SELECT * FROM applications WHERE id=?');
  const findEmail = db.prepare('SELECT * FROM applications WHERE email=?');
  const assets = db.prepare('SELECT id,role,width,height,bytes FROM assets WHERE app_id=? ORDER BY created_at');
  const publication = db.prepare('SELECT * FROM publications WHERE app_id=?');

  function get(id) {
    const app = findApp.get(id);
    if (!app) throw new IntakeError(404, 'We couldn’t find this submission.');
    return app;
  }

  function view(app) {
    const live = publication.get(app.id);
    return {
      id: app.id, reference: reference(app.id), email: app.email, status: app.status, revision: app.revision,
      draft: JSON.parse(app.draft), reviewNote: app.review_note, policyVersion: app.policy_version,
      updatedAt: app.updated_at, submittedAt: app.submitted_at, assets: assets.all(app.id).map(assetView),
      isPublished: Boolean(live),
      publishedWorks: live ? JSON.parse(live.data).works.map(({ id, title }) => ({ id, title })) : [],
    };
  }

  function start(email, campaign, create) {
    return transaction(db, () => {
      const now = Date.now();
      let app = findEmail.get(email);
      if (!app && create) {
        const id = randomUUID();
        db.prepare(`INSERT INTO applications(id,email,campaign,status,revision,draft,created_at,updated_at)
          VALUES(?,?,?,'draft',1,?,?,?)`).run(id, email, campaign, JSON.stringify(emptyDraft()), now, now);
        activity(db, 'application', id, 'artist', 'started', '', now);
        app = get(id);
      }
      if (app) queueDraftLink(db, config, app, now);
    });
  }

  function redeem(linkToken) {
    return transaction(db, () => {
      const now = Date.now();
      const tokenHash = digest(linkToken);
      const link = db.prepare('SELECT * FROM resume_links WHERE hash=? AND used_at IS NULL AND expires_at>?').get(tokenHash, now);
      if (!link) throw new IntakeError(410, 'This link has expired or has already been opened. Request a new link.');
      db.prepare('UPDATE resume_links SET used_at=? WHERE hash=?').run(now, tokenHash);
      const session = secret();
      db.prepare('INSERT INTO artist_sessions(hash,app_id,expires_at) VALUES(?,?,?)')
        .run(digest(session), link.app_id, now + 7 * DAY);
      return { session, application: view(get(link.app_id)) };
    });
  }

  function save(id, revision, draft) {
    return transaction(db, () => {
      const app = get(id);
      if (!editable(app.status)) throw new IntakeError(409, 'This submission is under review. You can send a correction from its status page.');
      const document = JSON.stringify(draft);
      if (document === app.draft) return { revision: app.revision, updatedAt: app.updated_at };
      blockedIfStale(app, revision);
      checkAssets(db, id, draft);
      const now = Date.now();
      db.prepare('UPDATE applications SET draft=?,revision=revision+1,updated_at=? WHERE id=?').run(document, now, id);
      return { revision: app.revision + 1, updatedAt: now };
    });
  }

  function submit(id, revision) {
    return transaction(db, () => {
      const app = get(id);
      if (['submitted', 'published'].includes(app.status)) return view(app);
      if (!editable(app.status)) throw new IntakeError(409, 'This submission has been withdrawn.');
      blockedIfStale(app, revision);
      const draft = JSON.parse(app.draft);
      checkComplete(draft);
      checkAssets(db, id, draft);
      const now = Date.now();
      db.prepare(`UPDATE applications SET status='submitted', revision=revision+1, updated_at=?, submitted_at=?,
        first_submitted_at=COALESCE(first_submitted_at,?), review_note='', policy_version=? WHERE id=?`)
        .run(now, now, now, POLICY_VERSION, id);
      const updated = get(id);
      versionRecord(db, updated, 'submitted', now);
      activity(db, 'application', id, 'artist', 'submitted', '', now);
      queueReceipt(db, config, updated, now);
      return view(updated);
    });
  }

  function report(id, { key, kind, workId, note = '' }) {
    return transaction(db, () => {
      const app = get(id);
      if (db.prepare('SELECT 1 FROM reports WHERE app_id=? AND request_key=?').get(id, key)) return view(app);
      if (app.status === 'withdrawn' || (app.status === 'draft' && kind !== 'withdrawal')) {
        throw new IntakeError(409, 'This action is unavailable for the current submission.');
      }
      if (kind === 'correction' && !note) throw new IntakeError(422, 'Tell us what needs to change.');
      const now = Date.now();
      const draft = JSON.parse(app.draft);
      const live = publication.get(id);
      if (kind === 'sale') {
        const work = draft.works.find((item) => item.id === workId);
        const publicWork = live && JSON.parse(live.data).works.some((item) => item.id === workId);
        if (!work && !publicWork) throw new IntakeError(404, 'We couldn’t find that work.');
        if (work) work.availability = 'sold';
      }
      db.prepare('INSERT INTO reports(app_id,request_key,kind,work_id,note,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, key, kind, kind === 'sale' ? workId : null, note, now);
      let status = app.status;
      if (kind === 'withdrawal') {
        status = 'withdrawn';
        db.prepare('DELETE FROM publications WHERE app_id=?').run(id);
      }
      db.prepare('UPDATE applications SET status=?,revision=revision+1,draft=?,updated_at=? WHERE id=?')
        .run(status, JSON.stringify(draft), now, id);
      const updated = get(id);
      if (kind === 'sale' && live) {
        const projection = JSON.parse(live.data);
        projection.works = projection.works.filter((item) => item.id !== workId);
        projection.updatedAt = new Date(now).toISOString();
        replacePublication(db, updated, projection, now);
      }
      versionRecord(db, updated, kind, now);
      activity(db, 'application', id, 'artist', kind, (kind === 'sale' ? workId + ' ' : '') + note, now);
      return view(updated);
    });
  }

  function review(id, { revision, action, note, clearance }) {
    return transaction(db, () => {
      const app = get(id);
      blockedIfStale(app, revision);
      const live = publication.get(id);
      if (!['submitted', 'published', 'changes_requested'].includes(app.status)) {
        throw new IntakeError(409, 'This submission is unavailable for editorial review.');
      }
      const now = Date.now();
      if (action === 'publish') {
        if (app.status === 'changes_requested') throw new IntakeError(409, 'Wait for the artist to send the updated submission.');
        if (!clearance || !note) throw new IntakeError(422, 'Confirm clearance and record the evidence before publishing.');
        checkComplete(JSON.parse(app.draft), true);
        checkAssets(db, id, JSON.parse(app.draft));
        db.prepare("UPDATE applications SET status='published',revision=revision+1,updated_at=?,review_note='' WHERE id=?")
          .run(now, id);
        const updated = get(id);
        replacePublication(db, updated, publicProjection(updated, now, live?.slug || 'artist-' + id), now);
        versionRecord(db, updated, 'published', now);
      }
      if (action === 'changes') {
        if (!note) throw new IntakeError(422, 'Write the changes you want the artist to make.');
        db.prepare("UPDATE applications SET status='changes_requested',revision=revision+1,updated_at=?,review_note=? WHERE id=?")
          .run(now, note, id);
        queueDraftLink(db, config, app, now, note);
      }
      if (action === 'pause') {
        if (!live || !note) throw new IntakeError(422, 'Record why this profile needs to come down.');
        db.prepare('DELETE FROM publications WHERE app_id=?').run(id);
        db.prepare('UPDATE applications SET status=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(app.status === 'published' ? 'submitted' : app.status, now, id);
      }
      activity(db, 'application', id, config.reviewerId, action, note, now);
      return view(get(id));
    });
  }

  function callback(input) {
    const campaign = campaignId(input.campaign);
    const phone = normalPhone(input.phone);
    if (!phone) throw new IntakeError(422, 'Enter a phone number with its area code.', { phone: 'Check the area code and digits.' });
    return transaction(db, () => {
      const existing = db.prepare(`SELECT id FROM callbacks WHERE request_key=? OR
        (campaign=? AND phone=? AND status IN ('open','acknowledged'))`).get(input.key, campaign, phone);
      if (existing) return;
      const now = Date.now();
      const id = randomUUID();
      db.prepare(`INSERT INTO callbacks(id,request_key,campaign,name,phone,best_time,question,consent_at,owner,status,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'open',?)`)
        .run(id, input.key, campaign, input.name, phone, input.bestTime, input.question, now, config.callbackOwner, now);
      activity(db, 'callback', id, 'artist', 'requested', '', now);
    });
  }

  function updateCallback(id, status, note) {
    return transaction(db, () => {
      const previous = db.prepare('SELECT status FROM callbacks WHERE id=?').get(id);
      if (!previous) throw new IntakeError(404, 'We couldn’t find that call request.');
      if (['closed', 'completed'].includes(previous.status)) throw new IntakeError(409, 'This request has already closed.');
      const now = Date.now();
      db.prepare('UPDATE callbacks SET status=?,note=?,updated_at=? WHERE id=?').run(status, note, now, id);
      activity(db, 'callback', id, config.reviewerId, status, note, now);
    });
  }

  function detail(id) {
    return {
      ...view(get(id)),
      history: db.prepare(`SELECT actor,action,note,created_at FROM audit
        WHERE subject_kind='application' AND subject_id=? ORDER BY id DESC LIMIT 100`).all(id),
      reports: db.prepare('SELECT kind,work_id,created_at,note FROM reports WHERE app_id=? ORDER BY created_at DESC').all(id),
    };
  }

  function overview() {
    const applications = db.prepare(`SELECT id,email,status,updated_at,submitted_at,
      COALESCE(NULLIF(json_extract(draft,'$.profile.name'),''),'Untitled submission') AS name,
      json_array_length(draft,'$.works') AS work_count,
      EXISTS(SELECT 1 FROM publications p WHERE p.app_id=applications.id) AS published
      FROM applications ORDER BY updated_at DESC LIMIT 250`).all();
    const callbacks = db.prepare(`SELECT id,name,phone,best_time,question,consent_at,owner,status,note,updated_at
      FROM callbacks ORDER BY status IN ('open','acknowledged') DESC,updated_at DESC LIMIT 250`).all();
    const notifications = db.prepare(`SELECT id,app_id,kind,state,attempts,created_at,sent_at,last_error,next_at
      FROM outbox ORDER BY state='failed' DESC,created_at DESC LIMIT 100`).all();
    const metrics = db.prepare(`SELECT
      (SELECT count(*) FROM landing_sessions) AS visits,
      (SELECT count(*) FROM applications) AS started,
      (SELECT count(*) FROM applications WHERE first_submitted_at IS NOT NULL) AS submitted,
      (SELECT count(*) FROM callbacks) AS callback_requests,
      (SELECT count(*) FROM callbacks WHERE status='completed') AS callbacks_completed,
      (SELECT count(*) FROM assets) AS validated_assets,
      (SELECT count(*) FROM publications) AS published`).get();
    const campaignMetrics = db.prepare(`SELECT
      (SELECT count(*) FROM landing_sessions WHERE campaign=?1) AS visits,
      (SELECT count(*) FROM applications WHERE campaign=?1) AS started,
      (SELECT count(*) FROM applications WHERE campaign=?1 AND first_submitted_at IS NOT NULL) AS submitted,
      (SELECT count(*) FROM callbacks WHERE campaign=?1) AS callback_requests,
      (SELECT count(*) FROM callbacks WHERE campaign=?1 AND status='completed') AS callbacks_completed,
      (SELECT count(*) FROM publications p JOIN applications a ON a.id=p.app_id WHERE a.campaign=?1) AS published`)
      .get({ '?1': 'taos-artists' });
    return { applications, callbacks, notifications, metrics, campaignMetrics };
  }

  return { get, view, start, redeem, save, submit, report, review, detail, overview, callback, updateCallback };
}
