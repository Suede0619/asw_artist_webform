import React from 'react';

export function campaign() {
  return new URLSearchParams(window.location.search).get('campaign') === 'taos-artists' ? 'taos-artists' : 'direct';
}

export function route(path) {
  return campaign() === 'taos-artists' ? path + (path.includes('?') ? '&' : '?') + 'campaign=taos-artists' : path;
}

export function Layout({ children }) {
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <main id="main" tabIndex="-1">{children}</main>
    <footer className="footer">
      <div className="shell footer-inner">
        <span>ArtSouthwest</span>
      </div>
    </footer>
  </>;
}

export function Panel({ title, intro, children, narrow = true }) {
  return <section className={'shell panel ' + (narrow ? 'narrow' : '')}>
    <h1 tabIndex="-1">{title}</h1>
    {intro && <p className="intro">{intro}</p>}
    {children}
  </section>;
}

export function ErrorBox({ error }) {
  return error ? <p className="problem" role="alert">{error.message || error}</p> : null;
}

export function Field({ id, label, hint, error, children, ...input }) {
  const describedBy = [hint && id + '-hint', error && id + '-error'].filter(Boolean).join(' ') || undefined;
  const attributes = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy };
  return <div className="field">
    <label htmlFor={id}>{label}{input.required && <span aria-hidden="true" className="required"> *</span>}</label>
    {hint && <span className="field-hint" id={id + '-hint'}>{hint}</span>}
    {children ? children(attributes) : <input {...attributes} {...input} />}
    {error && <span className="field-error" id={id + '-error'}>{error}</span>}
  </div>;
}

export function TextArea({ rows = 4, ...props }) {
  const { value, onChange, maxLength, required, ...rest } = props;
  return <Field {...rest} required={required}>{(ids) =>
    <textarea {...ids} rows={rows} value={value} onChange={onChange} maxLength={maxLength} required={required} />
  }</Field>;
}

export function Select({ options, value, onChange, ...props }) {
  return <Field {...props}>{(ids) =>
    <select {...ids} value={value} onChange={onChange} required={props.required}>
      {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
  }</Field>;
}

export function Check({ id, label, checked, change, error, required = false }) {
  return <div className="check-field">
    <label htmlFor={id} className="check">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => change(event.target.checked)} required={required}
        aria-invalid={error ? true : undefined} aria-describedby={error ? id + '-error' : undefined} />
      <span>{label}</span>
    </label>
    {error && <span className="field-error" id={id + '-error'}>{error}</span>}
  </div>;
}

export const dateText = (millis) => millis ? new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Denver',
}).format(new Date(millis)) : '—';

export const statuses = {
  draft: 'Draft', submitted: 'In review', changes_requested: 'Changes requested',
  published: 'Published', withdrawn: 'Withdrawn',
};
