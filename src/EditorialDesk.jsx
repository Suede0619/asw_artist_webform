import { useEffect, useState } from 'react';
import { request } from './api.mjs';
import { Check, ErrorBox, Field } from './ui.jsx';

const editionPath = date => '/review/editorial/issues/' + date;
const recordPath = id => '/review/editorial/records/' + id;
const states = { pending:'Awaiting review', approved:'Approved', declined:'Declined', withdrawn:'Withdrawn',
  draft:'Draft', sent:'Sent', expired:'Expired', reserved:'Awaiting payment', paid:'Paid',
  released:'Reservation expired', refund_review:'Refund review', refunded:'Refunded' };

function Entry({ item, records, refresh }) {
  const [working,setWorking] = useState(false);
  const [error,setError] = useState(null);
  const [clearance,setClearance] = useState(false);
  const [note,setNote] = useState('');
  const [summary,setSummary] = useState(item.draft.summary);
  const [relatedId,setRelatedId] = useState(item.draft.relatedId || '');
  const [artistSlug,setArtistSlug] = useState(item.draft.artistSlug || '');
  const [photo,setPhoto] = useState(null);
  const [alt,setAlt] = useState('');
  const [credit,setCredit] = useState('');
  const [imageRights,setImageRights] = useState(false);
  const view=item.draft;
  const [schedule,setSchedule] = useState(()=>({ startDate:view.startDate,endDate:view.endDate,
    startTime:view.startTime||'',endTime:view.endTime||'',scheduleStatus:view.scheduleStatus||'scheduled' }));
  function scheduleField(key) {
    return { value:schedule[key],onChange:event=>setSchedule(current=>({...current,[key]:event.target.value})) };
  }
  async function run(operation) {
    setWorking(true);
    setError(null);
    try { await operation(); await refresh(); }
    catch (failure) { setError(failure); }
    finally { setWorking(false); }
  }
  function decide(action) {
    return run(() => request(recordPath(item.id),'POST',{ revision:item.revision,action,clearance,relatedId,artistSlug,note,summary,
      schedule:action==='approve' && item.category==='calendar' ? schedule : undefined }));
  }
  function upload(event) {
    event.preventDefault();
    return run(async()=>{
      const query=new URLSearchParams({ revision:item.revision,alt,credit,rights:imageRights?'yes':'no' });
      const response=await fetch('/api'+recordPath(item.id)+'/photo?'+query,{
        method:'POST', headers:{ 'X-Intake-Request':'1','Content-Type':'application/octet-stream' },body:photo,
      });
      if (!response.ok) throw new Error((await response.json()).message);
    });
  }
  const exhibitionOptions=records.filter(row=>row.approved?.kind==='exhibition'&&row.approved?.city===view.city);
  return <article className="review-block editorial-review">
    <header><h3>{view.title}</h3><p>{states[item.state]}{item.approved && item.state==='pending' ? ' · An earlier version is live' : ''}</p></header>
    <ErrorBox error={error} />
    {item.image_id && <img className="editorial-preview-image" src={'/api/review/editorial/media/'+item.image_id} alt={view.imageAlt||'Proposed editorial image'} />}
    <dl className="editorial-facts">
      <div><dt>{item.category==='sponsor'?'Issue':'Dates'}</dt><dd>{view.issueDate || [view.startDate,view.startTime,view.endDate,view.endTime].filter(Boolean).join(' · ')}</dd></div>
      <div><dt>{item.category==='sponsor'?'Advertiser':'Venue'}</dt><dd>{view.organization||view.venue}</dd></div>
      {item.payment_state && <div><dt>Payment</dt><dd>{states[item.payment_state]} · {
        new Intl.NumberFormat('en-US',{ style:'currency',currency:'USD' }).format(item.payment_amount/100)}</dd></div>}
      {view.kind && <div><dt>Type</dt><dd>{view.kind}{view.relatedTitle ? ' · '+view.relatedTitle:''}</dd></div>}
      <div><dt>Source</dt><dd><a href={view.source||view.destination} target="_blank" rel="noreferrer">{view.ai ? 'Venue source' : 'Link from submitter'}</a></dd></div>
      {view.scheduleStatus && view.scheduleStatus!=='scheduled' && <div><dt>Status</dt><dd>{view.scheduleStatus}</dd></div>}
      {view.contact && <div><dt>Private contact</dt><dd>{view.contact}</dd></div>}
      <div><dt>Photo permission</dt><dd>{view.imageRights?'Declared':'Needs clearance'}{view.imageCredit?' · '+view.imageCredit:''}{view.imageSource&&<> · <a href={view.imageSource} target="_blank" rel="noreferrer">Image source</a></>}</dd></div>
    </dl>
    {item.state==='pending' ? <>
      <label className="editorial-review-field">Public description<textarea value={summary} onChange={event=>setSummary(event.target.value)}
        maxLength={item.category==='sponsor'?250:900} rows={4}/></label>
      {item.category==='calendar' && <details className="details-block">
        <summary>Correct the schedule</summary>
        <div className="stack">
          <div className="field-grid">
            <Field id={'start-date-'+item.id} label="Start date" type="date" {...scheduleField('startDate')}/>
            <Field id={'end-date-'+item.id} label="End date" type="date" {...scheduleField('endDate')}/>
            {view.kind!=='exhibition' && <>
              <Field id={'start-time-'+item.id} label="Start time in New Mexico" type="time" {...scheduleField('startTime')}/>
              <Field id={'end-time-'+item.id} label="End time in New Mexico" type="time" {...scheduleField('endTime')}/>
            </>}
          </div>
          <label className="editorial-review-field">Schedule status
            <select {...scheduleField('scheduleStatus')}>
              <option value="scheduled">Scheduled</option><option value="rescheduled">Rescheduled</option>
              <option value="postponed">Postponed</option><option value="canceled">Canceled</option>
            </select>
          </label>
        </div>
      </details>}
      <details className="details-block" open={!item.image_id || undefined}>
        <summary>{item.image_id?'Replace the image':'Attach an image'}</summary>
        <form onSubmit={upload} className="editorial-photo-form">
        <Field id={'editorial-photo-'+item.id} label="Cleared photo" type="file" accept="image/jpeg,image/png,image/webp" required
          onChange={event=>setPhoto(event.target.files[0])} />
        <Field id={'editorial-alt-'+item.id} label="Photo description" value={alt} required onChange={event=>setAlt(event.target.value)} />
        <Field id={'editorial-credit-'+item.id} label="Photo credit" value={credit} onChange={event=>setCredit(event.target.value)} />
        <label><input type="checkbox" required checked={imageRights} onChange={event=>setImageRights(event.target.checked)}/> I confirmed publication permission.</label>
        <button type="submit" className="button secondary" disabled={working}>Attach photo</button>
        </form>
      </details>
      {view.kind==='opening' && <label className="editorial-review-field">Published exhibition
        <select value={relatedId} onChange={event=>setRelatedId(event.target.value)}>
          <option value="">Choose an exhibition when applicable</option>
          {exhibitionOptions.map(row=><option key={row.id} value={row.id}>{row.approved.title}</option>)}
        </select>
      </label>}
      {item.category==='calendar' && <Field id={'editorial-artist-'+item.id} label="Published artist profile slug"
        value={artistSlug} onChange={event=>setArtistSlug(event.target.value)} />}
      <Field id={'editorial-note-'+item.id} label="Review note" value={note} onChange={event=>setNote(event.target.value)} />
      <label><input type="checkbox" checked={clearance} onChange={event=>setClearance(event.target.checked)}/> I checked the information and publication permission.</label>
      <div className="actions">
        <button type="button" className="button" disabled={working||!clearance||!item.image_id||!summary.trim()} onClick={()=>decide('approve')}>
          {item.category==='sponsor'?'Approve creative':'Approve and publish'}
        </button>
        <button type="button" className="button secondary" disabled={working} onClick={()=>decide('decline')}>Decline</button>
      </div>
    </> : <p>{view.summary}</p>}
    {item.approved && <div className="actions">
      {item.category==='calendar' && item.state==='approved' && <button className="text-button" type="button"
        disabled={working} onClick={()=>decide('revise')}>Edit listing</button>}
      <button className="text-button remove" type="button" disabled={working} onClick={()=>decide('withdraw')}>Withdraw</button>
    </div>}
  </article>;
}

