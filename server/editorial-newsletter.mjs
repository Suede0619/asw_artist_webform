import { randomUUID } from 'node:crypto';
import { IntakeError } from './errors.mjs';
import { digest } from './security.mjs';
import { artistMarket, denverTime, expired, httpsUrl, isIssueDate, offsetDate, startsThisWeek } from '../shared/editorial.mjs';
import { discoverCalendar } from './editorial-sources.mjs';
import { mailchimpClient } from './editorial-integrations.mjs';

const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]);
const showDate = date => new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{ month:'short',day:'numeric',timeZone:'UTC' });
const cityName = city => city==='taos' ? 'Taos' : 'Santa Fe';
const showTime = time => {
  const [hour,minutes]=time.split(':').map(Number);
  return (hour%12 || 12)+':'+String(minutes).padStart(2,'0')+(hour<12?' a.m.':' p.m.');
};
const dateLabel = row => row.kind==='exhibition'
  ? showDate(row.startDate)+' to '+showDate(row.endDate)
  : showDate(row.startDate)+', '+showTime(row.startTime)+' to '+(row.startDate!==row.endDate?showDate(row.endDate)+', ':'')+showTime(row.endTime);
const digestOf = items => digest(JSON.stringify(items));
const PUBLIC_STATES = new Set(['sent','sending']);
function short(value, count=290) {
  return value.length>count ? value.slice(0,count).replace(/\s+\S*$/,'')+'…' : value;
}
function addTags(url, issue, content) {
  const result = new URL(url);
  result.searchParams.set('utm_source','artsouthwest');
  result.searchParams.set('utm_medium','email');
  result.searchParams.set('utm_campaign','weekly-'+issue);
  result.searchParams.set('utm_content',content);
  return result.href;
}

export function renderIssue(issue, settings) {
  const copy = 'A week of exhibitions, openings and artists in Taos and Santa Fe.';
  const subject = 'ArtSouthwest Weekly · ' + showDate(issue.date);
  const urlOf = path => new URL(path,settings.origin).href;
  const target = (path,content) => addTags(urlOf(path),issue.date,content);
  const item = (entry, path, content, meta, label='Read more') => {
    const href=target(path,content);
    const src=entry.image ? urlOf(entry.image) : '';
    return {
      html:'<tr><td style="padding:18px 0;border-bottom:1px solid #dcd5c9">' +
        (src ? '<img src="'+esc(src)+'" width="552" alt="'+esc(entry.imageAlt)+'" style="display:block;width:100%;max-width:552px;height:auto;border:0">' : '') +
        '<p style="margin:14px 0 3px;color:#4e5c52;font-size:13px">'+esc(meta)+'</p><h3 style="margin:0 0 8px;font:22px Georgia,serif"><a style="color:#283c32" href="'+esc(href)+'">'+esc(entry.title)+'</a></h3>'+
        '<p style="margin:0 0 10px;line-height:1.55">'+esc(entry.summary)+'</p><a style="color:#283c32" href="'+esc(href)+'">'+esc(label)+'</a></td></tr>',
      plain:[meta,entry.title,entry.summary,href].join('\n'),
    };
  };
  const sections=[];
  for (const city of ['taos','santa-fe']) {
    const rows=issue.events.filter(entry=>entry.city===city);
    if (rows.length) sections.push({ title:cityName(city), rows:rows.map(entry=>item(entry,
      '/'+city+'/whats-on/'+entry.id,'event-'+entry.id,dateLabel(entry)+' · '+entry.venue,'View details')) });
  }
  if (issue.artist) {
    const { artist }=issue;
    sections.push({ title:'Artist story',rows:[item(artist,'/'+artist.city+'/artists/'+artist.slug,'artist-'+artist.slug,'From the ArtSouthwest catalog','Meet the artist')] });
  }
  if (issue.sponsor) {
    sections.push({ title:'Paid sponsorship',rows:[item(issue.sponsor,issue.sponsor.destination,'sponsor',issue.sponsor.organization,'Visit the sponsor')] });
  }
  const footer = ['You received this email because you subscribed to ArtSouthwest Weekly.',settings.address || '*|LIST:ADDRESS|*'];
  const wordmark=settings.logo && httpsUrl(settings.logo);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+
    esc(subject)+'</title></head><body style="margin:0;background:#eee9df;color:#222820;font-family:Arial,sans-serif">'+
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">'+
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#f8f5ee"><tr><td style="padding:24px">'+
    (wordmark ? '<img src="'+esc(wordmark)+'" width="190" alt="ArtSouthwest" style="display:block;height:auto;border:0">' : '<div style="font:30px Georgia,serif">ArtSouthwest</div>')+
    '<h1 style="font:28px Georgia,serif;margin:18px 0 6px">This week in Taos and Santa Fe</h1><p style="margin:0 0 8px;color:#4e5c52">'+
    esc(showDate(issue.date)+' to '+showDate(offsetDate(issue.date,6)))+'</p><p>'+esc(copy)+'</p>'+
    sections.map(section=>'<h2 style="font:24px Georgia,serif;margin:28px 0 0">'+esc(section.title)+'</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">'+
      section.rows.map(row=>row.html).join('')+'</table>').join('')+
    '<p style="margin:24px 0 0;font-size:13px;line-height:1.5">'+footer.map(esc).join('<br>')+
    '<br><a style="color:#283c32" href="*|UNSUB|*">Unsubscribe</a></p></td></tr></table></td></tr></table></body></html>';
  const plain=[subject,copy,...sections.flatMap(section=>[section.title,...section.rows.map(row=>row.plain)]),...footer,'Unsubscribe: *|UNSUB|*'].join('\n\n');
  return { html,plain,subject,preview:copy };
}

