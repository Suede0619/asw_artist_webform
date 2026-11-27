import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { renderIssue, createNewsletter } from '../server/editorial-newsletter.mjs';
import { stripePayments } from '../server/editorial-integrations.mjs';
import { discoverCalendar, sourceEvents } from '../server/editorial-sources.mjs';
import { denverTime, offsetDate, isIssueDate } from '../shared/editorial.mjs';

const local = () => denverTime().slice(0,10);
const nextIssue = () => Array.from({length:8},(_,i)=>offsetDate(local(),i+1)).find(isIssueDate);
const image = await sharp({create:{width:1200,height:750,channels:3,background:'#8a543d'}}).jpeg().toBuffer();
const values = overrides => ({
  city:'taos', kind:'opening', title:'An edited opening',venue:'Example Gallery',
  startDate:offsetDate(local(),1),endDate:offsetDate(local(),1),startTime:'16:00',endTime:'18:00',
  source:'https://events.example.com/opening',summary:'The gallery opens an exhibition of work in clay.',
  contact:'editor@example.com',imageAlt:'Work in clay',imageRights:true,...overrides,
});
async function fixture(t) {
  const folder=await mkdtemp(join(tmpdir(),'asw-editorial-'));
  const config=loadConfig({
    DATA_DIR:folder,REVIEWER_PASSWORD:'staff testing only',MAIL_DISABLED:'1',EDITORIAL_ENABLED:'1',
    EDITORIAL_SPONSOR_PRICE_CENTS:'15000',
  });
  const state=createApp(config, { serveUi:false });
  const server=state.app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(async()=>{
    await new Promise(done=>server.close(done));
    state.db.close();
    await rm(folder,{recursive:true,force:true});
  });
  const origin='http://127.0.0.1:'+server.address().port;
  const get=(path,cookie)=>fetch(origin+path,{headers:cookie?{cookie}:{}});
  const change=(path,body,cookie)=>fetch(origin+path,{method:'POST',headers:{
    'x-intake-request':'1','content-type':'application/json',...(cookie?{cookie}:{}),
  },body:JSON.stringify(body)});
  async function approve(id,body,cookie) {
    const r=await change('/api/review/editorial/records/'+id,{revision:1,action:'approve',clearance:true,...body},cookie);
    assert.equal(r.status,200,await r.clone().text());
    return r.json();
  }
  return { ...state,get,change,approve,origin,config };
}
async function submit(f,category,fields,key=randomUUID()) {
  const form=new FormData();
  for(const [name,value] of Object.entries(fields)) form.append(name,value===true?'on':String(value));
  form.append('image',new Blob([image],{type:'image/jpeg'}),'fixture.jpg');
  const r=await fetch(f.origin+'/api/editorial/submissions/'+category,{
    method:'POST',headers:{'x-intake-request':'1','idempotency-key':key},body:form,
  });
  assert.equal(r.status,201,await r.clone().text());
  return r.json();
}
async function signIn(f) {
  const r=await f.change('/api/review/login',{password:'staff testing only'});
  assert.equal(r.status,200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('a public submission is private until approval and leaves the rolling window after it ends',async t=>{
  const f=await fixture(t);
  const key=randomUUID();
  const first=await submit(f,'calendar',values(),key);
  const again=await submit(f,'calendar',values(),key);
  assert.equal(first.id,again.id);
  assert.equal((await f.get('/api/review/editorial')).status,401);
  const cookie=await signIn(f);
  const queue=await (await f.get('/api/review/editorial',cookie)).json();
  assert.equal(queue.records.length,1);
  const photo=queue.records[0].image_id;
  assert.equal((await f.get('/api/editorial/media/'+photo)).status,404);
  assert.equal((await f.get('/api/review/editorial/media/'+photo,cookie)).status,200);
  assert.equal((await (await f.get('/api/editorial/calendar')).json()).entries.length,0);
  const approved=await f.approve(first.id,{summary:'An opening for ceramic work.'},cookie);
  const feed=await (await f.get('/api/editorial/calendar')).json();
  assert.equal(feed.entries[0].summary,'An opening for ceramic work.');
  assert.equal(feed.entries[0].contact,undefined);
  assert.equal((await f.get('/api/editorial/media/'+photo)).status,200);
  const later=await f.editorial.calendar({now:new Date(offsetDate(local(),2)+'T18:00:00Z')});
  assert.equal(later.week.length,0);
  assert.equal(later.all[0].ended,true);
  const reply=await f.change('/api/review/editorial/records/'+first.id,{revision:approved.revision,action:'withdraw'},cookie);
  assert.equal(reply.status,200);
  assert.equal((await f.get('/api/editorial/media/'+photo)).status,404);
});

test('discovery ranks official rows, deduplicates them, and sends source changes for approval',async t=>{
  const f=await fixture(t);
  const url='https://events.example.com/list';
  const day=offsetDate(local(),2);
  const item={ '@type':'ExhibitionEvent',name:'A show',description:'A new ceramics show.',location:{name:'Example Gallery'},
    startDate:day,endDate:offsetDate(day,3),url:'https://events.example.com/show' };
  const settings={sources:[{url,city:'taos'}],modelKey:'fake',model:'fake'};
  const fetcher=async request=>request.includes('api.openai.com') ?
    Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({ranked:[{id:'0',copy:'The gallery presents work in clay.'}]})}]}]}) : Response.json([item,item]);
  assert.equal(sourceEvents(JSON.stringify([{...item,url:'https://unapproved.example.com/show'}]),settings.sources[0]).length,0);
  const unpadded={ ...item,'@type':'Event',startDate:'2026-12-4T16:00-7:00',endDate:'2026-12-4T18:00-7:00' };
  assert.equal(sourceEvents(JSON.stringify(unpadded),settings.sources[0])[0].info.startTime,'16:00');
  const first=await discoverCalendar(f.editorial,settings,new Date(),fetcher);
  assert.equal(first.mode,'ai');
  assert.equal(first.changed,1);
  const initial=(await f.editorial.reviewQueue())[0];
  assert.equal(initial.draft.summary,'The gallery presents work in clay.');
  assert.equal((await discoverCalendar(f.editorial,settings,new Date(),fetcher)).changed,0);
  item.endDate=offsetDate(day,4);
  assert.equal((await discoverCalendar(f.editorial,settings,new Date(),fetcher)).changed,1);
  assert.equal((await f.editorial.get(initial.id)).revision,2);
});

