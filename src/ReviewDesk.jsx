import React, { useEffect, useState } from 'react';
import { request } from './api.mjs';
import { Check, dateText, ErrorBox, Field, Panel, statuses, TextArea } from './ui.jsx';

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request('/review/login', 'POST', { password });
      await onLogin();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return <Panel title="Staff review" intro="Sign in to review artist submissions and return call requests.">
    <form onSubmit={signIn} className="stack">
      <Field id="review-password" label="Review desk password" type="password" required autoComplete="current-password"
        value={password} onChange={(event) => setPassword(event.target.value)} />
      <ErrorBox error={error} />
      <button className="button left" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </Panel>;
}

function PrivatePhotos({ images }) {
  if (!images?.length) return null;
  return <div className="staff-photos">
    {images.map(({ id, credit, alt }) => <figure key={id}>
      <a href={'/api/review/assets/' + id} target="_blank" rel="noreferrer">
        <img loading="lazy" src={'/api/review/assets/' + id} alt={alt || 'Submission photo'} />
      </a>
      <figcaption>{credit || 'Credit pending'}</figcaption>
    </figure>)}
  </div>;
}

function ApplicationReview({ item, close, change }) {
  const [note, setNote] = useState('');
  const [clearance, setClearance] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { profile, works, permissions } = item.draft;

  async function decide(action) {
    setBusy(true);
    setError(null);
    try {
      await change(action, note, clearance);
      setNote('');
      setClearance(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return <div className="desk-detail stack">
    <button type="button" className="text-button left" onClick={close}>Back to submissions</button>
    <div className="review-block">
      <h2>{profile.name || 'Untitled submission'}</h2>
      <p>{statuses[item.status]} · {item.reference}{item.isPublished ? ' · Catalog visible' : ''}</p>
      <dl className="summary-list">
        <dt>Private email</dt><dd>{item.email}</dd>
        <dt>Private phone</dt><dd>{profile.phone || '—'}</dd>
        <dt>Location</dt><dd>{[profile.city, profile.region].filter(Boolean).join(', ') || '—'}</dd>
        <dt>Public website</dt><dd>{profile.website || '—'}</dd>
        <dt>Public inquiry link</dt><dd>{profile.contactLink || '—'}</dd>
        <dt>Studio notes</dt><dd>{profile.studio || '—'}</dd>
        <dt>Submitted</dt><dd>{dateText(item.submittedAt)}</dd>
      </dl>
      <p className="narrative">{profile.bio}</p>
      {profile.portrait && <PrivatePhotos images={[profile.portrait]} />}
    </div>
    <div className="review-block">
      <h3>Permissions</h3>
      <dl className="summary-list">
        <dt>Review permitted</dt><dd>{permissions.review ? 'Yes' : 'Pending'}</dd>
        <dt>Portrait approved for review</dt><dd>{profile.portraitRights ? 'Yes' : 'Pending'}</dd>
        <dt>Website use</dt><dd>{permissions.publicUse ? 'Artist opted in' : 'Artist confirmation needed'}</dd>
        <dt>Commission disclosed</dt><dd>{item.policyVersion || 'Draft only'}</dd>
        <dt>Limits and credits</dt><dd>{permissions.limitations || 'None supplied'}</dd>
      </dl>
    </div>
    {works.map((work) => <article key={work.id} className="review-block">
      <h3>{work.title || 'Untitled work'}</h3>
      <p>{work.medium} · {work.height} × {work.width}{work.depth ? ' × ' + work.depth : ''} {work.units} · ${work.price} USD</p>
      <p className="narrative">{work.story}</p>
      <dl className="summary-list">
        <dt>Status</dt><dd>{work.availability || 'Unconfirmed'}</dd>
        <dt>Seller</dt><dd>{work.seller === 'gallery' ? [work.galleryName, work.galleryContact].filter(Boolean).join(' · ') : work.seller || 'Unconfirmed'}</dd>
        <dt>Year or edition</dt><dd>{[work.year, work.edition].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Location and delivery</dt><dd>{[work.location, work.delivery].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Review rights</dt><dd>{work.rights ? 'Artist confirmed' : 'Pending'}</dd>
        <dt>Restrictions</dt><dd>{work.restrictions || 'None supplied'}</dd>
      </dl>
      <PrivatePhotos images={work.images} />
    </article>)}
    {item.reports.length > 0 && <div className="review-block">
      <h3>Artist updates</h3>
      <ul>{item.reports.map((report, index) =>
        <li key={report.created_at + ':' + index}>{report.kind} · {dateText(report.created_at)}{report.note ? ' · ' + report.note : ''}</li>)}</ul>
    </div>}
    {!['draft', 'withdrawn'].includes(item.status) && <div className="review-block stack">
      <h3>Editorial decision</h3>
      <TextArea id="decision-note" label="Decision note" rows={3} value={note} maxLength={1600}
        hint="For publication, record the clearance and availability evidence. A correction note goes to the artist."
        onChange={(event) => setNote(event.target.value)} />
      <Check id="decision-clear" label="I verified permissions, credits, seller routing, current prices and availability for the public profile and works."
        checked={clearance} change={setClearance} />
      <ErrorBox error={error} />
      <div className="actions">
        {item.status !== 'changes_requested' && <button className="button" disabled={busy}
          type="button" onClick={() => decide('publish')}>{item.isPublished ? 'Publish current version' : 'Approve and publish'}</button>}
        <button className="button secondary" disabled={busy} type="button" onClick={() => decide('changes')}>Request changes</button>
        {item.isPublished && <button className="text-button remove" disabled={busy} type="button"
          onClick={() => { if (confirm('Take this profile and its artwork offline?')) decide('pause'); }}>Unpublish</button>}
      </div>
    </div>}
    <details className="details-block">
      <summary>Review and upload history</summary>
      <ul>{item.history.map((row, index) => <li key={index}>
        {dateText(row.created_at)} · {row.actor} · {row.action}{row.note ? ' · ' + row.note : ''}
      </li>)}</ul>
    </details>
  </div>;
}

function CallbackCard({ record, refresh }) {
  const [note, setNote] = useState(record.note);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const active = ['open', 'acknowledged'].includes(record.status);
  async function update(status) {
    setBusy(true);
    setError(null);
    try {
      await request('/review/callbacks/' + record.id, 'POST', { status, note });
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return <article className="review-block">
    <h3>{record.name}</h3>
    <p><a href={'tel:' + record.phone}>{record.phone}</a> · {record.status}</p>
    <dl className="summary-list">
      <dt>Owner</dt><dd>{record.owner}</dd>
      <dt>Permission recorded</dt><dd>{dateText(record.consent_at)}</dd>
      <dt>Best time</dt><dd>{record.best_time || '—'}</dd>
      <dt>Question</dt><dd>{record.question || '—'}</dd>
    </dl>
    {active && <>
      <TextArea id={'callback-note-' + record.id} label="Internal note" value={note} rows={2} maxLength={900}
        onChange={(event) => setNote(event.target.value)} />
      <ErrorBox error={error} />
      <div className="actions">
        {record.status === 'open' && <button className="button secondary" disabled={busy} onClick={() => update('acknowledged')}>Acknowledge</button>}
        <button className="button" disabled={busy} onClick={() => update('completed')}>Mark called</button>
        <button className="text-button" disabled={busy} onClick={() => update('closed')}>Close request</button>
      </div>
    </>}
    {!active && record.note && <p>{record.note}</p>}
  </article>;
}

export function ReviewDesk() {
  const [dashboard, setDashboard] = useState(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState(null);
  const [section, setSection] = useState('submissions');
  const [metricSource, setMetricSource] = useState('all');
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    const data = await request('/review');
    setDashboard(data);
    setSignedOut(false);
  }
  useEffect(() => {
    refresh().catch((failure) => {
      if (failure.status === 401) setSignedOut(true);
      else setError(failure);
    });
  }, []);
  async function open(id) {
    setError(null);
    setLoading(true);
    try {
      setApplication(await request('/review/applications/' + id));
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  }
  async function retry(id) {
    try {
      await request('/review/mail/' + id + '/retry', 'POST');
      await refresh();
    } catch (failure) {
      setError(failure);
    }
  }
  async function logout() {
    try {
      await request('/review/logout', 'POST');
      setApplication(null);
      setDashboard(null);
      setSignedOut(true);
    } catch (failure) {
      setError(failure);
    }
  }
  if (signedOut) return <Login onLogin={refresh} />;
  if (!dashboard) return <Panel title="Staff review"><ErrorBox error={error} />{!error && <p>Loading…</p>}</Panel>;
  const labels = [
    ['visits', 'Invitation sessions'], ['started', 'Started'], ['submitted', 'Submitted'],
    ['published', 'Published'], ['callback_requests', 'Call requests'], ['callbacks_completed', 'Calls completed'],
  ];
  const metrics = metricSource === 'all' ? dashboard.metrics : dashboard.campaignMetrics;
  return <Panel title="Staff review" narrow={false}>
    <div className="desk-bar">
      <nav aria-label="Review desk sections">
        {[['submissions', 'Submissions'], ['callbacks', 'Call requests'], ['mail', 'Email queue']].map(([key, label]) =>
          <button className="text-button" type="button" key={key} aria-current={section === key ? 'page' : undefined}
            onClick={() => { setSection(key); setApplication(null); setError(null); }}>{label}</button>)}
      </nav>
      <button className="text-button" type="button" onClick={logout}>Sign out</button>
    </div>
    <ErrorBox error={error} />
    {!application && <>
      <label className="metric-source" htmlFor="metric-source">Metrics source
        <select id="metric-source" value={metricSource} onChange={(event) => setMetricSource(event.target.value)}>
          <option value="all">All sources</option>
          <option value="taos-artists">Taos artist invitation</option>
        </select>
      </label>
      <dl className="metrics">
        {labels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{metrics[key]}</dd></div>)}
      </dl>
    </>}
    {!application && dashboard.notifications.some((item) => item.state === 'failed') &&
      <p className="problem" role="status">Email delivery needs attention. Review the failed messages in the email queue.</p>}
    {section === 'submissions' && (application ?
      <ApplicationReview key={application.id} item={application} close={() => setApplication(null)}
        change={async (action, note, clearance) => {
          const item = await request('/review/applications/' + application.id, 'POST', { revision: application.revision, action, note, clearance });
          setApplication(item);
          try {
            await refresh();
          } catch {
            setError('The decision was saved. Refresh the desk to update the queue.');
          }
        }} /> :
      <div className="desk-list">
        {dashboard.applications.length === 0 && <p>No artist submissions yet.</p>}
        {dashboard.applications.map((item) => <article key={item.id} className="desk-row">
          <div><h3>{item.name}</h3><p>{item.email} · {item.work_count} works · {statuses[item.status]}</p>
            <p className="field-hint">Last updated {dateText(item.updated_at)}</p></div>
          <button className="button secondary" type="button" onClick={() => open(item.id)} disabled={loading}
            aria-label={'Open ' + item.name}>Open</button>
        </article>)}
      </div>)}
    {section === 'callbacks' && <div className="desk-list">
      {dashboard.callbacks.length === 0 && <p>No call requests yet.</p>}
      {dashboard.callbacks.map((record) => <CallbackCard key={record.id} record={record} refresh={refresh} />)}
    </div>}
    {section === 'mail' && <div className="desk-list">
      <p>The queue retries temporary failures. Review failed messages before retrying.</p>
      <button className="text-button left" type="button" onClick={() => refresh().catch(setError)}>Refresh queue</button>
      {dashboard.notifications.length === 0 && <p>No messages yet.</p>}
      {dashboard.notifications.map((item) => <article className="desk-row" key={item.id}>
        <div><h3>{item.kind === 'resume' ? 'Private link' : item.kind === 'receipt' ? 'Submission receipt' : 'Correction request'}</h3>
          <p>{item.state} · {item.attempts} attempt{item.attempts === 1 ? '' : 's'} · {dateText(item.created_at)}</p>
          {item.last_error && <p>{item.last_error}</p>}</div>
        {item.state === 'failed' && <button className="button secondary" type="button" onClick={() => retry(item.id)}>Retry</button>}
      </article>)}
    </div>}
  </Panel>;
}
