import React, { useEffect, useState } from 'react';
import { checkDraft, COMMISSION, emptyWork, MAX_WORKS, MAX_WORK_IMAGES, MIN_WORKS } from '../shared/intake.mjs';
import { request } from './api.mjs';
import { PhotoCard, PhotoPicker } from './PhotoField.jsx';
import { useDraft } from './useDraft.mjs';
import { Check, ErrorBox, Field, Panel, Select, statuses, TextArea } from './ui.jsx';

const steps = [['profile', 'Artist profile'], ['works', 'Artwork'], ['review', 'Review']];
const editable = (status) => ['draft', 'changes_requested'].includes(status);

export function Application() {
  const [application, setApplication] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    request('/application').then(setApplication).catch(setError);
  }, []);
  if (error) return <Panel title="Open your submission">
    <ErrorBox error={error} />
    <a className="button" href="/start?resume=1">Email me a private link</a>
  </Panel>;
  if (!application) return <Panel title="Your submission"><p role="status">Loading…</p></Panel>;
  const manage = new URLSearchParams(window.location.search).get('manage') === '1';
  if (manage || !editable(application.status)) return <SubmissionStatus application={application} update={setApplication} />;
  return <EditApplication key={application.id} application={application} onSubmitted={setApplication} />;
}

function InputGroup({ fields, get }) {
  return <div className="field-grid">
    {fields.map(([key, label, options]) => <Field key={key} {...get(key)} label={label} {...options} />)}
  </div>;
}

function Profile({ profile, email, applicationId, change, issues, onBusy, busy }) {
  const get = (key) => ({
    id: 'profile.' + key, value: profile[key], error: issues['profile.' + key],
    onChange: (event) => change(key, event.target.value),
  });
  return <div className="stack">
    <p className="intro small">Tell us about your practice. We’ll use this to prepare your profile for review.</p>
    <InputGroup get={get} fields={[
      ['name', 'Artist name', { maxLength: 120, autoComplete: 'name', required: true }],
      ['phone', 'Phone number', { type: 'tel', maxLength: 32, autoComplete: 'tel', required: true }],
      ['city', 'City or town', { maxLength: 120, autoComplete: 'address-level2', required: true }],
      ['region', 'State or region', { maxLength: 100, autoComplete: 'address-level1', required: true }],
    ]} />
    <p className="field-hint">We use {email} and your phone number to follow up. Your contact details stay private.</p>
    <TextArea {...get('bio')} label="Short artist bio" hint="A few sentences about your practice, materials and where you work."
      maxLength={1800} required />
    <fieldset className="media-section">
      <legend>Portrait</legend>
      {profile.portrait && <PhotoCard media={profile.portrait} title="Portrait" id="profile.portrait" issues={issues} showAlt={false}
        onChange={(photo) => change('portrait', photo)} onRemove={() => change('portrait', null)} />}
      <PhotoPicker id="profile.portrait" label={profile.portrait ? 'Replace portrait' : 'Upload a portrait'} role="portrait" applicationId={applicationId}
        onAdd={(photo) => change('portrait', photo)} onBusy={onBusy} disabled={busy}
        error={profile.portrait ? undefined : issues['profile.portrait']} />
      <Check id="profile.portraitRights" label="I have permission to share this portrait for review."
        checked={profile.portraitRights} change={(value) => change('portraitRights', value)} error={issues['profile.portraitRights']} required />
    </fieldset>
    <details className="details-block">
      <summary>Optional profile details</summary>
      <div className="stack">
        <InputGroup get={get} fields={[
          ['pronouns', 'Pronouns (optional)', { maxLength: 60 }],
          ['website', 'Artist website (optional)', { type: 'url', autoComplete: 'url', maxLength: 350, placeholder: 'https://' }],
          ['contactLink', 'Public inquiry link (optional)', { type: 'url', maxLength: 350, placeholder: 'https://' }],
        ]} />
        <TextArea {...get('studio')} label="Studio visit notes (optional)" maxLength={500} rows={2}
          hint="Share hours or appointment information. These notes stay private while we review." />
      </div>
    </details>
  </div>;
}

