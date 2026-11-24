import { useEffect, useRef, useState } from 'react';
import { request } from './api.mjs';

export function useDraft(application) {
  const [draft, setDraft] = useState(application.draft);
  const [saveState, setSaveState] = useState({ label: 'All changes saved' });
  const current = useRef(application.draft);
  const saved = useRef(application.draft);
  const revision = useRef(application.revision);
  const inFlight = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    function warn(event) {
      if (current.current !== saved.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', warn);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  function flush() {
    clearTimeout(timer.current);
    if (!inFlight.current) {
      inFlight.current = (async () => {
        while (current.current !== saved.current) {
          const snapshot = current.current;
          setSaveState({ label: 'Saving…' });
          try {
            const result = await request('/application', 'PUT', { revision: revision.current, draft: snapshot }, application.id);
            revision.current = result.revision;
            saved.current = snapshot;
          } catch (error) {
            setSaveState({ label: 'Changes haven’t saved', error });
            throw error;
          }
        }
        setSaveState({ label: 'All changes saved' });
        return revision.current;
      })().finally(() => { inFlight.current = null; });
    }
    return inFlight.current;
  }

  function update(transform) {
    current.current = transform(current.current);
    setDraft(current.current);
    setSaveState({ label: 'Changes ready to save' });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush().catch(() => {}), 600);
  }

  function discardLocally() {
    clearTimeout(timer.current);
    current.current = saved.current;
  }

  return { draft, update, flush, discardLocally, saveState };
}
