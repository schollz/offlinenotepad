import localforage from 'localforage';
import Cookies from 'js-cookie';
import moment from 'moment';
import Swal from 'sweetalert2';
import { decode, encode, getHash } from './crypto.js';
import { documentHash, newDocument, parseDocument, renderMarkdown, slugify } from './documents.js';

const initialState = () => ({
  username: '', docs: {}, doc: null, mode: 'intro', showSearchBar: false,
  searchText: '', searchedText: '', showCheck: false, hasData: false, installed: false,
});

export async function confirmAction(text, confirmButtonText) {
  const result = await Swal.fire({
    title: 'Are you sure?', text, type: 'warning', showCancelButton: true,
    confirmButtonColor: '#3085d6', cancelButtonColor: '#d33', confirmButtonText,
  });
  return Boolean(result.value);
}

class NotesStore {
  state = initialState();
  listeners = new Set();
  password = '';
  session = 0;
  pending = null;
  socket = null;

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  set = changes => {
    this.state = { ...this.state, ...changes };
    this.listeners.forEach(listener => listener());
  };
  report = error => {
    console.error(error);
    Swal.fire({ type: 'error', title: 'Could not save your notes', text: String(error.message || error) });
  };

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    // Match the existing database name, store name, and driver priority.
    await localforage.setDriver([localforage.LOCALSTORAGE, localforage.WEBSQL, localforage.INDEXEDDB]);
    this.set({ hasData: (await localforage.keys()).length > 0 });
    window.addEventListener('pagehide', () => { this.flush(); this.rememberSession(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.flush(); this.rememberSession(); }
    });
    window.addEventListener('online', () => this.connect());
    window.addEventListener('popstate', event => this.restoreLocation(event.state));
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      this.installPrompt = event;
    });
    window.addEventListener('appinstalled', () => this.set({ installed: true }));
    const username = Cookies.get('app.username');
    if (!username || username === 'undefined') return;
    const password = decode(sessionStorage.getItem('app.p'), this.sessionKey(username));
    if (password) return this.login(username, password);
    const result = await Swal.fire({
      title: 'Welcome ' + username, html: 'Enter a password to decrypt your data.',
      input: 'password', inputPlaceholder: 'Enter your password',
      inputAttributes: { autocapitalize: 'off', autocorrect: 'off' },
      inputValidator: value => !value && 'You need to write something!',
    });
    if (result.value) await this.login(username, result.value);
  }

  sessionKey(username = this.state.username) {
    return getHash(moment().format('dddd, MMMM Do YYYY') + username);
  }

  rememberSession() {
    if (this.state.username && this.password) sessionStorage.setItem('app.p', encode(this.password, this.sessionKey()));
  }

  async login(username, password) {
    if (!username || !password) return;
    this.disconnect();
    const session = ++this.session;
    this.password = password;
    Cookies.set('app.username', username);
    this.set({ username });
    this.rememberSession();
    const docs = {};
    await localforage.iterate(value => {
      const doc = parseDocument(value, password);
      if (doc) docs[doc.uuid] = doc;
    });
    if (session !== this.session) return;
    this.set({ docs, mode: 'list', doc: null, hasData: (await localforage.keys()).length > 0 });
    this.restoreLocation(history.state);
    this.connect();
  }

  async logout() {
    if (!await confirmAction('This will clear log you out, but your encrypted data is saved.', 'Yes, log me out.')) return;
    await this.flush();
    this.resetSession();
  }

  async clearAllData() {
    if (!await confirmAction('This will clear all local data, but your encrypted data is safely stored on the server.', 'Yes, clear all.')) return;
    await this.flush();
    this.resetSession();
    await localforage.clear();
    this.set({ hasData: false });
  }

  resetSession() {
    this.session++;
    this.disconnect();
    this.password = '';
    Cookies.remove('app.username');
    sessionStorage.removeItem('app.p');
    clearTimeout(this.checkTimer);
    this.set({ ...initialState(), hasData: this.state.hasData, installed: this.state.installed });
    history.pushState(null, '', '/');
    document.title = 'Offline Notepad';
  }

  async navigate(mode, doc = this.state.doc, push = true) {
    await this.flush();
    this.set({ mode, doc, showSearchBar: false, searchText: '', searchedText: '' });
    this.updateURL(push);
    window.scrollTo(0, 0);
  }

  updateURL(push = true) {
    const { mode, doc } = this.state;
    const isDocument = (mode === 'view' || mode === 'edit') && doc;
    const url = isDocument ? '/' + (slugify(doc.title) || doc.uuid) : '/';
    const state = { mode, uuid: isDocument ? doc.uuid : null };
    if (push && location.pathname !== url) history.pushState(state, '', url);
    else history.replaceState(state, '', url);
    document.title = isDocument ? (doc.title || doc.uuid) : 'Offline Notepad';
  }

  restoreLocation = async (historyState) => {
    await this.flush();
    if (!this.password) return;
    const slug = location.pathname.slice(1);
    const doc = this.state.docs[historyState?.uuid] || Object.values(this.state.docs)
      .find(doc => slug && (slugify(doc.title) === slug || doc.uuid === slug));
    if (doc && doc.title !== 'deleted') {
      this.set({ doc, mode: historyState?.mode === 'edit' ? 'edit' : 'view', showSearchBar: false });
    } else {
      this.set({ mode: 'list', doc: null, showSearchBar: false, searchedText: '' });
    }
    this.updateURL(false);
  };

  makeNew = () => this.navigate('edit', newDocument());
  select = uuid => this.navigate('view', this.state.docs[uuid]);

  edit = changes => {
    const doc = { ...this.state.doc, ...changes, modified: new Date().toISOString() };
    doc.hash = documentHash(doc);
    this.pending = doc;
    this.set({ doc, docs: { ...this.state.docs, [doc.uuid]: doc } });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush().catch(this.report), 400);
  };

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.pending) return this.saving;
    const doc = this.pending;
    this.pending = null;
    const session = this.session;
    const encoded = encode(JSON.stringify(doc), this.password);
    this.saving = localforage.setItem(doc.uuid, encoded).then(() => {
      if (session !== this.session) return;
      this.sendDocuments({ [doc.uuid]: encoded }, { [doc.uuid]: doc.hash });
      if (doc.title === 'deleted') this.send('delete-publish', { [doc.uuid]: '' });
      this.set({ hasData: true });
      this.flashCheck();
    });
    this.updateURL();
    return this.saving;
  }

  flashCheck() {
    clearTimeout(this.checkTimer);
    this.set({ showCheck: true });
    this.checkTimer = setTimeout(() => this.set({ showCheck: false }), 500);
  }

  async deleteDocument() {
    if (!await confirmAction("You won't be able to revert this!", 'Yes, delete it!')) return;
    this.edit({ title: 'deleted', markdown: '', rawHTML: '', published: false });
    await this.navigate('list', null);
  }

  async publishDocument() {
    await this.flush();
    const { doc } = this.state;
    if (!doc.published && !await confirmAction('This will publish a public version of this document that anyone can view.', 'Yes, publish.')) return;
    if (!this.send('update-publish', { [doc.uuid]: JSON.stringify({
      ID: doc.uuid, Title: doc.title, HTML: renderMarkdown(doc.markdown), Markdown: doc.markdown,
    }) })) {
      await Swal.fire({ type: 'error', title: 'Unable to publish', text: 'Connect to the server to publish this document.' });
    }
  }

  exportDocuments() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.state.docs)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'offlinenotepad_' + this.state.username + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async install() {
    if (this.installPrompt) {
      await this.installPrompt.prompt();
      await this.installPrompt.userChoice;
      this.installPrompt = null;
    }
    this.set({ installed: true });
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.syncTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
  }

  connect() {
    if (!this.password || !this.state.username || !navigator.onLine) return;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    clearTimeout(this.reconnectTimer);
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
    const session = this.session;
    this.socket = socket;
    socket.onopen = () => {
      if (session !== this.session) return socket.close();
      this.send('get-hashes');
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => this.send('get-hashes'), 10000);
    };
    socket.onmessage = event => {
      if (session !== this.session) return;
      this.receive(JSON.parse(event.data), session).catch(this.report);
    };
    socket.onclose = () => {
      clearInterval(this.syncTimer);
      if (session === this.session) this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };
  }

  send(type, datas) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.state.username) return false;
    this.socket.send(JSON.stringify({ type, user: getHash(this.state.username), ...(datas && { datas }) }));
    return true;
  }

  sendDocuments(datas, hashes) {
    if (!Object.keys(datas).length) return;
    this.send('update-data', datas);
    this.send('update-hashes', hashes);
  }

  async receive(message, session) {
    if (!message.success) { console.warn(message.message); return; }
    const incoming = message.datas || {};
    const datas = {};
    const hashes = {};
    const offer = doc => {
      datas[doc.uuid] = encode(JSON.stringify(doc), this.password);
      hashes[doc.uuid] = doc.hash;
    };
    if (message.type === 'hashes') {
      const request = {};
      for (const [uuid, hash] of Object.entries(incoming)) {
        if (this.state.docs[uuid]?.hash !== hash) request[uuid] = '';
      }
      if (Object.keys(request).length) this.send('get-data', request);
      for (const doc of Object.values(this.state.docs)) {
        if (!(doc.uuid in incoming)) offer(doc);
        if (doc.title === 'deleted') this.send('delete-publish', { [doc.uuid]: '' });
      }
    } else if (message.type === 'update') {
      for (const [uuid, value] of Object.entries(incoming)) {
        const doc = parseDocument(value, this.password);
        if (!doc || doc.uuid !== uuid) continue;
        const local = this.state.docs[uuid];
        if (local && new Date(local.modified) >= new Date(doc.modified)) {
          offer(local);
          continue;
        }
        if (this.pending?.uuid === uuid) {
          this.pending = null;
          clearTimeout(this.saveTimer);
        }
        // Update memory before awaiting storage so newly typed text cannot be overwritten.
        this.set({ docs: { ...this.state.docs, [uuid]: doc },
          ...(this.state.doc?.uuid === uuid && { doc }), hasData: true });
        await localforage.setItem(uuid, value);
        if (session !== this.session) return;
      }
    } else if (message.type === 'published') {
      for (const uuid of Object.keys(incoming)) {
        if (!this.state.docs[uuid]) continue;
        const doc = { ...this.state.docs[uuid], published: true };
        this.set({ docs: { ...this.state.docs, [uuid]: doc },
          ...(this.state.doc?.uuid === uuid && { doc: { ...this.state.doc, published: true } }) });
        if (this.pending?.uuid === uuid) this.pending = { ...this.pending, published: true };
        offer(doc);
        await localforage.setItem(uuid, datas[uuid]);
        if (session !== this.session) return;
      }
      this.flashCheck();
    }
    if (session === this.session) this.sendDocuments(datas, hashes);
  }
}

export const notesStore = new NotesStore();
