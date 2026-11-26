import React, { useEffect, useState } from 'react';
import { COMMISSION } from '../shared/intake.mjs';
import { request } from './api.mjs';
import { campaign, route, Panel, Field, Check, ErrorBox } from './ui.jsx';

export function Landing() {
  const saved = new URLSearchParams(window.location.search).get('saved') === '1';
  useEffect(() => {
    let session = window.crypto.randomUUID();
    try {
      const storageKey = 'asw-landing-' + campaign();
      session = sessionStorage.getItem(storageKey) || session;
      sessionStorage.setItem(storageKey, session);
    } catch { /* The invitation still works without browser storage. */ }
    request('/visit', 'POST', { campaign: campaign(), session }).catch(() => {});
  }, []);
  return (
    <div className="shell invitation">
      <p className="invitation-brand">ArtSouthwest</p>
      <section className="hero">
        <div className="hero-copy">
          <h1>We’d like to feature your work in our first edition.</h1>
          <p>ArtSouthwest pairs a curated online art catalog with an insider’s guide to Taos and Santa Fe. Alongside the artwork, collectors will find galleries, studio visits and distinctive places to eat and stay.</p>
          <p>Select works that best convey the character of your practice. Please provide a short bio and a portrait, along with three to five works available for sale. For each work, include an image, title, brief description, medium, dimensions and price. Our team reviews your submission before publishing your profile and artwork on ArtSouthwest.</p>
          <p className="offer">ArtSouthwest charges a {COMMISSION}% commission on completed artwork sales through the website.</p>
          {saved && <p role="status">Your draft is saved. Return in this browser to continue.</p>}
          <div className="actions">
            <a className="button" href={route('/apply')}>{saved ? 'Continue my submission' : 'Start my submission'}</a>
            <a className="quiet-link" href={route('/callback')}>Request a call</a>
          </div>
        </div>
        <figure className="hero-image">
          <img src="/adobe-door.jpg" width="1536" height="1024" alt="An open blue door reveals an easel inside an adobe studio." fetchPriority="high" />
        </figure>
      </section>
    </div>
  );
}

function RequestLink() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const sending = phase === 'busy';
  async function send(event) {
    event.preventDefault();
    if (sending) return;
    setPhase('busy');
    setError(null);
    try {
      await request('/start', 'POST', { email, mode: 'resume' });
      setPhase('sent');
    } catch (failure) {
      setPhase('idle');
      setError(failure);
    }
  }
  if (document.body.hasAttribute('data-email-unavailable')) {
    return <Panel title="Return to your submission" intro="Open the form in the browser you used to start your submission, or use the private link you saved.">
      <a className="button" href={route('/apply')}>Open the artist form</a>
    </Panel>;
  }
  if (phase === 'sent') {
    return <Panel title="Check your email"
      intro="If you’ve verified this address for a submission, we’ll send a private link.">
      <p>The link works once and expires in 24 hours. Check your spam folder if it hasn’t arrived.</p>
      <button className="text-button" type="button" onClick={() => setPhase('idle')}>Use a different address</button>
    </Panel>;
  }
  return <Panel title="Request a new link" intro="Enter the email address you verified for your submission.">
    <form className="stack" onSubmit={send}>
      <Field id="resume-email" label="Email address" type="email" autoComplete="email" required maxLength={254}
        disabled={sending} value={email} onChange={(event) => setEmail(event.target.value)} />
      <ErrorBox error={error} />
      <div className="actions">
        <button className="button" disabled={sending}>
          {sending ? 'Sending…' : 'Email me a private link'}
        </button>
      </div>
    </form>
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
  if (!token) return <RequestLink />;
  return <Panel title="Your ArtSouthwest submission" intro="Open your submission on this device to continue.">
    <ErrorBox error={error} />
    {/^[\w-]{43}$/.test(token) && error?.status !== 410 &&
      <button className="button" onClick={redeem} disabled={busy}>{busy ? 'Opening…' : 'Open my submission'}</button>}
    <p><a className="quiet-link" href={route('/resume?recover=1')}>
      {document.body.hasAttribute('data-email-unavailable') ? 'Return in your original browser' : 'Request a new link'}</a></p>
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
    intro="Thank you. We’ll call you at the number you shared.">
    <a className="button secondary" href={route('/')}>Back to the invitation</a>
  </Panel>;
  return <Panel title="Talk with us" intro="If you’d like to discuss the invitation, leave your number and we’ll call you.">
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
  return <Panel title="Privacy">
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