function WorkCard({ work, applicationId, index, count, active, toggle, edit, remove, move, issues, onBusy, busy }) {
  const prefix = 'work.' + work.id + '.';
  const get = (key) => ({
    id: prefix + key, value: work[key], error: issues[prefix + key],
    onChange: (event) => edit(key, event.target.value),
  });
  const hasErrors = Object.keys(issues).some((key) => key.startsWith(prefix));
  return <article className={'work-card' + (hasErrors ? ' needs-attention' : '')} id={'work-' + work.id}>
    <h3><button className="work-toggle" type="button" aria-expanded={active} aria-controls={'fields-' + work.id}
      disabled={busy} onClick={toggle}>
      <span>{work.title || 'Work ' + (index + 1)}</span>
      <span className="field-hint">{hasErrors ? 'Needs attention' : active ? 'Hide details' : 'Edit details'}</span>
    </button></h3>
    {active && <div className="work-body stack" id={'fields-' + work.id}>
      <Field {...get('title')} label="Title" hint="Use Untitled if the piece has no title." required maxLength={150} />
      <TextArea {...get('story')} label="About this work" maxLength={1500} required
        hint="Tell us what a viewer should know about the piece or how you made it." />
      <InputGroup get={get} fields={[
        ['medium', 'Medium or materials', { maxLength: 180, required: true }],
        ['year', 'Year (optional)', { maxLength: 30 }],
      ]} />
      <Select {...get('shape')} label="Work type" options={[['flat', 'Flat or two-dimensional'], ['three-dimensional', 'Three-dimensional']]} />
      <div className="field-grid dimensions">
        <Field {...get('height')} label="Height" inputMode="decimal" maxLength={20} required />
        <Field {...get('width')} label="Width" inputMode="decimal" maxLength={20} required />
        <Field {...get('depth')} label={work.shape === 'three-dimensional' ? 'Depth' : 'Depth (optional)'}
          inputMode="decimal" maxLength={20} required={work.shape === 'three-dimensional'} />
        <Select {...get('units')} label="Units" options={[['', 'Choose units'], ['in', 'Inches'], ['cm', 'Centimeters']]} required />
      </div>
      <div className="field-grid">
        <Field {...get('price')} label="Retail price (USD)" inputMode="decimal" maxLength={20} required />
        <Select {...get('availability')} label="Available for sale" required
          options={[['', 'Confirm availability'], ['available', 'Available now'], ['sold', 'Sold or unavailable']]} />
      </div>
      <Select {...get('seller')} label="Who handles the sale?" required
        options={[['', 'Choose a seller'], ['artist', 'I do'], ['gallery', 'A gallery represents this work']]} />
      {work.seller === 'gallery' && <InputGroup get={get} fields={[
        ['galleryName', 'Representing gallery', { maxLength: 150, required: true }],
        ['galleryContact', 'Gallery contact for review (optional)', { maxLength: 350 }],
      ]} />}
      <fieldset className="media-section">
        <legend>Work photos</legend>
        {work.images.map((photo, i) => <PhotoCard key={photo.id} media={photo} id={prefix + 'image.' + i} issues={issues}
          title={'Photo ' + (i + 1)}
          onChange={(updated) => edit('images', (images) => images.map((item) => item.id === photo.id ? updated : item))}
          onRemove={() => edit('images', (images) => images.filter((item) => item.id !== photo.id))} />)}
        {work.images.length < MAX_WORK_IMAGES && <PhotoPicker id={prefix + 'images'}
          label={work.images.length ? 'Upload another photo' : 'Upload a photo of this work'} role="work" applicationId={applicationId} onBusy={onBusy}
          onAdd={(photo) => edit('images', (images) => [...images, photo])} disabled={busy} error={issues[prefix + 'images']} />}
        <Check id={prefix + 'rights'} label="I can share this work and its photos for review."
          checked={work.rights} change={(value) => edit('rights', value)} error={issues[prefix + 'rights']} required />
      </fieldset>
      <details className="details-block">
        <summary>Edition, delivery and restrictions</summary>
        <div className="stack">
          <InputGroup get={get} fields={[
            ['edition', 'Edition or edition size (optional)', { maxLength: 150 }],
            ['location', 'Location of this work (optional)', { maxLength: 150 }],
          ]} />
          <TextArea {...get('delivery')} label="Framing, installation, pickup or shipping notes (optional)" rows={2} maxLength={500} />
          <TextArea {...get('restrictions')} label="Image or seller restrictions (optional)" rows={2} maxLength={500} />
        </div>
      </details>
      <div className="work-controls">
        {index > 0 && <button className="text-button" type="button" disabled={busy} onClick={() => move(-1)}>Move up</button>}
        {index < count - 1 && <button className="text-button" type="button" disabled={busy} onClick={() => move(1)}>Move down</button>}
        <button className="text-button remove" type="button" disabled={busy} onClick={remove}>Remove work</button>
      </div>
    </div>}
  </article>;
}

