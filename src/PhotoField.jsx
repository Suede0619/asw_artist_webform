import React, { useRef, useState } from 'react';
import { MAX_BYTES, MIN_EDGE } from '../shared/intake.mjs';
import { uploadImage } from './api.mjs';
import { Field } from './ui.jsx';

async function checkFile(file) {
  if (file.size > MAX_BYTES) throw new Error('Choose an image no larger than 12 MB.');
  if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
    throw new Error('This photo uses HEIC. Export it as JPEG, then upload the JPEG.');
  }
  if (typeof createImageBitmap !== 'function') return;
  let preview;
  try {
    preview = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return; // The server gives the authoritative format and size result.
  }
  try {
    if (Math.max(preview.width, preview.height) < MIN_EDGE) {
      throw new Error('This image is ' + preview.width + ' by ' + preview.height +
        ' pixels. Choose one with at least 1,080 pixels on its longest side.');
    }
  } finally {
    preview.close();
  }
}

export function PhotoPicker({ id, label, role, applicationId, onAdd, onBusy, disabled, error }) {
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [state, setState] = useState({});
  async function send(item) {
    setState({ message: 'Checking image…', busy: true });
    onBusy(1);
    try {
      await checkFile(item.file);
      setState({ progress: 0, busy: true });
      const saved = await uploadImage(item.file, role, item.key, applicationId, (progress) => setState({ progress, busy: true }));
      onAdd({ id: saved.id, credit: '', alt: '' });
      setState({ message: 'Photo uploaded.' });
      setFile(null);
    } catch (failure) {
      setState({ error: failure.message });
    } finally {
      onBusy(-1);
    }
  }
  return <div className="upload">
    <Field id={id} label={label} error={error} hint="JPEG, PNG or WebP. At least 1,080 pixels on the longest side. Up to 12 MB.">
      {(ids) => <input {...ids} ref={input} type="file" accept="image/jpeg,image/png,image/webp"
        disabled={state.busy || disabled} onChange={(event) => {
          const selected = event.target.files?.[0];
          input.current.value = '';
          if (!selected) return;
          const item = { file: selected, key: crypto.randomUUID() };
          setFile(item);
          send(item);
        }} />}
    </Field>
    {state.progress !== undefined && <progress aria-label="Upload progress" max="100" value={state.progress} />}
    {state.message && <p className="field-hint" role="status">{state.message}</p>}
    {state.error && <div className="upload-error">
      <p className="field-error" role="alert">{state.error}</p>
      {file && <button className="text-button" type="button" onClick={() => send(file)} disabled={disabled}>Retry photo</button>}
    </div>}
  </div>;
}

export function PhotoCard({ media, title, id, issues = {}, onChange, onRemove, showAlt = true }) {
  return <div className="photo-card">
    <img src={'/api/application/assets/' + media.id} alt={media.alt || title} loading="lazy" />
    <div className="stack compact">
      <Field id={id + '.credit'} label={title + ' credit'} value={media.credit} maxLength={160}
        required error={issues[id + '.credit']} onChange={(event) => onChange({ ...media, credit: event.target.value })} />
      {showAlt && <Field id={id + '.alt'} label="Image description (optional)" value={media.alt} maxLength={250}
        onChange={(event) => onChange({ ...media, alt: event.target.value })} />}
      <button className="text-button left" type="button" onClick={onRemove}>Remove {title.toLowerCase()}</button>
      {issues[id] && <p className="field-error" role="alert">{issues[id]}</p>}
    </div>
  </div>;
}
