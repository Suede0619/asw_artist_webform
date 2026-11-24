import React, { useEffect, useState } from 'react';
import { COMMISSION } from '../shared/intake.mjs';
import { request } from './api.mjs';
import { campaign, route, Panel, Field, Check, ErrorBox } from './ui.jsx';

export function Landing() {
  useEffect(() => {
    let session = window.crypto.randomUUID();
    try {
      const storageKey = 'asw-landing-' + campaign();
      session = sessionStorage.getItem(storageKey) || session;
      sessionStorage.setItem(storageKey, session);
    } catch { /* The invitation still works without browser storage. */ }
    request('/visit', 'POST', { campaign: campaign(), session }).catch(() => {});
  }, []);
  return <>
    <section className="shell hero">
      <div className="hero-copy">
        <h1>An invitation to show your work</h1>
        <p>Southwest Arts is a new guide to art in Taos and Santa Fe. We’re inviting a small group of Taos artists to share work for the first edition.</p>
        <p className="offer">Free to submit. <strong>{COMMISSION}% commission on artwork sold through the platform.</strong></p>
        <div className="actions">
          <a className="button" href={route('/start')}>Start my submission</a>
          <a className="quiet-link" href={route('/callback')}>Request a call</a>
        </div>
      </div>
      <figure className="hero-image">
        <img src="/studio-light.jpg" width="1536" height="1024" alt="Hands holding an unglazed ceramic vessel in a sunlit studio." fetchPriority="high" />
      </figure>
    </section>
    <section className="shell invitation-details">
      <div>
        <h2>How the feature works</h2>
        <p>Each city’s selection brings together artists, galleries, things to do, places to eat and places to stay. We want readers to find work they connect with and have enough context to see it or inquire.</p>
        <p>We’ll review your submission and ask you to confirm the profile and works we propose to feature.</p>
        <p>We’ll share the seller terms before you decide whether to sell through the site.</p>
      </div>
      <div className="checklist">
        <h2>What to have ready</h2>
        <ul>
          <li>A short bio and a portrait you have permission to share.</li>
          <li>Three to five available works, with a title, description, medium, dimensions and price for each.</li>
          <li>A photo of each work. Every image needs at least 1,080 pixels on its longest side.</li>
        </ul>
      </div>
    </section>
  </>;
}

export function Start() {
  const [mode, setMode] = useState(new URLSearchParams(window.location.search).get('resume') === '1' ? 'resume' : 'start');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  useEffect(() => {
    request('/application').then(() => setPhase((current) => current === 'idle' ? 'existing' : current)).catch(() => {});
  }, []);
  async function send(event) {
    event.preventDefault();
    setPhase('busy');
    setError(null);
    try {
      await request('/start', 'POST', { email, mode, campaign: campaign() });
      setPhase('sent');
    } catch (failure) {
      setPhase('idle');
      setError(failure);
    }
  }
  if (phase === 'sent') {
    return <Panel title="Check your email" intro={mode === 'resume'
      ? 'If you have a submission at that address, we’ll send you a private link.'
      : 'We’ll send a private link to the address you entered. Open it to start your submission.'}>
      <p>The link works once and expires in 24 hours. Check your spam folder if it hasn’t arrived.</p>
      <button className="text-button" type="button" onClick={() => setPhase('idle')}>Use a different address</button>
    </Panel>;
  }
  return <Panel title={mode === 'resume' ? 'Resume your submission' : 'Start your artist submission'}
    intro="Enter your email for a private link. You can save your progress and finish later.">
    {phase === 'existing' && <p className="notice"><a href="/apply">Continue the submission open on this device</a></p>}
    <form className="stack" onSubmit={send}>
      <Field id="start-email" label="Email address" type="email" autoComplete="email" required maxLength={254}
        value={email} onChange={(event) => setEmail(event.target.value)} />
      <ErrorBox error={error} />
      <div className="actions"><button className="button" disabled={phase === 'busy'}>Email me a private link</button></div>
    </form>
    <p><button className="text-button" type="button" onClick={() => setMode(mode === 'start' ? 'resume' : 'start')}>
      {mode === 'start' ? 'Already started?' : 'Starting a new submission?'}
    </button></p>
  </Panel>;
}

