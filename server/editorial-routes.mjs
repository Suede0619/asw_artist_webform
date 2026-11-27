import express from 'express';
import { z } from 'zod';
import { MAX_BYTES } from '../shared/intake.mjs';
import { denverTime, isIssueDate, offsetDate } from '../shared/editorial.mjs';
import { IntakeError } from './errors.mjs';
import { createNewsletter } from './editorial-newsletter.mjs';
import { stripePayments } from './editorial-integrations.mjs';

const uuid=z.uuid();
const proof=z.string().regex(/^[\w-]{43}$/);
const note=z.string().trim().max(500).default('');
const issueDate=z.iso.date().refine(isIssueDate);
const MAX_FORM=MAX_BYTES+32_768;
const binary=express.raw({ limit:MAX_BYTES, type:'application/octet-stream', inflate:false });
const formPayload=express.raw({ limit:MAX_FORM, type:'multipart/form-data', inflate:false });
const validateRate=(rate,name,max)=>(req,_res,next)=>rate(req,name,max).then(()=>next(),next);
function handleUpload(work) {
  let active=0;
  return async (req,res,next)=>{
    if (active>=3) throw new IntakeError(503,'Photo uploads are busy. Try again in a moment.');
    active++;
    let released=false;
    const release=()=>{ if (!released) { released=true; active--; } };
    res.once('finish',release);
    res.once('close',release);
    work(req,res,next);
  };
}
function parseFailure(error) {
  if (!(error instanceof z.ZodError)) throw error;
  const fields=Object.fromEntries(error.issues.map(issue=>[issue.path[0],issue.message]));
  throw new IntakeError(422,'Review the highlighted fields.',fields);
}