test('weekly approved snapshots use escaped email HTML and return for review if an event changes',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  const thursday=nextIssue();
  const calendar=await submit(f,'calendar',values({startDate:thursday,endDate:thursday,title:'Clay & <Light>'}));
  const record=await f.approve(calendar.id,{},cookie);
  const settings={origin:'https://artsouthwest.example',address:'Example mailing address',mailchimp:{send:false},sources:[]};
  const weekly=createNewsletter(f.editorial,settings,async()=>[
    {slug:'example-maker',name:'Example Maker',city:'Arroyo Seco, NM',bio:'Clay vessels made in Arroyo Seco.'},
  ]);
  const a=await weekly.prepare(thursday);
  const html=renderIssue(JSON.parse(a.contents),settings);
  assert.match(html.html,/Clay &amp; &lt;Light&gt;/);
  assert.match(html.html,/\*\|UNSUB\|\*/);
  assert.match(html.plain,/utm_campaign=weekly-/);
  assert.match(html.html,/\/taos\/artists\/example-maker/);
  assert.equal((await weekly.approve(thursday,a.digest,'verified')).state,'approved');
  assert.equal((await f.change('/api/review/editorial/records/'+calendar.id,{revision:record.revision,action:'withdraw'},cookie)).status,200);
  const b=await weekly.prepare(thursday);
  assert.equal(b.state,'draft');
  assert.notEqual(b.digest,a.digest);
  await assert.rejects(weekly.approve(thursday,a.digest,''),{status:409});
});

test('the weekly job submits approved Mailchimp content once and reconciles a lost send response',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-12-03T17:00:00Z')});
  const f=await fixture(t);
  const cookie=await signIn(f);
  const thursday=local();
  const event=await submit(f,'calendar',values());
  await f.approve(event.id,{},cookie);
  const settings={origin:'https://artsouthwest.example',address:'Example mailing address',sources:[],
    mailchimp:{send:true,key:'fake-us5',audience:'audience',replyTo:'editor@example.com'}};
  let sendCalls=0;
  let campaign;
  const fakeMail=async (url,request)=>{
    const path=new URL(url).pathname;
    if (path==='/3.0/campaigns' && request.method==='GET') return Response.json({campaigns:[]});
    if (path==='/3.0/campaigns' && request.method==='POST') {
      assert.equal(JSON.parse(request.body).recipients.list_id,'audience');
      campaign={id:'example',status:'save'};
      return Response.json(campaign);
    }
    if (path==='/3.0/campaigns/example/content') {
      const body=JSON.parse(request.body);
      assert.match(body.html,/\*\|UNSUB\|\*/);
      assert.match(body.plain_text,/An edited opening/);
      return new Response(null,{status:204});
    }
    if (path==='/3.0/campaigns/example/send-checklist') return Response.json({is_ready:true});
    if (path==='/3.0/campaigns/example/actions/send') {
      sendCalls++;
      campaign.status='sending';
      return Response.json({}, {status:503});
    }
    if (path==='/3.0/campaigns/example') return Response.json(campaign);
    if (path==='/3.0/reports/example') return Response.json({ emails_sent:50,bounces:{soft_bounces:2},
      opens:{unique_opens:12},clicks:{unique_subscriber_clicks:8},unsubscribed:1 });
    throw new Error('Unexpected Mailchimp request '+path);
  };
  const weekly=createNewsletter(f.editorial,settings,async()=>[],fakeMail);
  const draft=await weekly.prepare(thursday);
  await weekly.jobs();
  assert.equal(sendCalls,0);
  await weekly.approve(thursday,draft.digest,'');
  t.mock.timers.setTime(Date.now()+6*60000);
  await weekly.jobs();
  assert.equal(sendCalls,1);
  assert.equal((await weekly.get(thursday)).state,'approved');
  assert.ok((await weekly.get(thursday)).dispatch_started_at);
  t.mock.timers.setTime(Date.now()+6*60000);
  await weekly.jobs();
  assert.equal(sendCalls,1);
  assert.equal((await weekly.get(thursday)).state,'approved');
  const after=await f.editorial.get(event.id);
  await f.change('/api/review/editorial/records/'+event.id,{revision:after.revision,action:'withdraw'},cookie);
  assert.equal((await weekly.prepare(thursday)).digest,draft.digest);
  campaign.status='sent';
  t.mock.timers.setTime(Date.now()+86400000);
  await weekly.jobs();
  assert.equal(sendCalls,1);
  assert.equal((await weekly.get(thursday)).state,'sent');
  assert.deepEqual(await weekly.report(thursday),{sent:50,bounces:2,opens:12,clicks:8,unsubscribes:1});
});