function Newsletter({ dashboard, refresh }) {
  const [date,setDate] = useState(dashboard.nextIssue);
  const [issue,setIssue] = useState(null);
  const [error,setError] = useState(null);
  const [busy,setBusy] = useState(false);
  const [report,setReport] = useState(null);
  const [approve,setApprove] = useState(false);
  async function run(operation) {
    setBusy(true);
    setError(null);
    try { await operation(); } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  function preview(date) {
    setDate(date);
    setReport(null);
    setApprove(false);
    return run(async()=>setIssue(await request(editionPath(date)+'/preview','POST')));
  }
  const metrics=report && [['Sent',report.sent],['Clicks',report.clicks],['Opens',report.opens],['Bounces',report.bounces],['Unsubscribes',report.unsubscribes]];
  return <div className="desk-list">
    <ErrorBox error={error} />
    <p>{dashboard.newsletterSending?'Approved issues are eligible for the Thursday send.':'The newsletter is in preview mode.'}</p>
    <button className="button secondary" type="button" disabled={busy} onClick={()=>preview(dashboard.nextIssue)}>Preview next issue</button>
    {dashboard.issues.map(row=><div className="desk-row" key={row.issue_date}>
      <p>{row.issue_date} · {row.dispatch_started_at&&row.state==='approved'?'Checking delivery':states[row.state]}{row.last_error?' · '+row.last_error:''}</p>
      <div className="actions">
        <button className="text-button" type="button" disabled={busy} onClick={()=>preview(row.issue_date)}>Open</button>
        {row.state==='sent' && <button className="text-button" type="button" disabled={busy}
          onClick={()=>run(async()=>setReport(await request(editionPath(row.issue_date)+'/report')))}>View report</button>}
      </div>
    </div>)}
    {metrics && <dl className="metrics">{metrics.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v??'Unavailable'}</dd></div>)}</dl>}
    {issue && <section className="review-block">
      <h3>{issue.preview.subject}</h3><p>{issue.dispatch_started_at&&issue.state==='approved'?'Checking delivery':states[issue.state]}</p>
      <iframe title="Email preview" sandbox="" srcDoc={issue.preview.html} className="newsletter-preview"/>
      <details><summary>Plain text version</summary><pre className="weekly-plain">{issue.preview.plain}</pre></details>
      {issue.state==='draft' && <>
        <Check id="editorial-issue-approval" label="I approve this edition and its links." checked={approve} change={setApprove}/>
        <button className="button" type="button" disabled={!approve||busy} onClick={()=>run(async()=>{
          await request(editionPath(date)+'/approve','POST',{digest:issue.digest,reviewNote:''});
          setIssue(await request(editionPath(date)+'/preview','POST'));
          setApprove(false);
          await refresh();
        })}>Approve issue</button>
      </>}
    </section>}
  </div>;
}

