import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CircleCheck, Download, Eye, FilePlus, House, Link, LogIn, LogOut, OctagonX, Save, Search, Send, SquarePen, Trash2 } from 'lucide-react';
import { getHash } from './crypto.js';
import { formatDate, isCode, renderMarkdown, searchDocuments, sortedDocuments } from './documents.js';
import { notesStore as store } from './notes-store.js';
import InlineFeedback from './InlineFeedback.jsx';

function Action({ id, icon: Icon, children, onClick, href, ...props }) {
  const activate = event => Promise.resolve(onClick?.(event)).catch(store.report);
  return <><a id={id} className="link" href={href} role={href ? undefined : 'button'}
    tabIndex={href ? undefined : 0} onClick={activate}
    onKeyDown={event => {
      if (!href && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(event); }
    }} {...props}><Icon size={24} strokeWidth={2} />{children && <> {children}</>}</a>{' '}</>;
}

function LoginBar({ hasData, installed, chrome, loginUser, needsUnlock }) {
  const [password, setPassword] = useState('');
  const passwordInput = useRef(null);
  useEffect(() => {
    if (needsUnlock) passwordInput.current.focus();
  }, [needsUnlock]);
  const login = () => store.login(loginUser, password).catch(store.report);
  const enter = event => { if (event.key === 'Enter') login(); };
  return <span className="fl font">
    <input id="loginUser" value={loginUser} onChange={event => store.set({ loginUser: event.target.value, needsUnlock: false, confirmation: null })}
      placeholder="username" aria-label="username" autoComplete="username" onKeyUp={enter} />{' '}
    <input ref={passwordInput} id="loginPass" type="password" value={password} onChange={event => setPassword(event.target.value)}
      placeholder="password" aria-label="password" autoComplete="current-password" onKeyUp={enter} />{' '}
    <Action id="loginLink" icon={LogIn} aria-label="login" onClick={login} />
    {chrome && !installed && <Action id="installer" icon={Download} onClick={() => store.install()}>install (optional)</Action>}
    {hasData && <Action id="clearlink" icon={OctagonX} onClick={() => store.clearAllData()}>clear</Action>}
  </span>;
}

function Toolbar({ state, chrome }) {
  const { mode, doc, username, showSearchBar } = state;
  const list = mode === 'list' || mode === 'search';
  return <div className="topbar">
    {mode === 'intro' ? <LoginBar hasData={state.hasData} installed={state.installed} chrome={chrome}
      loginUser={state.loginUser} needsUnlock={state.needsUnlock} /> : <span className="fl">
      {(!list || showSearchBar) && <Action id="listlink" icon={House} onClick={() => store.navigate('list', null)}>{username}</Action>}
      {list && <Action id="newlink" icon={FilePlus} onClick={store.makeNew}>new</Action>}
      {list && !showSearchBar && <Action id="searfhbarLink" icon={Search} onClick={() => store.set({ showSearchBar: true, searchText: '' })}>search</Action>}
      {list && <Action id="exportlink" icon={Save} onClick={() => store.exportDocuments()}>export</Action>}
      {list && <Action id="logoutlink" icon={LogOut} onClick={() => store.logout()}>logout</Action>}
      {mode === 'edit' && <Action id="viewlink" icon={Eye} onClick={() => store.navigate('view')}>view</Action>}
      {mode === 'edit' && <Action id="deletelink" icon={Trash2} onClick={() => store.deleteDocument()}>erase</Action>}
      {mode === 'view' && <Action id="editlink" icon={SquarePen} onClick={() => store.navigate('edit')}>edit</Action>}
      {mode === 'view' && doc.published && <Action id="publiclink" icon={Link} href={'/' + getHash(doc.uuid)} target="_blank" rel="noopener">/{getHash(doc.uuid)}</Action>}
      {mode === 'view' && <Action id="publislink" icon={Send} onClick={() => store.publishDocument()}>publish</Action>}
    </span>}
  </div>;
}

function Introduction({ chrome, hasData }) {
  return <div>
    <p>Welcome to the Offline Notepad.</p>
    <p>Offline Notepad is an <a href="https://github.com/schollz/offlinenotepad">open-source</a>, offline-capable note-writing app that securely synchronizes across all your devices. Everything you write is encrypted and stored locally, with encrypted syncing via a server.</p>
    <p>Offline Notepad is offline-first, which means you can create, edit, delete, and search notes without an internet connection. Your notes automatically sync with a server using end-to-end encryption when you come online.</p>
    <p>Click <em>login</em> to begin.</p>
    <p>{chrome ? <>Click <em>install</em> to add this app to your device</> : <>Click the upper right of your browser and "Add to home screen" to add this app to your device</>}.</p>
    {hasData && <p>Click <em>clear</em> to erase all the current local data (which is encrypted and backed up to the server).</p>}
  </div>;
}

