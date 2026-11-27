import { createHmac } from 'node:crypto';
import { IntakeError } from './errors.mjs';
import { sameSecret } from './security.mjs';
import { denverTime } from '../shared/editorial.mjs';

async function jsonRequest(url, options, fetcher) {
  const response = await fetcher(url, { ...options, signal:AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Provider HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}
export function mailchimpClient(settings, fetcher=fetch) {
  const prefix = settings.key.split('-').pop();
  if (!/^us[0-9]+$/.test(prefix)) throw new Error('Use a Mailchimp key with its data center suffix.');
  const endpoint = 'https://' + prefix + '.api.mailchimp.com/3.0';
  const call = (path, method='GET', body) => jsonRequest(endpoint+path,{
    method, headers:{ authorization:'Basic '+Buffer.from('artsouthwest:'+settings.key).toString('base64'),
      'content-type':'application/json' }, body:body === undefined ? undefined : JSON.stringify(body),
  },fetcher);
  return {
    async find(title, issueDate) {
      for (let offset=0;offset<1000;offset+=100) {
        const params = new URLSearchParams({ list_id:settings.audience, count:'100', offset:String(offset),
          since_create_time:issueDate+'T00:00:00Z' });
        const { campaigns } = await call('/campaigns?'+params);
        const found = campaigns.find(entry => entry.settings.title===title);
        if (found || campaigns.length<100) return found;
      }
      throw new Error('The matching campaign needs manual reconciliation.');
    },
    create: ({ title,subject,preview }) => call('/campaigns','POST',{
      type:'regular', recipients:{ list_id:settings.audience },
      settings:{ title,subject_line:subject,preview_text:preview,from_name:'ArtSouthwest',reply_to:settings.replyTo },
      tracking:{ opens:true,html_clicks:true,text_clicks:true },
    }),
    get: id => call('/campaigns/'+encodeURIComponent(id)),
    content: (id,html,plain) => call('/campaigns/'+encodeURIComponent(id)+'/content','PUT',{ html,plain_text:plain }),
    checklist: id => call('/campaigns/'+encodeURIComponent(id)+'/send-checklist'),
    send: id => call('/campaigns/'+encodeURIComponent(id)+'/actions/send','POST'),
    report: id => call('/reports/'+encodeURIComponent(id)),
  };
}

export function stripePayments(editorial, settings, origin, fetcher=fetch) {
  const db = editorial.db;
  const getSlot = db.prepare('SELECT * FROM editorial_slots WHERE record_id=?');
  function stripe(path,options) {
    return jsonRequest('https://api.stripe.com/v1/'+path,{ ...options, headers:{
      authorization:'Bearer '+settings.key,...options.headers,
    } },fetcher);
  }
  const ready=Boolean(settings.key && settings.webhook);
  const lookup=id=>stripe('checkout/sessions/'+encodeURIComponent(id),{});
  async function settle(session) {
    const metadata=session?.metadata;
    if (!metadata?.record_id || !/^cs_[A-Za-z0-9_]+$/.test(session.id||'')) return;
    await db.transaction(async () => {
      const slot=await getSlot.get(metadata.record_id);
      if (slot?.state!=='reserved' || slot.issue_date!==metadata.issue_date ||
          String(slot.revision)!==metadata.revision || slot.checkout_id && slot.checkout_id!==session.id) return;
      let state;
      if (session.status==='expired') state='released';
      else if (session.payment_status==='paid' && slot.amount_minor===session.amount_total && slot.currency===session.currency) {
        const record=await editorial.get(slot.record_id);
        const issue=await db.prepare('SELECT state,contents FROM editorial_issues WHERE issue_date=?').get(slot.issue_date);
        const missed=slot.issue_date<denverTime().slice(0,10) ||
          issue?.state==='sent' && JSON.parse(issue.contents).sponsor?.recordId!==slot.record_id;
        state=record.state==='approved' && record.revision===slot.revision && !missed ? 'paid' : 'refund_review';
      }
      if (state) await db.prepare("UPDATE editorial_slots SET state=?,checkout_id=? WHERE record_id=? AND state='reserved'")
        .run(state,session.id,slot.record_id);
    });
  }
  async function status(id, token, refresh = true) {
    if (!editorial.canManage(id,token)) throw new IntakeError(404,'Submission not found.');
    const record = await editorial.get(id);
    if (record.category !== 'sponsor') throw new IntakeError(404,'Submission not found.');
    let slot = await getSlot.get(id);
    if (refresh && ready && slot?.state==='reserved' && slot.checkout_id) {
      try { await settle(await lookup(slot.checkout_id)); slot=await getSlot.get(id); }
      catch { /* The verified webhook and scheduled reconciliation can finish the same payment. */ }
    }
    const payable = ready && slot?.state==='reserved' && slot.expires_at>Date.now() &&
      slot.revision===record.revision && record.state==='approved';
    return { state:slot?.state || record.state, issueDate:record.draft.issueDate, title:record.draft.title,
      amount:slot?.amount_minor || null, currency:slot?.currency || 'usd', payable:Boolean(payable) };
  }
  async function checkout(id,token) {
    const current = await status(id,token,false);
    if (!current.payable) throw new IntakeError(409,'Checkout is currently unavailable for this submission.');
    const slot = await getSlot.get(id);
    const record = await editorial.get(id);
    if (!slot || slot.state !== 'reserved' || record.state !== 'approved' || slot.revision !== record.revision) {
      throw new IntakeError(409,'Checkout is currently unavailable for this submission.');
    }
    if (slot.checkout_id) {
      const saved = await lookup(slot.checkout_id);
      if (saved.status !== 'open' || !saved.url) throw new IntakeError(409,'Refresh the sponsorship status.');
      return saved.url;
    }
    const returnUrl=origin+'/advertise/status#'+id+':'+token;
    // Stripe's session expiry has a 30-minute minimum. Close a quote to new purchases before that boundary.
    if (slot.expires_at < Date.now()+31*60000) throw new IntakeError(409,'This sponsorship quote is expiring.');
    const params = new URLSearchParams({
      mode:'payment', 'payment_method_types[0]':'card', success_url:returnUrl,cancel_url:returnUrl,
      customer_email:record.draft.contact, expires_at:String(Math.floor(slot.expires_at/1000)),
      'line_items[0][quantity]':'1','line_items[0][price_data][currency]':slot.currency,
      'line_items[0][price_data][unit_amount]':String(slot.amount_minor),
      'line_items[0][price_data][product_data][name]':'ArtSouthwest sponsorship · '+slot.issue_date,
      'metadata[record_id]':id,'metadata[issue_date]':slot.issue_date,'metadata[revision]':String(slot.revision),
    });
    const session = await stripe('checkout/sessions',{ method:'POST',headers:{
      'content-type':'application/x-www-form-urlencoded','idempotency-key':'asw-sponsor-'+id+'-'+slot.revision,
    },body:params });
    if (!/^cs_[A-Za-z0-9_]+$/.test(session.id) || !session.url) throw new Error('Stripe checkout session missing.');
    const stored = await db.prepare("UPDATE editorial_slots SET checkout_id=? WHERE record_id=? AND revision=? AND state='reserved'")
      .run(session.id,id,slot.revision);
    if (!stored.changes) throw new IntakeError(409,'Refresh the sponsorship status.');
    return session.url;
  }
  async function receive(raw, signature) {
    if (!settings.webhook || !Buffer.isBuffer(raw)) throw new IntakeError(404,'Not found.');
    const fields = String(signature || '').split(',').map(piece=>piece.split('='));
    const timestamp = fields.find(([key])=>key==='t')?.[1];
    const candidates = fields.filter(([key])=>key==='v1').map(([,value])=>value);
    if (!/^\d+$/.test(timestamp||'') || Math.abs(Date.now()/1000-Number(timestamp))>300) throw new IntakeError(400,'Invalid payment signature.');
    const check = createHmac('sha256',settings.webhook).update(timestamp+'.').update(raw).digest('hex');
    if (!candidates.some(value=>typeof value==='string' && sameSecret(value,check))) throw new IntakeError(400,'Invalid payment signature.');
    let event;
    try { event=JSON.parse(raw); } catch { throw new IntakeError(400,'Invalid payment event.'); }
    if (!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(event.type)) return;
    const session=event.data?.object;
    if (event.type==='checkout.session.expired' && session) session.status='expired';
    await settle(session);
  }
  async function reconcile(now=new Date()) {
    if (!ready) return;
    const rows=await db.prepare(`SELECT s.checkout_id,r.state FROM editorial_slots s JOIN editorial_records r ON r.id=s.record_id
      WHERE s.state='reserved' AND s.checkout_id IS NOT NULL AND (s.expires_at<=? OR r.state='withdrawn') LIMIT 10`).all(now.valueOf());
    await Promise.allSettled(rows.map(async row=>{
      const session=await lookup(row.checkout_id);
      if (row.state==='withdrawn' && session.status==='open') {
        await settle(await stripe('checkout/sessions/'+encodeURIComponent(row.checkout_id)+'/expire',{method:'POST'}));
      } else await settle(session);
    }));
  }
  return { status,checkout,receive,reconcile };
}