function ReviewSummary({ draft, email, issues, change, navigate }) {
  const permissions = draft.permissions;
  return <div className="stack">
    <div className="review-block">
      <h3>Artist profile</h3>
      <p><strong>{draft.profile.name}</strong><br />{draft.profile.city}, {draft.profile.region}</p>
      <p className="field-hint">Private contact: {email} · {draft.profile.phone}</p>
      <button className="text-button" type="button" onClick={() => navigate('profile')}>Edit artist profile</button>
    </div>
    <div className="review-block">
      <h3>Works you’re submitting</h3>
      <ul>{draft.works.map((work) => <li key={work.id}>{work.title || 'Untitled work'} · {work.medium} · ${work.price} USD</li>)}</ul>
      <button className="text-button" type="button" onClick={() => navigate('works')}>Edit artwork</button>
    </div>
    <fieldset className="stack compact">
      <legend>Permissions and sales disclosure</legend>
      <Check id="permissions.review" label="I have permission to share these materials for review."
        checked={permissions.review} change={(value) => change('review', value)} error={issues['permissions.review']} required />
      <Check id="permissions.publicUse"
        label="I give ArtSouthwest permission to show the profile, works and credited image copies I submit on its website, subject to the limits below."
        checked={permissions.publicUse} change={(value) => change('publicUse', value)} />
      <p className="field-hint">You can submit with website permission unchecked. We’ll ask you to confirm before publishing.</p>
      <TextArea id="permissions.limitations" label="Permission limits or credit instructions (optional)" rows={2}
        value={permissions.limitations} maxLength={800} onChange={(event) => change('limitations', event.target.value)} />
      <Check id="permissions.commission"
        label={'I understand that ArtSouthwest charges a ' + COMMISSION +
          '% commission on completed artwork sales through the platform. I can review and accept seller terms separately.'}
        checked={permissions.commission} change={(value) => change('commission', value)}
        error={issues['permissions.commission']} required />
      <p className="field-hint">Our <a href="/privacy" target="_blank" rel="noreferrer">privacy and submissions page</a> describes how we use your details.</p>
    </fieldset>
  </div>;
}

