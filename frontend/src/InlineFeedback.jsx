import { useLayoutEffect, useRef } from 'react';
import { notesStore as store } from './notes-store.js';

function Confirmation({ confirmation }) {
  const panel = useRef(null);
  const heading = useRef(null);

  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const element = panel.current;
    heading.current.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest' });
    const escape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        store.cancelConfirmation();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      if (trigger?.isConnected && (element.contains(document.activeElement) || document.activeElement === document.body)) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [confirmation.id]);

  return <section ref={panel} className="inline-feedback" aria-labelledby="confirmation-title" aria-describedby="confirmation-text">
    <h2 id="confirmation-title" ref={heading} tabIndex={-1} aria-describedby="confirmation-text">{confirmation.title}</h2>
    <p id="confirmation-text">{confirmation.text}</p>
    <div className="inline-actions">
      <button type="button" className="text-action" onClick={() => store.confirmAction().catch(store.report)}>{confirmation.label}</button>
      <button type="button" className="text-action secondary" onClick={store.cancelConfirmation}>cancel</button>
    </div>
  </section>;
}

export default function InlineFeedback({ confirmation, notice }) {
  return <>
    {confirmation && <Confirmation confirmation={confirmation} />}
    {notice && <section className="inline-feedback inline-notice" aria-label="Notice">
      <p role="alert"><strong>{notice.title}</strong>{' '}{notice.text}</p>
      <button type="button" className="text-action secondary" onClick={() => store.set({ notice: null })}>dismiss</button>
    </section>}
  </>;
}