export function EditorialDesk() {
  const [data,setData] = useState(null);
  const [error,setError] = useState(null);
  const [view,setView] = useState('calendar');
  const [open,setOpen] = useState('');
  async function refresh() { setData(await request('/review/editorial')); }
  useEffect(()=>{ refresh().catch(setError); },[]);
  const item=data?.records.find(row=>row.id===open&&row.category===view);
  return <section className="editorial-desk">
    <h2>Editorial</h2>
    <div className="actions" aria-label="Editorial views">
      {[['calendar','Calendar'],['weekly','Weekly roundup'],['sponsor','Sponsorship']].map(([id,label])=>
        <button key={id} type="button" className="text-button" aria-pressed={view===id}
          onClick={()=>{setOpen('');setView(id);}}>{label}</button>)}
      <button type="button" className="text-button" onClick={()=>refresh().catch(setError)}>Refresh</button>
    </div>
    <ErrorBox error={error}/>
    {!data&&!error && <p>Loading editorial records.</p>}
    {data&&view==='weekly' && <Newsletter dashboard={data} refresh={refresh}/>}
    {data&&view!=='weekly' && <>
      {view==='sponsor' && <p>{data.checkoutConfigured?'Stripe checkout is connected.':'Stripe checkout is in preview mode.'}</p>}
      {view==='calendar'&&data.jobs.filter(job=>job.name.startsWith('calendar:')).slice(0,1).map(job=>{
        const result=JSON.parse(job.result||'{}');
        return <p key={job.name}>{job.name.slice(9)} discovery · {result.error||((result.scanned||0)+' candidates · '+(result.changed||0)+' changes · '+(result.sourcesNeedingAttention?.length||0)+' sources to check')}</p>;
      })}
      {item ? <>
        <button type="button" className="text-button" onClick={()=>setOpen('')}>Back to review queue</button>
        <Entry key={item.id+':'+item.revision} item={item} records={data.records} refresh={refresh}/>
      </> : <div className="desk-list">{data.records.filter(row=>row.category===view).map(row=><article className="desk-row" key={row.id}>
        <div><h3>{row.draft.title}</h3><p>{states[row.state]}{row.draft.ai?' · Venue source':''}
          {row.payment_state?' · '+states[row.payment_state]:''}</p></div>
        <button type="button" className="button secondary" onClick={()=>setOpen(row.id)} aria-label={'Open '+row.draft.title}>Open</button>
      </article>)}
      {!data.records.some(row=>row.category===view)&&<p>No submissions to review.</p>}</div>}
    </>}
  </section>;
}