function EditApplication({ application, onSubmitted }) {
  const { draft, update, flush, discardLocally, saveState } = useDraft(application);
  const [issues, setIssues] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [openWork, setOpenWork] = useState(draft.works[0]?.id || null);
  const stepIndex = steps.findIndex(([name]) => name === draft.step);
  const changeProfile = (key, value) => update((data) => ({ ...data, profile: { ...data.profile, [key]: value } }));
  const changePermission = (key, value) => update((data) => ({ ...data, permissions: { ...data.permissions, [key]: value } }));
  const changeWork = (id, key, value) => update((data) => ({
    ...data, works: data.works.map((work) => work.id === id ? { ...work, [key]: typeof value === 'function' ? value(work[key]) : value } : work),
  }));
  const changeWorkList = (change) => update((data) => ({ ...data, works: change(data.works) }));

  const onBusy = (increment) => setUploads((value) => value + increment);
  function navigate(step) {
    update((data) => ({ ...data, step }));
    requestAnimationFrame(() => document.getElementById('step-heading')?.focus());
  }
  function showIssues(found) {
    setIssues(found);
    const first = Object.keys(found)[0];
    if (!first) return;
    if (first.startsWith('profile.')) navigate('profile');
    else if (first === 'works' || first.startsWith('work.')) {
      if (first.startsWith('work.')) setOpenWork(first.split('.')[1]);
      navigate('works');
    } else navigate('review');
    requestAnimationFrame(() => {
      const target = document.getElementById(first) || document.getElementById('step-errors');
      target?.focus();
    });
  }
  async function advance() {
    if (busy || uploads) return;
    const found = checkDraft(draft);
    const subset = Object.fromEntries(Object.entries(found).filter(([key]) => draft.step === 'review' ||
      (draft.step === 'profile' ? key.startsWith('profile.') : key.startsWith('work.') || key === 'works')));
    if (Object.keys(subset).length) {
      showIssues(subset);
      return;
    }
    setIssues({});
    setError(null);
    if (draft.step !== 'review') {
      navigate(steps[stepIndex + 1][0]);
      return;
    }
    setBusy(true);
    try {
      const revision = await flush();
      const result = await request('/application/submit', 'POST', { revision }, application.id);
      onSubmitted(result);
      requestAnimationFrame(() => document.querySelector('h1')?.focus());
    } catch (failure) {
      if (failure.fields) showIssues(failure.fields);
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function addWork() {
    const item = emptyWork(crypto.randomUUID());
    changeWorkList((works) => [...works, item]);
    setOpenWork(item.id);
    requestAnimationFrame(() => document.getElementById('work.' + item.id + '.title')?.focus());
  }
  function moveWork(index, direction) {
    changeWorkList((works) => {
      const ordered = [...works];
      [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
      return ordered;
    });
  }
  async function exit() {
    setBusy(true);
    setError(null);
    try {
      await flush();
      await request('/session/logout', 'POST');
      window.location.assign('/start?resume=1');
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  async function manage() {
    setBusy(true);
    setError(null);
    try {
      await flush();
      window.location.assign('/apply?manage=1');
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  return <section className="shell panel intake-layout">
    <aside className="steps-sidebar">
      <h1>Artist submission</h1>
      <nav aria-label="Submission steps"><ol className="steps">
        {steps.map(([key, label], index) => <li key={key}>
          <button type="button" aria-current={key === draft.step ? 'step' : undefined}
            disabled={uploads > 0 || busy || index > stepIndex}
            onClick={() => navigate(key)}>{label}</button>
        </li>)}
      </ol></nav>
      <p className="save-note" role="status">{saveState.label}</p>
      <button type="button" className="text-button left" disabled={busy || uploads > 0} onClick={exit}>Save and exit</button>
      <button type="button" className="text-button left manage-link"
        disabled={busy || uploads > 0} onClick={manage}>Manage submission</button>
    </aside>
    <div className="form-column" onBlur={() => flush().catch(() => {})}>
      {application.reviewNote && <p className="notice"><strong>Note from our editors</strong><br />{application.reviewNote}</p>}
      <h2 id="step-heading" tabIndex="-1">{steps[stepIndex][1]}</h2>
      {Object.keys(issues).length > 0 && <p className="problem" id="step-errors" role="alert" tabIndex="-1">
        {issues.works || 'Check the highlighted fields before continuing.'}
      </p>}
      {saveState.error && <div className="problem">
        <p>{saveState.error.message}</p>
        {saveState.error.status === 409 ? <button className="text-button" type="button"
          onClick={() => { if (confirm('Discard the unsaved changes on this device and open the newer draft?')) {
            discardLocally();
            window.location.reload();
          } }}>
          Open saved draft</button> : <button className="text-button" type="button" onClick={() => flush().catch(() => {})}>Retry save</button>}
        {saveState.error.status === 401 && <p><a href="/start?resume=1" target="_blank" rel="noreferrer">Open a fresh link in another tab</a>, then retry here.</p>}
      </div>}
      <form noValidate onSubmit={(event) => { event.preventDefault(); advance(); }}>
        <fieldset className="main-fields" disabled={busy}>
          {draft.step === 'profile' && <Profile profile={draft.profile} email={application.email} applicationId={application.id}
            change={changeProfile} issues={issues} onBusy={onBusy} busy={uploads > 0} />}
          {draft.step === 'works' && <div className="stack">
            <p className="intro small">Add three to five works you could offer for sale now.</p>
            <p className="field-hint">{draft.works.length} of {MAX_WORKS} work entries · {MIN_WORKS} required</p>
            {draft.works.map((work, index) =>
              <WorkCard key={work.id} work={work} applicationId={application.id} index={index} count={draft.works.length} active={openWork === work.id}
                toggle={() => setOpenWork(openWork === work.id ? null : work.id)}
                edit={(key, value) => changeWork(work.id, key, value)} onBusy={onBusy} busy={uploads > 0}
                issues={issues} remove={() => changeWorkList((works) => works.filter((item) => item.id !== work.id))}
                move={(direction) => moveWork(index, direction)} />)}
            {draft.works.length < MAX_WORKS && <button className="button secondary left" type="button"
              onClick={addWork} disabled={uploads > 0}>Add a work</button>}
          </div>}
          {draft.step === 'review' && <ReviewSummary draft={draft} email={application.email} navigate={navigate}
            issues={issues} change={changePermission} />}
          <ErrorBox error={error} />
          <div className="actions next-actions">
            {stepIndex > 0 && <button type="button" className="button secondary" disabled={uploads > 0}
              onClick={() => navigate(steps[stepIndex - 1][0])}>Back</button>}
            <button type="submit" className="button" disabled={uploads > 0}>
              {busy ? 'Saving…' : draft.step === 'review' ? 'Send my work for review' : 'Continue'}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  </section>;
}

function SubmissionStatus({ application, update }) {
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [workId, setWork] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reportKey, setReportKey] = useState(() => crypto.randomUUID());
  async function send(event) {
    event.preventDefault();
    if (kind === 'withdrawal' && !confirm('Withdraw this submission and remove any published profile?')) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request('/application/report', 'POST', { key: reportKey, kind, note, workId }, application.id);
      update(result);
      setFeedback(kind === 'sale' ? 'We updated the availability of that work.' : kind === 'withdrawal'
        ? 'Your submission has been withdrawn.' : 'We received your correction request.');
      setKind('');
      setNote('');
      setWork('');
      setReportKey(crypto.randomUUID());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await request('/session/logout', 'POST');
      window.location.assign('/');
    } catch (failure) {
      setError(failure);
    }
  }
  const current = application.draft.works.filter((work) => work.availability === 'available');
  const saleOptions = new Map([...application.publishedWorks, ...current].map(({ id, title }) => [id, title]));
  const title = { withdrawn: 'Submission withdrawn', published: 'Your profile is published',
    draft: 'Manage your draft', changes_requested: 'Manage your submission' }[application.status] || 'We received your work';
  return <Panel title={title} intro={application.status === 'submitted'
    ? 'Thank you for sharing your work. We’ll review your submission and email you with the next step.' : undefined}>
    <dl className="summary-list"><dt>Reference</dt><dd>{application.reference}</dd><dt>Status</dt><dd>{statuses[application.status]}</dd></dl>
    {feedback && <p role="status" className="notice">{feedback}</p>}
    {application.status !== 'withdrawn' && <form className="stack review-block" onSubmit={send}>
      <Select id="report-kind" label="Send an update" value={kind} required
        options={[['', 'Choose an update'],
          ...(saleOptions.size && application.status !== 'draft' ? [['sale', 'Report a sold work']] : []),
          ...(application.status !== 'draft' ? [['correction', 'Request a correction']] : []),
          ['withdrawal', 'Withdraw my submission']]}
        onChange={(event) => { setKind(event.target.value); setNote(''); setWork(''); setReportKey(crypto.randomUUID()); }} />
      {kind === 'sale' && <Select id="report-work" label="Which work sold?" value={workId} required
        options={[['', 'Choose a work'], ...saleOptions]} onChange={(event) => setWork(event.target.value)} />}
      {kind && <TextArea id="report-note" label={kind === 'correction' ? 'What needs to change?' : 'Note (optional)'}
        maxLength={1200} rows={3} required={kind === 'correction'} value={note} onChange={(event) => setNote(event.target.value)} />}
      {kind && <button className="button left" disabled={busy}>{busy ? 'Sending…' : 'Send update'}</button>}
    </form>}
    <ErrorBox error={error} />
    <div className="actions next-actions">
      {editable(application.status) && <a className="quiet-link" href="/apply">Return to editing</a>}
      <button type="button" className="text-button" onClick={logout}>Sign out</button>
    </div>
  </Panel>;
}