export function Resume() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function redeem() {
    setBusy(true);
    setError(null);
    try {
      await request('/session/redeem', 'POST', { token });
      window.location.replace('/apply');
    } catch (failure) {
      setBusy(false);
      setError(failure);
    }
  }
  return <Panel title="Your Southwest Arts submission" intro="Open your submission on this device to continue.">
    <ErrorBox error={error} />
    {/^[\w-]{43}$/.test(token) && error?.status !== 410 &&
      <button className="button" onClick={redeem} disabled={busy}>{busy ? 'Opening…' : 'Open my submission'}</button>}
    <p><a className="quiet-link" href="/start?resume=1">Request a new link</a></p>
  </Panel>;
}

export function Callback() {
  const [key] = useState(() => window.crypto.randomUUID());
  const [data, setData] = useState({ name: '', phone: '', bestTime: '', question: '', consent: false });
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const value = (name) => ({
    value: data[name], onChange: (event) => setData((current) => ({ ...current, [name]: event.target.value })),
  });
  async function send(event) {
    event.preventDefault();
    setPhase('busy');
    setError(null);
    try {
      await request('/callbacks', 'POST', { ...data, key, campaign: campaign() });
      setPhase('sent');
    } catch (failure) {
      setPhase('idle');
      setError(failure);
    }
  }
  if (phase === 'sent') return <Panel title="We received your request"
    intro="Someone from Southwest Arts will call the number you shared.">
    <a className="button secondary" href={route('/')}>Back to the invitation</a>
  </Panel>;
  return <Panel title="Talk with us first" intro="Leave a number and we’ll get in touch to answer your questions.">
    <form className="stack" onSubmit={send}>
      <Field id="callback-name" label="Name" autoComplete="name" required maxLength={120} {...value('name')} />
      <Field id="callback-phone" label="Phone number" autoComplete="tel" type="tel" required maxLength={32}
        error={error?.fields?.phone} {...value('phone')} />
      <Field id="callback-time" label="Best time to call (optional)" maxLength={150} {...value('bestTime')} />
      <Field id="callback-question" label="What would you like to ask? (optional)" maxLength={600} {...value('question')} />
      <Check id="callback-consent" label="You may call me about this invitation." checked={data.consent}
        change={(consent) => setData((current) => ({ ...current, consent }))} required />
      <ErrorBox error={error} />
      <div className="actions">
        <button className="button" disabled={phase === 'busy'}>{phase === 'busy' ? 'Sending…' : 'Request a call'}</button>
        <a className="quiet-link" href={route('/')}>Back to the invitation</a>
      </div>
    </form>
  </Panel>;
}

export function Privacy() {
  return <Panel title="Privacy and submissions">
    <div className="prose">
      <h2>How we use your information</h2>
      <p>We use your contact details to return a call, send private submission links and follow up on work you share. We keep private contact details, draft text, permission records and original uploads in the submission system. Only cleared profile and work details and approved image copies appear in the catalog.</p>
      <p>We count invitation visits and submissions to understand whether the form works. We do not use your call or submission to subscribe you to marketing email.</p>
      <h2>What you can change</h2>
      <p>Use a private submission link to return, report that a work sold, request a correction or withdraw. To ask about your information or request deletion, reply to a submission email or request a call.</p>
      <p>We remove inactive drafts after 30 days and clear withdrawn submissions from the active system after 30 days. Private backup copies rotate separately. We keep application and permission records while a feature remains under review or published.</p>
      <a className="quiet-link" href="/callback">Request a call</a>
    </div>
  </Panel>;
}