export function createNewsletter(editorial, settings, getPublications, fetcher=fetch) {
  const db=editorial.db;
  const issueByDate=db.prepare('SELECT * FROM editorial_issues WHERE issue_date=?');
  async function contents(date, now) {
    const { all }=await editorial.calendar({ now });
    const through=offsetDate(date,6);
    const sendTime=date+'T09:00';
    const asOf=denverTime(now);
    const activeAt=asOf>sendTime && asOf.slice(0,10)===date ? asOf : sendTime;
    const events=[];
    for (const city of ['taos','santa-fe']) {
      events.push(...all.filter(row=>row.city===city && row.image && startsThisWeek(row,date,through) &&
        !['canceled','postponed'].includes(row.scheduleStatus) && !expired(row,activeAt))
        .sort((a,b)=>(b.priority||0)-(a.priority||0)||a.startDate.localeCompare(b.startDate)||a.title.localeCompare(b.title))
        .slice(0,4).map(({ ended,...row })=>row));
    }
    const profiles=(await getPublications()).filter(profile=>profile.bio && artistMarket(profile))
      .sort((a,b)=>a.slug.localeCompare(b.slug));
    const link=events.find(event=>profiles.some(profile=>profile.slug===event.artistSlug));
    const week=Math.floor(Date.parse(date+'T12:00:00Z')/604800000);
    const profile=link ? profiles.find(candidate=>candidate.slug===link.artistSlug) : profiles[week%profiles.length];
    const artist=profile ? { title:profile.name, summary:short(profile.bio),city:artistMarket(profile),slug:profile.slug,
      image:profile.portrait?.id ? '/api/catalog/media/'+profile.portrait.id : '', imageAlt:profile.portrait?.alt || profile.name } : null;
    const slot=await db.prepare(`SELECT r.approved FROM editorial_slots s JOIN editorial_records r ON r.id=s.record_id
      WHERE s.issue_date=? AND s.state='paid' AND r.state='approved' AND r.revision=s.revision`).get(date);
    return { date,events,artist,sponsor:slot ? JSON.parse(slot.approved) : null };
  }
  async function prepare(date, now=new Date()) {
    return db.transaction(async () => {
      const old=await issueByDate.get(date);
      if (old?.state==='sent' || old?.state==='expired') return old;
      const issue=await contents(date,now);
      const sum=digestOf(issue);
      if (old?.digest===sum) return old;
      const when=now.valueOf();
      await db.prepare(`INSERT INTO editorial_issues(issue_date,state,digest,contents,updated_at) VALUES(?,'draft',?,?,?)
        ON CONFLICT(issue_date) DO UPDATE SET state='draft',digest=excluded.digest,contents=excluded.contents,
        updated_at=excluded.updated_at,review_note='',last_error=NULL`).run(date,sum,JSON.stringify(issue),when);
      return issueByDate.get(date);
    });
  }
  async function approve(date,sum,note) {
    const original=await prepare(date);
    const row=await issueByDate.get(date);
    const current=row && JSON.parse(row.contents);
    if (row?.state!=='draft' || original.digest!==sum || row.digest!==sum) throw new IntakeError(409,'The issue changed. Preview the latest version.');
    if (!current.events.length) throw new IntakeError(422,'Approve calendar entries before approving this roundup.');
    const amended=await db.prepare("UPDATE editorial_issues SET state='approved',review_note=?,updated_at=? WHERE issue_date=? AND state='draft' AND digest=?")
      .run(note,Date.now(),date,sum);
    if (!amended.changes) throw new IntakeError(409,'The issue changed. Preview the latest version.');
    return issueByDate.get(date);
  }
  async function get(date) {
    const row=await issueByDate.get(date);
    if (!row) throw new IntakeError(404,'Roundup not found.');
    return { ...row,contents:JSON.parse(row.contents) };
  }
  async function send(date,now) {
    const row=await issueByDate.get(date);
    if (row?.state!=='approved' || !settings.mailchimp.send) return;
    const remote=mailchimpClient(settings.mailchimp,fetcher);
    const title='ArtSouthwest Weekly '+date;
    // Reconcile provider state before modifying a draft. A response may have been lost after sending.
    let campaign=row.campaign_id ? await remote.get(row.campaign_id) : await remote.find(title,date);
    if (campaign && PUBLIC_STATES.has(campaign.status)) {
      await db.prepare("UPDATE editorial_issues SET state='sent',campaign_id=?,last_error=NULL,updated_at=? WHERE issue_date=?")
        .run(campaign.id,Date.now(),date);
      return;
    }
    const checked=await prepare(date,now);
    if (checked.state!=='approved' || checked.digest!==row.digest) return;
    const body=renderIssue(JSON.parse(checked.contents),settings);
    campaign ||= await remote.create({ title,subject:body.subject,preview:body.preview });
    await db.prepare('UPDATE editorial_issues SET campaign_id=? WHERE issue_date=?').run(campaign.id,date);
    if (campaign.status!=='save') throw new Error('Mailchimp campaign needs attention.');
    await remote.content(campaign.id,body.html,body.plain);
    const checklist=await remote.checklist(campaign.id);
    if (!checklist.is_ready) throw new Error('Mailchimp send checklist is incomplete.');
    // A changed event invalidates this exact approval before the provider receives a send request.
    const last=await prepare(date,new Date());
    if (last.state!=='approved' || last.digest!==checked.digest || denverTime().slice(0,10)!==date) return;
    await remote.send(campaign.id);
    await db.prepare("UPDATE editorial_issues SET state='sent',last_error=NULL,updated_at=? WHERE issue_date=?")
      .run(Date.now(),date);
  }
  async function report(date) {
    const row=await get(date);
    if (!row.campaign_id || !settings.mailchimp.key) throw new IntakeError(404,'A Mailchimp report is unavailable.');
    const info=await mailchimpClient(settings.mailchimp,fetcher).report(row.campaign_id);
    return { sent:info.emails_sent, bounces:(info.bounces?.hard_bounces||0)+(info.bounces?.soft_bounces||0),
      opens:info.opens?.unique_opens, clicks:info.clicks?.unique_subscriber_clicks, unsubscribes:info.unsubscribed };
  }
  async function jobs(now=new Date()) {
    const local=denverTime(now);
    const date=local.slice(0,10);
    const time=local.slice(11);
    async function withLease(name,operation,successCompletes=true) {
      const stamp=now.valueOf();
      const token=randomUUID();
      const lock=await db.prepare(`INSERT INTO editorial_jobs(name,token,lease_until) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until
        WHERE editorial_jobs.lease_until<? AND editorial_jobs.completed_at IS NULL`).run(name,token,stamp+300000,stamp);
      if (!lock.changes) return;
      try {
        const result=await operation();
        await db.prepare('UPDATE editorial_jobs SET completed_at=?,result=? WHERE name=? AND token=?')
          .run(successCompletes?Date.now():null,JSON.stringify(result||{}),name,token);
      } catch {
        await db.prepare('UPDATE editorial_jobs SET result=? WHERE name=? AND token=?')
          .run('{"error":"Job needs attention and will retry."}',name,token);
      }
    }
    await db.prepare("UPDATE editorial_issues SET state='expired' WHERE issue_date<? AND state IN ('draft','approved')").run(date);
    await db.prepare("UPDATE editorial_slots SET state='released' WHERE state='reserved' AND checkout_id IS NULL AND expires_at<?").run(now.valueOf());
    if (time>='05:00') await withLease('calendar:'+date, () => discoverCalendar(editorial,settings,now,fetcher));
    if (isIssueDate(date) && time>='07:00') {
      await withLease('roundup:'+date,()=>prepare(date,now));
      if (time>='09:00' && settings.mailchimp.send) await withLease('send:'+date,async () => {
        try { await send(date,now); }
        catch {
          await db.prepare('UPDATE editorial_issues SET last_error=? WHERE issue_date=?')
            .run('Mailchimp could not finish sending. The worker will check again.',date);
          throw new Error('Mailchimp issue send failed.');
        }
      },false);
    }
  }
  const list = () => db.prepare("SELECT issue_date,state,digest,updated_at,last_error FROM editorial_issues ORDER BY issue_date DESC LIMIT 30").all();
  return { prepare,approve,get,list,report,jobs,preview:row=>renderIssue(row.contents,settings) };
}