test('curator schedule corrections preserve the current entry until the writer approves the revision',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  const item=await submit(f,'calendar',values());
  const first=await f.approve(item.id,{},cookie);
  const edit=await f.change('/api/review/editorial/records/'+item.id,{revision:first.revision,action:'revise'},cookie);
  assert.equal(edit.status,200);
  const revision=await edit.json();
  assert.equal(revision.state,'pending');
  assert.equal((await f.editorial.calendar()).week.length,1);
  await f.approve(item.id,{revision:revision.revision,schedule:{
    startDate:first.approved.startDate,endDate:first.approved.endDate,startTime:'16:00',endTime:'18:00',scheduleStatus:'canceled',
  }},cookie);
  const updated=await f.editorial.calendar();
  assert.equal(updated.week.length,0);
  assert.equal(updated.all[0].scheduleStatus,'canceled');
});

test('signed Stripe events can reserve and pay one approved ad without recording a duplicate',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  const proposal=await submit(f,'sponsor',{organization:'Example Studio',contact:'ads@example.com',issueDate:nextIssue(),
    title:'Sponsored studio visit',summary:'Private previews at the studio.',destination:'https://example.org/',
    imageAlt:'Studio facade',imageRights:true});
  const record=await f.approve(proposal.id,{},cookie);
  assert.equal((await f.get('/api/editorial/media/'+record.image_id)).status,404);
  const signingSecret='fake-whsec';
  const state=stripePayments(f.editorial,{key:'fake-test-key',webhook:signingSecret},'https://artsouthwest.example',
    async()=>Response.json({id:'cs_test_example',status:'open',url:'https://checkout.stripe.com/test'}));
  await assert.rejects(state.status(proposal.id,'bad'),{status:404});
  assert.equal(await state.checkout(proposal.id,proposal.token),'https://checkout.stripe.com/test');
  const event=Buffer.from(JSON.stringify({type:'checkout.session.completed',data:{object:{
    id:'cs_test_example',amount_total:15000,currency:'usd',payment_status:'paid',
    metadata:{record_id:proposal.id,issue_date:record.draft.issueDate,revision:String(record.revision)},
  }}}));
  const timestamp=Math.floor(Date.now()/1000);
  const signature='t='+timestamp+',v1='+createHmac('sha256',signingSecret).update(timestamp+'.').update(event).digest('hex');
  await assert.rejects(state.receive(event,'t='+timestamp+',v1=invalid'),{status:400});
  await state.receive(event,signature);
  await state.receive(event,signature);
  assert.equal((await state.status(proposal.id,proposal.token)).state,'paid');
  assert.equal((await f.get('/api/editorial/media/'+record.image_id)).status,200);
  const weekly=createNewsletter(f.editorial,{origin:'https://artsouthwest.example',sources:[],mailchimp:{send:false}},async()=>[]);
  await weekly.jobs(new Date(offsetDate(record.draft.issueDate,1)+'T16:00:00Z'));
  assert.equal((await state.status(proposal.id,proposal.token)).state,'refund_review');
});

test('an expired reservation reconciles with Stripe after a lost webhook',async t=>{
  const f=await fixture(t);
  const cookie=await signIn(f);
  const proposal=await submit(f,'sponsor',{organization:'Example Studio',contact:'ads@example.com',issueDate:nextIssue(),
    title:'Sponsored studio visit',summary:'Private previews at the studio.',destination:'https://example.org/',
    imageAlt:'Studio facade',imageRights:true});
  const record=await f.approve(proposal.id,{},cookie);
  const session={id:'cs_test_expiry',status:'open',url:'https://checkout.stripe.com/test',
    metadata:{record_id:proposal.id,issue_date:record.draft.issueDate,revision:String(record.revision)}};
  const state=stripePayments(f.editorial,{key:'test',webhook:'test'},'https://artsouthwest.example',
    async()=>Response.json(session));
  await state.checkout(proposal.id,proposal.token);
  session.status='expired';
  await state.reconcile(new Date(Date.now()+86400001));
  assert.equal((await state.status(proposal.id,proposal.token)).state,'released');
});