export function installEditorial({ app, api, editorial, config, reviewer, requireRate, publicHeaders, getPublications, onEditorialChange }) {
  const origin = config.editorial.origin || config.publicUrl;
  const settings = { ...config.editorial,origin };
  const newsletter = createNewsletter(editorial,settings,async () => getPublications ? getPublications() :
    (await editorial.db.prepare('SELECT data FROM publications ORDER BY published_at DESC').all()).map(row=>JSON.parse(row.data)));
  const payments = stripePayments(editorial,settings.stripe,origin);
  const isCatalog = !config.editorial.origin || config.publicUrl===config.editorial.origin;
  const staffHost = Boolean(config.reviewerPassword);

  if (isCatalog) {
    app.post('/api/editorial/stripe/webhook',express.raw({ type:'application/json',limit:'128kb',inflate:false }),async (req,res)=>{
      await payments.receive(req.body,req.get('Stripe-Signature'));
      res.sendStatus(204);
    });
    api.get('/editorial/calendar',async (_req,res)=>{
      const { week, day, end }=await editorial.calendar();
      res.json({ day,end,entries:week });
    });
    api.get('/editorial/media/:id',async (req,res)=>{
      publicHeaders(res);
      await editorial.publicPhoto(res,uuid.parse(req.params.id));
    });
    api.post('/editorial/submissions/:category',validateRate(requireRate,'editorial-submit',10),handleUpload(formPayload),async (req,res)=>{
      const category=z.enum(['calendar','sponsor']).parse(req.params.category);
      if (category==='sponsor' && !settings.sponsorPrice) throw new IntakeError(404,'Sponsorship submissions are closed.');
      if (!req.is('multipart/form-data') || !Buffer.isBuffer(req.body)) throw new IntakeError(415,'Choose an image and fill in the form.');
      const key=uuid.parse(req.get('Idempotency-Key'));
      let form;
      try { form=await new Response(req.body,{ headers:{ 'content-type':req.get('content-type') } }).formData(); }
      catch { throw new IntakeError(400,'The submission could not be read.'); }
      const file=form.get('image');
      if (!file || typeof file==='string') throw new IntakeError(422,'Choose an image for this submission.',{ image:'Choose a photo.' });
      const fields=Object.fromEntries([...form].filter(([name,value])=>name!=='image'&&typeof value==='string'));
      if (fields.website) throw new IntakeError(422,'The submission could not be accepted.');
      fields.imageRights=fields.imageRights==='on';
      try { res.status(201).json(await editorial.submit(category,fields,Buffer.from(await file.arrayBuffer()),key)); }
      catch (error) { parseFailure(error); }
    });
    api.post('/editorial/sponsorship/:id/status',validateRate(requireRate,'sponsor-status',45),async (req,res)=>{
      res.json(await payments.status(uuid.parse(req.params.id),proof.parse(req.body.token)));
    });
    api.post('/editorial/sponsorship/:id/checkout',validateRate(requireRate,'sponsor-checkout',12),async (req,res)=>{
      res.json({ url:await payments.checkout(uuid.parse(req.params.id),proof.parse(req.body.token)) });
    });
  }

  if (staffHost) {
    api.get('/review/editorial',reviewer,async (_req,res)=>{
      const records=await editorial.reviewQueue();
      const jobs=await editorial.db.prepare('SELECT name,completed_at,result FROM editorial_jobs ORDER BY lease_until DESC LIMIT 5').all();
      const today=denverTime().slice(0,10);
      const next=Array.from({ length:7 },(_,i)=>offsetDate(today,i)).find(isIssueDate);
      res.json({ records,issues:await newsletter.list(),nextIssue:next,jobs,
        checkoutConfigured:Boolean(settings.stripe.key && settings.stripe.webhook),
        newsletterSending:settings.mailchimp.send });
    });
    api.get('/review/editorial/media/:id',reviewer,async (req,res)=>{
      const id=uuid.parse(req.params.id);
      if (!(await editorial.db.prepare('SELECT id FROM editorial_records WHERE image_id=? OR approved_image_id=?').get(id,id))) {
        throw new IntakeError(404,'Photo not found.');
      }
      await editorial.imageResponse(res,id);
    });
    api.post('/review/editorial/records/:id/photo',reviewer,validateRate(requireRate,'editorial-photo',30),handleUpload(binary),async (req,res)=>{
      const meta=z.object({ revision:z.coerce.number().int().positive(),alt:z.string().trim().min(1).max(180),
        credit:z.string().trim().max(180).default(''),rights:z.literal('yes') }).parse(req.query);
      res.json(await editorial.attach(uuid.parse(req.params.id),meta.revision,req.body,meta.alt,meta.credit));
    });
    api.post('/review/editorial/records/:id',reviewer,async (req,res)=>{
      const choice=z.object({ revision:z.number().int().positive(),action:z.enum(['approve','decline','withdraw','revise']),
        clearance:z.boolean().default(false),relatedId:uuid.or(z.literal('')).optional(),
        artistSlug:z.string().max(110).optional(),summary:z.string().trim().max(900).optional(),
        schedule:z.object({ startDate:z.iso.date(), endDate:z.iso.date(),
          startTime:z.string().max(5),endTime:z.string().max(5),
          scheduleStatus:z.enum(['scheduled','rescheduled','canceled','postponed']) }).optional(),note }).parse(req.body);
      try {
        const result=await editorial.decide(uuid.parse(req.params.id),choice);
        if (result.category==='calendar') onEditorialChange?.();
        res.json(result);
      } catch (error) { parseFailure(error); }
    });
    api.post('/review/editorial/issues/:date/preview',reviewer,async (req,res)=>{
      const date=issueDate.parse(req.params.date);
      const today=denverTime().slice(0,10);
      if (date>offsetDate(today,7)) throw new IntakeError(422,'Choose the next Thursday issue.');
      if (date>=today) await newsletter.prepare(date);
      const issue=await newsletter.get(date);
      res.json({ ...issue,preview:newsletter.preview(issue) });
    });
    api.post('/review/editorial/issues/:date/approve',reviewer,async (req,res)=>{
      const date=issueDate.parse(req.params.date);
      const { digest, reviewNote }=z.object({ digest:z.string().regex(/^[a-f0-9]{64}$/),reviewNote:note }).parse(req.body);
      const today=denverTime().slice(0,10);
      if (date<today || date>offsetDate(today,7)) throw new IntakeError(422,'Choose the next Thursday issue.');
      res.json(await newsletter.approve(date,digest,reviewNote));
    });
    api.get('/review/editorial/issues/:date/report',reviewer,async (req,res)=>{
      res.json(await newsletter.report(issueDate.parse(req.params.date)));
    });
  }
  return { newsletter,payments };
}