function NoteRow({ doc }) {
  return <div>
    <div id={doc.uuid} className="link" role="button" tabIndex={0} onClick={() => store.select(doc.uuid)}
      onKeyDown={event => { if (event.key === 'Enter') store.select(doc.uuid); }}><span>{doc.title || doc.uuid}</span></div>
    <div>{formatDate(doc.created)}</div>
  </div>;
}

function Snippet({ doc }) {
  const parts = [];
  let offset = 0;
  for (const [position, length] of doc.positions) {
    const start = Math.max(0, position - doc.snippetStart);
    const end = Math.min(doc.snippet.length, start + length);
    if (start < offset || start >= doc.snippet.length) continue;
    parts.push(<Fragment key={position}>{doc.snippet.slice(offset, start)}<mark>{doc.snippet.slice(start, end)}</mark></Fragment>);
    offset = end;
  }
  return <q className="snippet">{doc.prefix}{parts}{doc.snippet.slice(offset)}{doc.suffix}</q>;
}

function SearchResults({ docs, text }) {
  const found = useMemo(() => searchDocuments(docs, text), [docs, text]);
  return <div>
    <p>Found {found.length} items that match '{text}':</p>
    {found.map(doc => <div key={doc.uuid} className="pt5"><div className="list"><NoteRow doc={doc} /></div><Snippet doc={doc} /></div>)}
  </div>;
}

function Editor({ doc }) {
  const textarea = useRef(null);
  useLayoutEffect(() => {
    const field = textarea.current;
    const computed = window.getComputedStyle(field);
    const height = parseInt(computed.borderTopWidth, 10) + parseInt(computed.paddingTop, 10) + field.scrollHeight +
      parseInt(computed.paddingBottom, 10) + parseInt(computed.borderBottomWidth, 10);
    if (field.style.height !== height + 'px') {
      field.style.height = 'inherit';
      field.style.height = height + 'px';
    }
  }, [doc]);
  function tab(event) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const field = event.currentTarget;
    const start = field.selectionStart;
    store.edit({ markdown: doc.markdown.slice(0, start) + '\t' + doc.markdown.slice(field.selectionEnd) });
    requestAnimationFrame(() => field.setSelectionRange(start + 1, start + 1));
  }
  return <div className="pt5">
    <input id="edittitle" autoComplete="off" placeholder="Title" aria-label="Title" value={doc.title}
      onChange={event => store.edit({ title: event.target.value })} className={isCode(doc) ? 'iscode' : ''} />
    <textarea ref={textarea} id="editable" autoComplete="off" rows={110} placeholder="Click here and start writing"
      aria-label="Note" value={doc.markdown} onChange={event => store.edit({ markdown: event.target.value })}
      onKeyDown={tab} className={'writing' + (isCode(doc) ? ' iscode' : '')} autoFocus />
  </div>;
}

function Viewer({ doc }) {
  return <div className={'pt5' + (isCode(doc) ? ' iscode' : '')}>
    <h1>{doc.title || doc.uuid}</h1>
    {isCode(doc) ? <pre>{doc.markdown}</pre> : <div dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.markdown) }} />}
  </div>;
}

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { mode, doc, docs, showSearchBar, searchText, searchedText } = state;
  const chrome = navigator.userAgent.toLowerCase().includes('chrome');
  useEffect(() => { store.initialize().catch(store.report); }, []);
  useEffect(() => {
    if (!showSearchBar) return;
    const timer = setTimeout(() => store.set({ mode: searchText.trim() ? 'search' : 'list', searchedText: searchText }), 500);
    return () => clearTimeout(timer);
  }, [searchText, showSearchBar]);
  return <>
    {state.showCheck && <div className="checkmark" role="status" aria-label="Saved"><CircleCheck size={24} strokeWidth={2} /></div>}
    <Toolbar state={state} chrome={chrome} />
    <InlineFeedback confirmation={state.confirmation} notice={state.notice} />
    {showSearchBar && <p><input id="searchbar" autoComplete="off" value={searchText} placeholder="Search..." aria-label="Search notes"
      onChange={event => store.set({ searchText: event.target.value })} style={{ width: '100%' }} autoFocus /></p>}
    {mode === 'search' && <SearchResults docs={docs} text={searchedText} />}
    {mode === 'list' && <><div><p className="small">Welcome, {state.username} ({getHash(store.password)}).</p></div>
      <div className="list">{sortedDocuments(docs).map(doc => <NoteRow key={doc.uuid} doc={doc} />)}</div></>}
    {mode === 'intro' && (state.needsUnlock ? <div>
      <p>Welcome back, {state.loginUser}.</p>
      <p>Enter your password above to unlock your notes, or use a different username to sign in.</p>
    </div> : <Introduction chrome={chrome} hasData={state.hasData} />)}
    {mode === 'view' && doc && <Viewer doc={doc} />}
    {mode === 'edit' && doc && <Editor doc={doc} />}
  </>;
}
