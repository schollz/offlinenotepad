import moment from 'moment';
import showdown from 'showdown';
import lunr from 'lunr';
import { getHash, decode } from './crypto.js';

const converter = new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true });
export const renderMarkdown = text => converter.makeHtml(text || '');
export const formatDate = date => moment(date).format('MM-DD hh:mm A');
export const isCode = doc => Boolean(doc?.title?.includes('.'));
export const documentHash = doc => getHash(doc.uuid + doc.title + doc.markdown);

export function newDocument() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const uuid = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => alphabet[n % alphabet.length]).join('');
  const now = new Date().toISOString();
  const doc = { uuid, created: now, modified: now, title: '', markdown: '', published: false };
  return { ...doc, hash: documentHash(doc) };
}

export function parseDocument(value, password) {
  try {
    const doc = JSON.parse(decode(value, password));
    if (doc && typeof doc.uuid === 'string' && typeof doc.title === 'string' && typeof doc.markdown === 'string') return doc;
  } catch { /* Other passwords and unrelated storage entries are ignored. */ }
  return null;
}

export function slugify(text = '') {
  for (const line of text.split('\n')) {
    const slug = line.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '')
      .replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length > 1) return slug;
  }
  return '';
}

export function sortedDocuments(docs) {
  return Object.values(docs).filter(doc => doc.title !== 'deleted')
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

export function searchDocuments(docs, text) {
  if (!text.trim()) return [];
  const index = lunr(function () {
    this.ref('uuid');
    this.field('title');
    this.field('text');
    this.metadataWhitelist = ['position'];
    sortedDocuments(docs).forEach(doc => this.add({ ...doc, text: doc.markdown }));
  });
  let matches;
  try { matches = index.search(text); } catch { return []; }
  return matches.map(match => {
    const doc = docs[match.ref];
    const positions = Object.values(match.matchData.metadata)
      .flatMap(fields => fields.text?.position || []).sort((a, b) => a[0] - b[0]);
    const start = Math.max(0, (positions[0]?.[0] || 0) - 60);
    const end = Math.min(doc.markdown.length, (positions.at(-1)?.[0] || 0) + 60);
    return { ...doc, snippet: doc.markdown.slice(start, end), positions,
      snippetStart: start, prefix: start > 0 ? '...' : '', suffix: end < doc.markdown.length ? '...' : '' };
  });
}
