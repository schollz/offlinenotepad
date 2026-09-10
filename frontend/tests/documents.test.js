import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../src/crypto.js';
import { documentHash, parseDocument, renderMarkdown, searchDocuments } from '../src/documents.js';
import { encrypted, password } from './legacy-fixture.js';

test('decrypts notes written by the original app with unchanged hashes', () => {
  const doc = parseDocument(encrypted, password);
  assert.equal(doc.uuid, 'legacy01');
  assert.equal(doc.markdown, '# Still here\n\nEncrypted café notes 🔒');
  assert.equal(doc.hash, documentHash(doc));
});

test('encryption round trips Unicode, tabs, and empty notes', () => {
  for (const text of ['', '\tHello\n世界 🔒', JSON.stringify({ title: 'Résumé', markdown: '**bold**' })]) {
    assert.equal(decode(encode(text, password), password), text);
  }
  assert.notEqual(encode('same note', password), encode('same note', password));
});

test('wrong passwords and damaged entries do not load documents', () => {
  assert.equal(parseDocument(encrypted, 'wrong-password'), null);
  assert.equal(parseDocument('corrupted', password), null);
  assert.equal(parseDocument(null, password), null);
});

test('preserves Markdown rendering and excludes tombstones from search', () => {
  assert.equal(renderMarkdown('A **bold** note with ~~deleted~~ text.'), '<p>A <strong>bold</strong> note with <del>deleted</del> text.</p>');
  const doc = parseDocument(encrypted, password);
  const docs = { legacy01: doc, removed: { ...doc, uuid: 'removed', title: 'deleted' } };
  assert.deepEqual(searchDocuments(docs, 'encrypted').map(doc => doc.uuid), ['legacy01']);
  assert.deepEqual(searchDocuments(docs, 'title:'), []);
});
