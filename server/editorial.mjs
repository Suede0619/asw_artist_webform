import { createHmac, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { assetDirectory, prepareImage, writeAsset } from './media.mjs';
import { digest, sameSecret } from './security.mjs';
import { IntakeError } from './errors.mjs';
import { artistMarket, calendarFields, calendarSubmission, sponsorSubmission, denverTime, expired, offsetDate, startsThisWeek } from '../shared/editorial.mjs';

const data = row => ({ ...row, draft: JSON.parse(row.draft), approved: row.approved ? JSON.parse(row.approved) : null });
const photoUrl = id => id ? '/api/editorial/media/' + id : '';
const compare = (a,b) => Number(b.priority || 0) - Number(a.priority || 0) || a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title);
function calendarPublic(row, imageId) {
  const out = calendarFields.parse(row);
  return { ...out, image:photoUrl(imageId), imageAlt:row.imageAlt || '', priority:row.priority || 0 };
}

export function createEditorial({ db, config, media, imageResponse, cacheCalendar }) {
  const only = db.prepare('SELECT * FROM editorial_records WHERE id=?');
  const byKey = db.prepare('SELECT * FROM editorial_records WHERE source_key=?');
  const insert = db.prepare(`INSERT INTO editorial_records(id,source_key,category,state,revision,draft,image_id,created_at,updated_at)
    VALUES(?,?,?,'pending',1,?,?,?,?) ON CONFLICT(source_key) DO NOTHING`);
  const audit = db.prepare(`INSERT INTO audit(subject_kind,subject_id,actor,action,note,created_at)
    VALUES('editorial',?,?,?,?,?)`);
  async function get(id) {
    const stored = await only.get(id);
    if (!stored) throw new IntakeError(404, 'Submission not found.');
    return data(stored);
  }
  function privateToken(id) {
    return createHmac('sha256', config.mailKey).update('editorial-sponsor:' + id).digest('base64url');
  }
  function canManage(id, supplied) {
    return typeof supplied === 'string' && sameSecret(supplied, privateToken(id));
  }
  async function savePhoto(bytes) {
    const prepared = await prepareImage(bytes);
    return media ? media.write(bytes, prepared) : writeAsset(config.dataDir, bytes, prepared);
  }
  async function removeUnused(id) {
    if (await db.prepare('SELECT id FROM editorial_records WHERE image_id=? OR approved_image_id=?').get(id,id)) return;
    await (media ? media.remove(id) : rm(assetDirectory(config.dataDir,id), { force:true, recursive:true }));
  }
  async function submit(category, input, bytes, key) {
    const fields = (category === 'sponsor' ? sponsorSubmission : calendarSubmission).parse(input);
    const today = denverTime().slice(0,10);
    if (category === 'sponsor' ? fields.issueDate <= today || fields.issueDate > offsetDate(today,90) :
      fields.endDate < today || fields.startDate > offsetDate(today,366)) {
      throw new IntakeError(422, 'Choose dates within the available submission window.');
    }
    const sourceKey = 'form:' + category + ':' + key;
    const previous = await byKey.get(sourceKey);
    const response = record => ({ id:record.id, ...(category === 'sponsor' ? { token:privateToken(record.id) } : {}) });
    if (previous) return response(previous);
    const imageId = await savePhoto(bytes);
    try {
      return await db.transaction(async () => {
        const id = randomUUID();
        const when = Date.now();
        const saved = await insert.run(id,sourceKey,category,JSON.stringify(fields),imageId,when,when);
        if (saved.changes) await audit.run(id,'submitter','submitted','',when);
        return response(await byKey.get(sourceKey));
      });
    } finally {
      await removeUnused(imageId).catch(() => console.error('Editorial media cleanup needs attention.'));
    }
  }
  async function upsertCandidate(sourceKey, input, { copy,priority } = {}) {
    const info = calendarFields.parse(input);
    const fingerprint=digest(JSON.stringify(info));
    const draft={ ...info, summary:copy || info.summary, sourceFingerprint:fingerprint, ai:true, imageRights:false };
    return db.transaction(async () => {
      const rows = await byKey.get(sourceKey);
      const when = Date.now();
      if (!rows) {
        const id = randomUUID();
        await insert.run(id,sourceKey,'calendar',JSON.stringify({ ...draft,priority:priority||0 }),null,when,when);
        await audit.run(id,'worker','discovered','',when);
        return true;
      }
      const record = data(rows);
      if (record.state === 'withdrawn') return false;
      if (record.draft.sourceFingerprint===fingerprint) return false;
      const next = { ...record.draft, ...draft, imageRights: record.draft.imageRights };
      await db.prepare("UPDATE editorial_records SET draft=?,state='pending',revision=revision+1,updated_at=? WHERE id=?")
        .run(JSON.stringify(next),when,rows.id);
      await audit.run(rows.id,'worker','source_changed','',when);
      return true;
    });
  }
  async function attach(id, revision, file, alt, credit, { source = '' } = {}) {
    const imageId = await savePhoto(file);
    try {
      await db.transaction(async () => {
        const record = await get(id);
        if (record.revision !== revision || record.state !== 'pending') throw new IntakeError(409, 'Refresh the review and try again.');
        const next = { ...record.draft,imageAlt:alt,imageCredit:credit,imageRights:!source,imageSource:source };
        await db.prepare('UPDATE editorial_records SET image_id=?,draft=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(imageId,JSON.stringify(next),Date.now(),id);
        await audit.run(id,source?'worker':config.reviewerId,'photo_attached','',Date.now());
      });
      return get(id);
    } finally {
      await removeUnused(imageId).catch(() => console.error('Editorial media cleanup needs attention.'));
    }
  }
  async function decide(id, choice) {
    return db.transaction(async () => {
      const record = await get(id);
      if (choice.revision !== record.revision) throw new IntakeError(409, 'Refresh the review and try again.');
      if (choice.action !== 'withdraw' && record.state !== 'pending') throw new IntakeError(409, 'This entry is no longer in review.');
      if (choice.action === 'approve' && (!record.image_id || (!record.draft.imageRights && !record.draft.imageSource) || !choice.clearance)) {
        throw new IntakeError(422, 'Confirm the details and publication rights and attach a cleared image.');
      }
      const now = Date.now();
      let approved = record.approved;
      let approvedImage = record.approved_image_id;
      const state = { approve:'approved', decline:'declined', withdraw:'withdrawn' }[choice.action];
      if (state === 'approved') {
        if (record.category === 'calendar') {
          const amended = { ...record.draft, summary:choice.summary || record.draft.summary,
            relatedId:choice.relatedId || '', artistSlug:choice.artistSlug || record.draft.artistSlug };
          if (amended.artistSlug) {
            const profile=await db.prepare('SELECT data FROM publications WHERE slug=?').get(amended.artistSlug);
            if (!profile || artistMarket(JSON.parse(profile.data))!==amended.city) {
              throw new IntakeError(422,'Choose a published artist profile in the same city.');
            }
          }
          if (amended.relatedId) {
            const related = await get(amended.relatedId);
            if (related.id === id || amended.kind !== 'opening' || related.approved?.kind !== 'exhibition' ||
              related.approved.city !== amended.city) throw new IntakeError(422, 'Choose a published exhibition in the same city.');
          }
          const visible = await db.prepare("SELECT id,approved FROM editorial_records WHERE category='calendar' AND approved IS NOT NULL AND id<>?").all(id);
          const key = row => [row.city,row.kind,row.title.toLowerCase(),row.venue.toLowerCase(),row.startDate,row.startTime].join('|');
          if (visible.some(row=>key(JSON.parse(row.approved))===key(amended))) {
            throw new IntakeError(409,'This occurrence already has a published listing.');
          }
          approved = calendarPublic(amended,record.image_id);
        } else {
          const { organization, issueDate, title, summary, destination, imageAlt } = record.draft;
          if (!config.editorial.sponsorPrice) throw new IntakeError(409, 'Configure the sponsor price before approving ads.');
          if (issueDate <= denverTime().slice(0,10)) throw new IntakeError(422, 'The proposed issue date has passed.');
          if ((choice.summary || summary).length>250) throw new IntakeError(422,'Sponsor copy must be 250 characters or fewer.');
          approved = { organization,issueDate,title,summary:choice.summary || summary,destination,imageAlt,image:photoUrl(record.image_id) };
          // One reservation per issue and one quote per approved creative revision.
          const slot = await db.prepare('SELECT * FROM editorial_slots WHERE issue_date=?').get(issueDate);
          if (slot && slot.state !== 'released' && slot.state !== 'refunded') {
            throw new IntakeError(409, 'This issue already has a reserved or paid sponsor.');
          }
          const utcNoon=new Date(issueDate+'T12:00:00Z');
          const localHour=Number(denverTime(utcNoon).slice(11,13));
          const sendTime=utcNoon.valueOf()+(9-localHour)*3600000;
          const expiresAt=Math.min(now+86400000,sendTime);
          await db.prepare(`INSERT INTO editorial_slots(issue_date,record_id,revision,amount_minor,currency,state,created_at,expires_at)
            VALUES(?,?,?,?,'usd','reserved',?,?) ON CONFLICT(issue_date) DO UPDATE SET record_id=excluded.record_id,
            revision=excluded.revision,amount_minor=excluded.amount_minor,state='reserved',checkout_id=NULL,
            created_at=excluded.created_at,expires_at=excluded.expires_at`)
            .run(issueDate,id,choice.revision+1,config.editorial.sponsorPrice,now,expiresAt);
        }
        approvedImage = record.image_id;
      }
      if (state === 'withdrawn') {
        approved = null;
        approvedImage = null;
        await db.prepare(`UPDATE editorial_slots SET state=CASE WHEN state='paid' THEN 'refund_review' ELSE state END
          WHERE record_id=? AND state='paid'`).run(id);
      }
      await db.prepare(`UPDATE editorial_records SET state=?,approved=?,approved_image_id=?,review_note=?,reviewed_by=?,
        revision=revision+1,updated_at=? WHERE id=?`)
        .run(state,approved ? JSON.stringify(approved) : null,approvedImage,choice.note,config.reviewerId,now,id);
      await audit.run(id,config.reviewerId,state,choice.note,now);
      return get(id);
    });
  }
  const calendarRows=db.prepare("SELECT id,approved FROM editorial_records WHERE category='calendar' AND approved IS NOT NULL");
  let cached;
  function invalidateCalendar() { cached=undefined; }
  function readCalendar() {
    if (!cacheCalendar) return calendarRows.all();
    if (!cached || cached.expires<Date.now()) {
      const pending={ expires:Date.now()+15000,rows:calendarRows.all() };
      cached=pending;
      pending.rows.catch(()=>{ if (cached===pending) invalidateCalendar(); });
    }
    return cached.rows;
  }
  async function calendar({ now = new Date(), day = denverTime(now).slice(0,10), count=7 } = {}) {
    const when = denverTime(now);
    const rows = await readCalendar();
    const all = rows.map(row => ({ ...JSON.parse(row.approved),id:row.id }));
    const week = all.filter(row => startsThisWeek(row,day,offsetDate(day,count-1)) &&
      !expired(row,when) && !['canceled','postponed'].includes(row.scheduleStatus)).sort(compare);
    return { day, end:offsetDate(day,count-1), week, all:all.map(row=>({ ...row, ended:expired(row,when) })) };
  }
  async function reviewQueue() {
    const rows = await db.prepare(`SELECT r.*,s.state AS payment_state,s.amount_minor AS payment_amount
      FROM editorial_records r LEFT JOIN editorial_slots s ON s.record_id=r.id ORDER BY r.updated_at DESC LIMIT 300`).all();
    return rows.map(data);
  }
  async function publicPhoto(res,id) {
    const allowed = await db.prepare(`SELECT editorial_records.id FROM editorial_records
      LEFT JOIN editorial_slots ON editorial_slots.record_id=editorial_records.id
      WHERE approved_image_id=? AND approved IS NOT NULL AND (category='calendar' OR editorial_slots.state='paid')`).get(id);
    if (!allowed) throw new IntakeError(404, 'Photo not found.');
    await imageResponse(res,id);
  }
  return { db, submit, upsertCandidate, attach, get, decide, calendar, invalidateCalendar, reviewQueue, publicPhoto, imageResponse, canManage };
}
