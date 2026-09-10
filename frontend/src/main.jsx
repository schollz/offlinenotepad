import { createRoot } from 'react-dom/client';
import './style.css';

function PublishedDocument({ document: doc }) {
  document.title = doc.title;
  return <><h1>{doc.title}</h1><div dangerouslySetInnerHTML={{ __html: doc.html }} /></>;
}

async function start() {
  let published = JSON.parse(document.getElementById('app-data')?.textContent || 'null');
  // Production receives published data in the Go-served HTML. The dev server uses its API proxy.
  if (import.meta.env.DEV && location.pathname !== '/') {
    const response = await fetch('/api/published' + location.pathname);
    if (response.ok) published = await response.json();
  }
  const root = createRoot(document.getElementById('app'));
  if (published) {
    root.render(<PublishedDocument document={published} />);
  } else {
    const { default: App } = await import('./App.jsx');
    root.render(<App />);
  }
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(console.error);
  }
}

start();
