import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  Code2,
  Cloud,
  CloudOff,
  Download,
  Eye,
  FileJson,
  FileLock2,
  FilePlus2,
  FileText,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import MiniSearch from 'minisearch'
import { z } from 'zod'
import { trackEvent, trackPageView } from './lib/analytics'
import { clearKeys, decryptNote, deriveKeys, encryptNote, randomSalt, workspaceID } from './lib/crypto'
import { acknowledgeDocument, clearLogin, documentKey, getAccount, getLogin, listDocuments, notebookDB, queueDocument, reconcileDocument, saveAccount, saveLogin, type DocumentSource } from './lib/db'
import { toBase64 } from './lib/encoding'
import { decryptLegacyWorkspace, legacyWorkspaceID, parseLegacyWorkspace } from './lib/legacy'
import { SyncClient } from './lib/sync'
import { useUI } from './store'
import type { ContentMode, KdfMetadata, NoteContent, Publication, SessionKeys, StoredDocument, WireDocument } from './types'

interface OpenNote { note: NoteContent; stored: StoredDocument }
interface Session { username: string; metadata: KdfMetadata; keys: SessionKeys }
type SaveState = 'saved-offline' | 'synced'
type ConnectionState = 'connecting' | 'online' | 'offline'

const usernameSchema = z.string().max(200).refine((value) => value.trim().length > 0, 'Enter your notebook name.')
const credentialSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.'),
})

const defaultKdf = { kdf_version: 1, kdf_memory: 65_536, kdf_iterations: 3, kdf_parallelism: 1 }
const MarkdownEditor = lazy(() => import('./editor/MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })))

interface LegacyPromotion {
  metadata: KdfMetadata
  keys: SessionKeys
  documents: WireDocument[]
  promoted: boolean
}

async function promoteLegacyWorkspace(username: string, password: string, workspaceId: string): Promise<LegacyPromotion | null> {
  const legacyId = legacyWorkspaceID(username)
  const legacyResponse = await fetch(`/api/v1/legacy/workspaces/${legacyId}`, { headers: { Accept: 'application/json' } })
  if (legacyResponse.status === 404) return null
  if (!legacyResponse.ok) throw new Error('The server could not load this legacy notebook.')
  const staged = parseLegacyWorkspace(await legacyResponse.json())
  if (staged.legacy_id !== legacyId) throw new Error('The server returned the wrong legacy notebook.')
  const notes = decryptLegacyWorkspace(staged, password)
  const metadata: KdfMetadata = { id: workspaceId, ...defaultKdf, kdf_salt: toBase64(randomSalt()), auth_public_key: '' }
  let keys = await deriveKeys(password, metadata)
  metadata.auth_public_key = toBase64(keys.authPublicKey)
  const timestamp = new Date().toISOString()
  const documents: WireDocument[] = notes.map((note) => {
    const encrypted = encryptNote(note, workspaceId, keys.contentKey)
    return { document_id: note.id, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash, revision: 1, deleted: false, updated_at: timestamp }
  })
  let promotionResponse: Response
  try {
    promotionResponse = await fetch(`/api/v1/legacy/workspaces/${legacyId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, workspace: metadata, documents }),
    })
  } catch (caught) {
    clearKeys(keys)
    throw new Error('The legacy notebook could not be migrated.', { cause: caught })
  }
  if (promotionResponse.status === 409) {
    clearKeys(keys)
    const currentResponse = await fetch(`/api/v1/workspaces/${workspaceId}`, { headers: { Accept: 'application/json' } })
    if (!currentResponse.ok) throw new Error('This legacy notebook was already migrated with different credentials.')
    const current = await currentResponse.json() as KdfMetadata
    keys = await deriveKeys(password, current)
    if (toBase64(keys.authPublicKey) !== current.auth_public_key) {
      clearKeys(keys)
      throw new Error('This legacy notebook was already migrated with different credentials.')
    }
    return { metadata: current, keys, documents: [], promoted: false }
  }
  if (!promotionResponse.ok) {
    clearKeys(keys)
    throw new Error('The legacy notebook could not be migrated.')
  }
  return { metadata, keys, documents, promoted: true }
}

function storedFromWire(workspaceId: string, document: WireDocument): StoredDocument {
  return {
    key: documentKey(workspaceId, document.document_id),
    workspaceId,
    documentId: document.document_id,
    ciphertext: document.ciphertext,
    ciphertextHash: document.ciphertext_hash,
    revision: document.revision,
    deleted: document.deleted,
    updatedAt: document.updated_at,
    pending: false,
  }
}

function dateLabel(value: string): string {
  const date = new Date(value)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function download(name: string, data: unknown): void {
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(href)
}

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { sidebarOpen, setSidebarOpen, sidebarCollapsed, setSidebarCollapsed, theme, setTheme, markdownEditorMode, setMarkdownEditorMode, toast, showToast } = useUI()
  const [session, setSession] = useState<Session | null>(null)
  const [notes, setNotes] = useState<OpenNote[]>([])
  const notesRef = useRef<OpenNote[]>([])
  const [selectedID, setSelectedID] = useState('')
  const [connection, setConnection] = useState<ConnectionState>('offline')
  const [saveState, setSaveState] = useState<SaveState>('saved-offline')
  const [publications, setPublications] = useState<Record<string, Publication>>({})
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rotationOpen, setRotationOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoringLogin, setRestoringLogin] = useState(true)
  const [error, setError] = useState('')
  const syncRef = useRef<SyncClient | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const dirtyNotes = useRef(new Map<string, NoteContent>())
  const dirtyHashes = useRef(new Map<string, string>())
  const dirtyDocuments = useRef(new Map<string, StoredDocument>())
  const documentOperations = useRef(new Map<string, Promise<unknown>>())
  const pendingPublicationAnalytics = useRef(new Map<string, 'create' | 'update'>())
  const pendingUnpublicationAnalytics = useRef(new Set<string>())
  const trackedLocation = useRef('')
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const initialPath = useRef(location.pathname)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const navigation = `${location.key}:${location.pathname}`
    if (trackedLocation.current === navigation) return
    trackedLocation.current = navigation
    trackPageView(location.pathname)
  }, [location.key, location.pathname])
  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => () => {
    syncRef.current?.close()
    clearKeys(sessionRef.current?.keys ?? null)
  }, [])
  useEffect(() => {
    if (!session) return
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newNote()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSidebarOpen(true)
        window.setTimeout(() => searchInput.current?.focus(), 0)
      }
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
    // The handler reads mutable note/sync refs; only a session transition changes its authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const refreshLocal = useCallback(async (active: Session) => {
    const stored = await listDocuments(active.metadata.id)
    const opened: OpenNote[] = []
    for (const item of stored) {
      if (item.deleted) continue
      try {
        const decrypted = decryptNote(item.ciphertext, active.metadata.id, item.documentId, active.keys.contentKey)
        opened.push({ note: dirtyNotes.current.get(item.documentId) ?? decrypted, stored: item })
      } catch {
        throw new Error('A local note could not be decrypted. Restore a valid encrypted backup before continuing.')
      }
    }
    opened.sort((a, b) => b.note.updated_at.localeCompare(a.note.updated_at))
    setNotes(opened)
    notesRef.current = opened
    return opened
  }, [])

  const runDocumentOperation = useCallback(<T,>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = documentOperations.current.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    documentOperations.current.set(key, current)
    const clear = () => {
      if (documentOperations.current.get(key) === current) documentOperations.current.delete(key)
    }
    void current.then(clear, clear)
    return current
  }, [])

  const persistNote = useCallback(async (active: Session, open: OpenNote) => {
    await runDocumentOperation(open.stored.key, async () => {
      const encrypted = encryptNote(open.note, active.metadata.id, active.keys.contentKey)
      const stored: StoredDocument = {
        ...open.stored,
        ciphertext: encrypted.ciphertext,
        ciphertextHash: encrypted.hash,
        deleted: false,
        pending: true,
        updatedAt: open.note.updated_at,
      }
      await queueDocument(stored, 'upsert')
      const persisted = await notebookDB.documents.get(stored.key) ?? stored
      if (dirtyNotes.current.get(open.note.id) === open.note) {
        dirtyHashes.current.set(open.note.id, encrypted.hash)
        dirtyDocuments.current.set(open.note.id, persisted)
      }
      setNotes((current) => {
        const updated = current.map((item) => item.note.id === open.note.id ? { note: dirtyNotes.current.get(open.note.id) ?? item.note, stored: persisted } : item)
        notesRef.current = updated
        return updated
      })
    })
    syncRef.current?.scheduleFlush()
  }, [runDocumentOperation])

  const createConflictCopy = useCallback((active: Session, local: StoredDocument): StoredDocument => {
    const old = decryptNote(local.ciphertext, active.metadata.id, local.documentId, active.keys.contentKey)
    const now = new Date().toISOString()
    const stableHash = local.ciphertextHash.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
    const copy: NoteContent = {
      ...old,
      id: `conflict-${stableHash}`,
      title: `${old.title || 'Untitled'} (conflict ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date())})`,
      created_at: now,
      updated_at: now,
    }
    const encrypted = encryptNote(copy, active.metadata.id, active.keys.contentKey)
    return {
      key: documentKey(active.metadata.id, copy.id), workspaceId: active.metadata.id, documentId: copy.id,
      ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: now,
    }
  }, [])

  const closeSession = useCallback((keys: SessionKeys | null, message = '') => {
    syncRef.current?.close()
    syncRef.current = null
    clearKeys(keys)
    dirtyNotes.current.clear()
    dirtyHashes.current.clear()
    dirtyDocuments.current.clear()
    pendingPublicationAnalytics.current.clear()
    pendingUnpublicationAnalytics.current.clear()
    notesRef.current = []
    setSession(null)
    setNotes([])
    setSelectedID('')
    setPublications({})
    setSearch('')
    setConnection('offline')
    setSaveState('saved-offline')
    setSettingsOpen(false)
    setError(message)
    navigate('/')
  }, [navigate])

  const connect = useCallback((active: Session) => {
    syncRef.current?.close()
    const acceptDocuments = async (documents: WireDocument[], source: DocumentSource) => {
      let shouldFlush = false
      for (const wire of documents) {
        const key = documentKey(active.metadata.id, wire.document_id)
        let dirtyNote: NoteContent | undefined
        const result = await runDocumentOperation(key, () => {
          dirtyNote = dirtyNotes.current.get(wire.document_id)
          const dirtyDocument = dirtyDocuments.current.get(wire.document_id)
          return reconcileDocument(
            storedFromWire(active.metadata.id, wire),
            source,
            (local) => createConflictCopy(active, local),
            dirtyDocument,
          )
        })
        if (result.kind === 'inconsistent') {
          setError('Synchronization stopped for a document because the server returned inconsistent encrypted data.')
          continue
        }
        if (result.kind === 'rebased' || result.kind === 'conflict-preserved') shouldFlush = true
        if (result.kind === 'accepted' || result.kind === 'conflict-preserved') {
          if (dirtyNotes.current.get(wire.document_id) === dirtyNote) {
            dirtyNotes.current.delete(wire.document_id)
            dirtyHashes.current.delete(wire.document_id)
            dirtyDocuments.current.delete(wire.document_id)
          }
        }
        if (result.kind === 'conflict-preserved' && result.conflictCreated) {
          showToast('A simultaneous edit was preserved as a conflict copy.')
        }
      }
      await refreshLocal(active)
      const queued = await notebookDB.outbox.where('workspaceId').equals(active.metadata.id).count()
      setSaveState(queued || dirtyHashes.current.size ? 'saved-offline' : 'synced')
      if (shouldFlush) await syncRef.current?.flush()
    }
    const client = new SyncClient(active.metadata, active.keys, {
      onStatus: (value) => {
        setConnection(value)
        if (value === 'online') {
          void notebookDB.outbox.where('workspaceId').equals(active.metadata.id).count().then((queued) => {
            setSaveState(queued || dirtyHashes.current.size ? 'saved-offline' : 'synced')
          })
        }
      },
      onInitial: async (documents, published) => {
        const publicationMap = Object.fromEntries(published.map((item) => [item.document_id, item]))
        setPublications(publicationMap)
        await acceptDocuments(documents, 'initial')
      },
      onDocuments: acceptDocuments,
      onPublication: (publication) => {
        const normalized = { ...publication, updated_at: publication.updated_at || new Date().toISOString() }
        setPublications((current) => ({ ...current, [publication.document_id]: normalized }))
        const variant = pendingPublicationAnalytics.current.get(publication.document_id)
        if (variant) {
          pendingPublicationAnalytics.current.delete(publication.document_id)
          trackEvent({ event: 'snapshot-publish', outcome: 'success', variant }, 'note')
        }
        showToast('Public snapshot updated.')
      },
      onUnpublication: (documentId) => {
        setPublications((current) => {
          const next = { ...current }; delete next[documentId]; return next
        })
        if (pendingUnpublicationAnalytics.current.delete(documentId)) {
          trackEvent({ event: 'snapshot-unpublish', outcome: 'success' }, 'note')
        }
      },
      onCredentialsRotated: async () => {
        await clearLogin().catch(() => undefined)
        closeSession(active.keys, 'The notebook password changed on another device. Open it with the new password.')
      },
      onError: (message) => {
        setError(message)
        for (const variant of pendingPublicationAnalytics.current.values()) {
          trackEvent({ event: 'snapshot-publish', outcome: 'error', variant, reason: 'server' }, 'note')
        }
        if (pendingUnpublicationAnalytics.current.size) {
          trackEvent({ event: 'snapshot-unpublish', outcome: 'error', reason: 'server' }, 'note')
        }
        pendingPublicationAnalytics.current.clear()
        pendingUnpublicationAnalytics.current.clear()
      },
    })
    syncRef.current = client
    client.connect()
  }, [closeSession, createConflictCopy, refreshLocal, runDocumentOperation, showToast])

  useEffect(() => {
    let cancelled = false
    let restoredKeys: SessionKeys | null = null
    const restore = async () => {
      try {
        const saved = await getLogin()
        if (!saved || cancelled) return
        restoredKeys = saved.keys
        if (saved.keys.contentKey.byteLength !== 32 || saved.keys.authSeed.byteLength !== 32 || saved.keys.authPublicKey.byteLength !== 32) {
          throw new Error('The saved login is damaged.')
        }
        let metadata = saved.metadata
        let response: Response | undefined
        if (navigator.onLine) {
          try {
            response = await fetch(`/api/v1/workspaces/${metadata.id}`, { headers: { Accept: 'application/json' } })
          } catch {
            // A saved login remains usable with locally cached encrypted notes while offline.
          }
        }
        if (response?.status === 404) throw new Error('The saved notebook no longer exists on this server.')
        if (response?.ok) metadata = await response.json() as KdfMetadata
        if (metadata.id !== saved.metadata.id || toBase64(saved.keys.authPublicKey) !== metadata.auth_public_key) {
          throw new Error('The notebook password changed since this browser last connected.')
        }
        const active: Session = { username: saved.username, metadata, keys: saved.keys }
        await saveAccount({ ...metadata, username: saved.username, updatedAt: new Date().toISOString() })
        await saveLogin(active)
        const local = await refreshLocal(active)
        if (cancelled) {
          clearKeys(active.keys)
          return
        }
        setSession(active)
        connect(active)
        const routeID = initialPath.current.match(/^\/app\/notes\/([^/]+)$/u)?.[1]
        const first = local.find((item) => item.note.id === routeID)?.note.id ?? local[0]?.note.id
        if (first) { setSelectedID(first); navigate(`/app/notes/${first}`) } else navigate('/app')
      } catch (caught) {
        clearKeys(restoredKeys)
        await clearLogin().catch(() => undefined)
        if (!cancelled) setError(caught instanceof Error ? `${caught.message} Log in again.` : 'The saved login could not be restored. Log in again.')
      } finally {
        if (!cancelled) setRestoringLogin(false)
      }
    }
    void restore()
    return () => { cancelled = true }
    // Saved-login restoration is a one-time mount concern. Route changes must never
    // restart it, or an in-flight restore could recreate a login after logout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function authenticate(username: string, password: string): Promise<void> {
    setBusy(true)
    setError('')
    let authEvent: 'notebook-create' | 'notebook-unlock' = 'notebook-unlock'
    let createFailure: 'validation' | 'already-exists' | 'server' | 'crypto' | 'unknown' = 'validation'
    let unlockFailure: 'validation' | 'not-found' | 'incorrect-password' | 'offline-unavailable' | 'server' | 'crypto' | 'unknown' = 'validation'
    try {
      const parsed = credentialSchema.parse({ username, password })
      const id = workspaceID(parsed.username)
      let metadata: KdfMetadata
      let keys: SessionKeys
      let migratedDocuments: WireDocument[] = []
      let promoted = false
      let response: Response | undefined
      let requestError: unknown
      unlockFailure = 'server'
      try {
        response = await fetch(`/api/v1/workspaces/${id}`, { headers: { Accept: 'application/json' } })
      } catch (caught) {
        requestError = caught
      }
      if (!response) {
        unlockFailure = 'offline-unavailable'
        const cached = await getAccount(id)
        if (!cached) throw new Error('You are offline and this notebook has not been opened on this device.', { cause: requestError })
        metadata = cached
        unlockFailure = 'crypto'
        keys = await deriveKeys(parsed.password, metadata)
      } else if (response.status === 404) {
        unlockFailure = 'crypto'
        const migration = await promoteLegacyWorkspace(parsed.username, parsed.password, id)
        if (migration) {
          metadata = migration.metadata
          keys = migration.keys
          migratedDocuments = migration.documents
          promoted = migration.promoted
        } else {
          authEvent = 'notebook-create'
          createFailure = 'crypto'
          metadata = { id, ...defaultKdf, kdf_salt: toBase64(randomSalt()), auth_public_key: '' }
          keys = await deriveKeys(parsed.password, metadata)
          metadata.auth_public_key = toBase64(keys.authPublicKey)
          createFailure = 'server'
          let createResponse: Response
          try {
            createResponse = await fetch('/api/v1/workspaces', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
            })
          } catch (caught) {
            clearKeys(keys)
            throw new Error('The notebook could not be created.', { cause: caught })
          }
          if (createResponse.status === 409) {
            clearKeys(keys)
            authEvent = 'notebook-unlock'
            unlockFailure = 'server'
            const currentResponse = await fetch(`/api/v1/workspaces/${id}`, { headers: { Accept: 'application/json' } })
            if (!currentResponse.ok) throw new Error('The server could not load this notebook.')
            metadata = await currentResponse.json() as KdfMetadata
            unlockFailure = 'crypto'
            keys = await deriveKeys(parsed.password, metadata)
          } else if (!createResponse.ok) {
            clearKeys(keys)
            throw new Error('The notebook could not be created.')
          }
        }
      } else {
        if (!response.ok) throw new Error('The server could not load this notebook.')
        metadata = await response.json() as KdfMetadata
        unlockFailure = 'crypto'
        keys = await deriveKeys(parsed.password, metadata)
      }
      if (toBase64(keys.authPublicKey) !== metadata.auth_public_key) {
        clearKeys(keys)
        if (authEvent === 'notebook-create') createFailure = 'crypto'
        else unlockFailure = 'incorrect-password'
        throw new Error('The password is incorrect.')
      }
      const active = { username: parsed.username, metadata, keys }
      if (authEvent === 'notebook-create') createFailure = 'unknown'
      else unlockFailure = 'unknown'
      await saveAccount({ ...metadata, username: parsed.username, updatedAt: new Date().toISOString() })
      await saveLogin(active)
      for (const document of migratedDocuments) await acknowledgeDocument(storedFromWire(metadata.id, document))
      setSession(active)
      const local = await refreshLocal(active)
      connect(active)
      const routeID = location.pathname.match(/^\/app\/notes\/([^/]+)$/u)?.[1]
      const first = local.find((item) => item.note.id === routeID)?.note.id ?? local[0]?.note.id
      if (first) { setSelectedID(first); navigate(`/app/notes/${first}`) } else navigate('/app')
      if (promoted) showToast(`Migrated ${migratedDocuments.length} legacy note${migratedDocuments.length === 1 ? '' : 's'}.`)
      if (authEvent === 'notebook-create') trackEvent({ event: 'notebook-create', outcome: 'success' }, 'landing')
      else trackEvent({ event: 'notebook-unlock', outcome: 'success' }, 'landing')
    } catch (caught) {
      if (caught instanceof z.ZodError) {
        createFailure = 'validation'
        unlockFailure = 'validation'
        setError(caught.issues[0]?.message ?? 'Check the notebook name and password.')
      } else {
        const message = caught instanceof Error ? caught.message : 'Opening the notebook failed.'
        if (authEvent === 'notebook-unlock' && (message === 'The password is incorrect.' || message.includes('different credentials'))) unlockFailure = 'incorrect-password'
        if (authEvent === 'notebook-unlock' && message.includes('server could not load')) unlockFailure = 'server'
        setError(message)
      }
      if (authEvent === 'notebook-create') trackEvent({ event: 'notebook-create', outcome: 'error', reason: createFailure }, 'landing')
      else trackEvent({ event: 'notebook-unlock', outcome: 'error', reason: unlockFailure }, 'landing')
    } finally {
      setBusy(false)
    }
  }

  function editNote(patch: Partial<Pick<NoteContent, 'title' | 'content' | 'mode'>>): void {
    if (!session || !selectedID) return
    const current = notesRef.current.find((item) => item.note.id === selectedID)
    if (!current) return
    const changed: OpenNote = { ...current, note: { ...(dirtyNotes.current.get(selectedID) ?? current.note), ...patch, updated_at: new Date().toISOString() } }
    dirtyNotes.current.set(selectedID, changed.note)
    setSaveState('saved-offline')
    const updated = notesRef.current.map((item) => item.note.id === selectedID ? changed : item)
    notesRef.current = updated
    setNotes(updated)
    void persistNote(session, changed)
  }

  async function newNote(): Promise<void> {
    if (!session) return
    let failureReason: 'local-storage' | 'unknown' = 'unknown'
    try {
      setSaveState('saved-offline')
      const now = new Date().toISOString()
      const note: NoteContent = { id: crypto.randomUUID(), title: '', content: '', mode: 'markdown', created_at: now, updated_at: now }
      const encrypted = encryptNote(note, session.metadata.id, session.keys.contentKey)
      const stored: StoredDocument = {
        key: documentKey(session.metadata.id, note.id), workspaceId: session.metadata.id, documentId: note.id,
        ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: now,
      }
      failureReason = 'local-storage'
      await queueDocument(stored, 'upsert')
      trackEvent({ event: 'note-create', outcome: 'success' }, 'note')
      const updated = [{ note, stored }, ...notesRef.current]
      notesRef.current = updated
      setNotes(updated)
      setSelectedID(note.id)
      setSidebarOpen(false)
      navigate(`/app/notes/${note.id}`)
      await syncRef.current?.flush()
    } catch {
      trackEvent({ event: 'note-create', outcome: 'error', reason: failureReason }, 'note')
      setError('The note could not be created.')
    }
  }

  async function deleteNote(): Promise<void> {
    if (!session || !selectedID || !window.confirm('Permanently delete this note from every synced device?')) return
    const open = notesRef.current.find((item) => item.note.id === selectedID)
    if (!open) return
    try {
      setSaveState('saved-offline')
      await runDocumentOperation(open.stored.key, async () => {
        const latest = await notebookDB.documents.get(open.stored.key) ?? open.stored
        await queueDocument({ ...latest, ciphertext: '', ciphertextHash: '', deleted: true, pending: true, updatedAt: new Date().toISOString() }, 'delete')
      })
      trackEvent({ event: 'note-delete', outcome: 'success' }, 'note')
      dirtyNotes.current.delete(selectedID)
      dirtyHashes.current.delete(selectedID)
      dirtyDocuments.current.delete(selectedID)
      const updated = notesRef.current.filter((item) => item.note.id !== selectedID)
      notesRef.current = updated
      setNotes(updated)
      const next = notesRef.current.find((item) => item.note.id !== selectedID)?.note.id ?? ''
      setSelectedID(next)
      navigate(next ? `/app/notes/${next}` : '/app')
      await syncRef.current?.flush()
    } catch {
      trackEvent({ event: 'note-delete', outcome: 'error', reason: 'local-storage' }, 'note')
      setError('The note could not be deleted.')
    }
  }

  function selectNote(id: string): void {
    setSelectedID(id)
    setSidebarOpen(false)
    navigate(`/app/notes/${id}`)
  }

  function publish(): void {
    const open = notes.find((item) => item.note.id === selectedID)
    const variant = open && publications[open.note.id] ? 'update' : 'create'
    if (!open || connection !== 'online') {
      trackEvent({ event: 'snapshot-publish', outcome: 'error', variant, reason: 'offline-unavailable' }, 'note')
      showToast('Connect to the server before publishing.')
      return
    }
    if (!window.confirm('Publish a read-only snapshot? Anyone with its link can read this content.')) return
    pendingPublicationAnalytics.current.set(open.note.id, variant)
    if (!syncRef.current?.publish(open.note.id, open.note.title || 'Untitled note', open.note.content, open.note.mode, publications[open.note.id]?.public_id)) {
      pendingPublicationAnalytics.current.delete(open.note.id)
      trackEvent({ event: 'snapshot-publish', outcome: 'error', variant, reason: 'server' }, 'note')
    }
  }

  function unpublish(): void {
    if (!selectedID || !window.confirm('Remove this public snapshot?')) return
    if (connection !== 'online') {
      trackEvent({ event: 'snapshot-unpublish', outcome: 'error', reason: 'offline-unavailable' }, 'note')
      showToast('Connect to the server before removing the public snapshot.')
      return
    }
    pendingUnpublicationAnalytics.current.add(selectedID)
    if (!syncRef.current?.unpublish(selectedID)) {
      pendingUnpublicationAnalytics.current.delete(selectedID)
      trackEvent({ event: 'snapshot-unpublish', outcome: 'error', reason: 'server' }, 'note')
    }
  }

  function exportEncrypted(): void {
    if (!session) return
    void listDocuments(session.metadata.id).then((documents) => {
      download(`offlinenotepad-${new Date().toISOString().slice(0, 10)}.onp.json`, {
        format: 'offlinenotepad-encrypted-archive', version: 2, exported_at: new Date().toISOString(), workspace: session.metadata, documents,
      })
      trackEvent({ event: 'archive-export', outcome: 'success', variant: 'encrypted' }, selectedID ? 'note' : 'notebook')
    }).catch(() => {
      trackEvent({ event: 'archive-export', outcome: 'error', variant: 'encrypted', reason: 'local-storage' }, selectedID ? 'note' : 'notebook')
      setError('The encrypted archive could not be exported.')
    })
  }

  function exportPlaintext(): void {
    if (!window.confirm('Plaintext export removes encryption. Store the downloaded file somewhere private. Continue?')) return
    try {
      download(`offlinenotepad-plaintext-${new Date().toISOString().slice(0, 10)}.json`, {
        format: 'offlinenotepad-plaintext', version: 2, exported_at: new Date().toISOString(), notes: notes.map(({ note }) => note),
      })
      trackEvent({ event: 'archive-export', outcome: 'success', variant: 'plaintext' }, selectedID ? 'note' : 'notebook')
    } catch {
      trackEvent({ event: 'archive-export', outcome: 'error', variant: 'plaintext', reason: 'unknown' }, selectedID ? 'note' : 'notebook')
      setError('The plaintext export could not be created.')
    }
  }

  async function importFile(file: File): Promise<void> {
    if (!session) return
    let variant: 'encrypted' | 'plaintext' | 'legacy' = 'legacy'
    let failureReason: 'validation' | 'crypto' | 'local-storage' | 'unknown' = 'validation'
    try {
      const value = JSON.parse(await file.text()) as unknown
      let imported: NoteContent[] = []
      if (typeof value === 'object' && value && 'format' in value && (value as { format: string }).format === 'offlinenotepad-encrypted-archive') {
        variant = 'encrypted'
        const archive = value as unknown as { workspace: KdfMetadata; documents: StoredDocument[] }
        if (archive.workspace.id !== session.metadata.id) throw new Error('This encrypted archive belongs to a different notebook.')
        failureReason = 'crypto'
        imported = archive.documents.filter((item) => !item.deleted).map((item) => decryptNote(item.ciphertext, session.metadata.id, item.documentId, session.keys.contentKey))
      } else {
        if (typeof value === 'object' && value && 'format' in value && (value as { format: string }).format === 'offlinenotepad-plaintext') variant = 'plaintext'
        const root = value as { notes?: unknown[] }
        const candidates = Array.isArray(value) ? value : Array.isArray(root?.notes) ? root.notes : Object.values(value as Record<string, unknown>)
        imported = candidates.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')).map((item) => {
          const now = new Date().toISOString()
          const title = String(item.title ?? item.name ?? '')
          return {
            id: crypto.randomUUID(), title, content: String(item.content ?? item.markdown ?? ''),
            mode: item.mode === 'plaintext' || (item.mode == null && title.includes('.')) ? 'plaintext' : 'markdown',
            created_at: String(item.created_at ?? item.created ?? now), updated_at: now,
          }
        })
      }
      failureReason = 'local-storage'
      if (imported.length) setSaveState('saved-offline')
      for (const old of imported) {
        const now = new Date().toISOString()
        const note = { ...old, id: crypto.randomUUID(), updated_at: now }
        const encrypted = encryptNote(note, session.metadata.id, session.keys.contentKey)
        await queueDocument({ key: documentKey(session.metadata.id, note.id), workspaceId: session.metadata.id, documentId: note.id, ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: now }, 'upsert')
      }
      await refreshLocal(session)
      await syncRef.current?.flush()
      trackEvent({ event: 'archive-import', outcome: 'success', variant }, selectedID ? 'note' : 'notebook')
      showToast(`Imported ${imported.length} note${imported.length === 1 ? '' : 's'}.`)
    } catch (caught) {
      trackEvent({ event: 'archive-import', outcome: 'error', variant, reason: failureReason }, selectedID ? 'note' : 'notebook')
      setError(caught instanceof Error ? caught.message : 'The selected file could not be imported.')
    }
  }

  async function rotatePassword(password: string): Promise<void> {
    if (!session) return
    setBusy(true); setError('')
    let failureReason: 'offline-unavailable' | 'validation' | 'server' | 'crypto' | 'local-storage' | 'unknown' = 'offline-unavailable'
    try {
      if (connection !== 'online' || saveState !== 'synced' || await notebookDB.outbox.where('workspaceId').equals(session.metadata.id).count()) {
        throw new Error('Wait for all notes to sync before changing the password.')
      }
      failureReason = 'validation'
      credentialSchema.shape.password.parse(password)
      const metadata: KdfMetadata = { ...session.metadata, ...defaultKdf, kdf_salt: toBase64(randomSalt()), auth_public_key: '' }
      failureReason = 'crypto'
      const keys = await deriveKeys(password, metadata)
      metadata.auth_public_key = toBase64(keys.authPublicKey)
      const rotation = notes.map(({ note, stored }) => {
        const encrypted = encryptNote(note, metadata.id, keys.contentKey)
        return { document_id: note.id, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash, revision: stored.revision }
      })
      const synchronizer = syncRef.current
      if (!synchronizer) throw new Error('Password rotation requires an online connection.')
      failureReason = 'server'
      await synchronizer.rotate({ type: 'rotate-credentials', kdf_salt: metadata.kdf_salt, kdf_memory: metadata.kdf_memory, kdf_iterations: metadata.kdf_iterations, kdf_parallelism: metadata.kdf_parallelism, auth_public_key: metadata.auth_public_key, rotation_documents: rotation })
      failureReason = 'local-storage'
      const active = { ...session, metadata, keys }
      await notebookDB.transaction('rw', notebookDB.accounts, notebookDB.documents, notebookDB.outbox, notebookDB.logins, async () => {
        await saveAccount({ ...metadata, username: session.username, updatedAt: new Date().toISOString() })
        await saveLogin(active)
        for (const item of rotation) {
          const current = await notebookDB.documents.get(documentKey(metadata.id, item.document_id))
          if (current) await notebookDB.documents.put({ ...current, ciphertext: item.ciphertext, ciphertextHash: item.ciphertext_hash, revision: current.revision + 1, pending: false })
        }
        await notebookDB.outbox.where('workspaceId').equals(metadata.id).delete()
      })
      clearKeys(session.keys)
      setSession(active)
      await refreshLocal(active)
      connect(active)
      setRotationOpen(false)
      trackEvent({ event: 'password-rotate', outcome: 'success' }, selectedID ? 'note' : 'notebook')
      showToast('Password changed. Other devices must open the notebook again.')
    } catch (caught) {
      clearKeys(null)
      trackEvent({ event: 'password-rotate', outcome: 'error', reason: failureReason }, selectedID ? 'note' : 'notebook')
      setError(caught instanceof Error ? caught.message : 'Password rotation failed.')
    }
    finally { setBusy(false) }
  }

  async function logout(): Promise<void> {
    try {
      await clearLogin()
      closeSession(session?.keys ?? null)
    } catch {
      setError('The saved login could not be removed from this browser.')
    }
  }

  const miniSearch = useMemo(() => {
    const index = new MiniSearch<{ id: string; title: string; content: string }>({ fields: ['title', 'content'], storeFields: ['title'] })
    index.addAll(notes.map(({ note }) => ({ id: note.id, title: note.title, content: note.content })))
    return index
  }, [notes])
  const filteredNotes = useMemo(() => {
    if (!search.trim()) return notes
    const ids = new Set(miniSearch.search(search, { prefix: true, fuzzy: 0.2 }).map((result) => result.id))
    return notes.filter((item) => ids.has(item.note.id))
  }, [miniSearch, notes, search])
  const selected = notes.find((item) => item.note.id === selectedID)
  const selectedPublication = selected ? publications[selected.note.id] : undefined
  const publicationOutdated = Boolean(selected && selectedPublication && new Date(selected.note.updated_at).getTime() > new Date(selectedPublication.updated_at).getTime())

  if (!session) return <Welcome restoring={restoringLogin} busy={busy} error={error} onAuthenticate={authenticate} />

  return (
    <div className={`notebook ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Notes">
        <div className="sidebar-top">
          <a className="brand compact" href="/app" onClick={(event) => { event.preventDefault(); navigate('/app') }}><span className="brand-mark"><NotebookPen aria-hidden="true" /></span><span>Offline Notepad</span></a>
          <button className="icon-button desktop-collapse" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close notes"><X /></button>
        </div>
        <button className="new-note" onClick={() => void newNote()} aria-label="New note" title="New note"><FilePlus2 /> <span>New note</span><kbd>⌘ N</kbd></button>
        <label className="search-box"><Search /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" aria-label="Search notes" /></label>
        <div className="note-list">
          {filteredNotes.map(({ note, stored }) => (
            <button className={`note-row ${note.id === selectedID ? 'selected' : ''}`} key={note.id} onClick={() => selectNote(note.id)}>
              <span className="note-title">{note.title || 'Untitled note'}</span>
              <span className="note-excerpt">{note.content.replace(/[#>*_`\n]/gu, ' ').trim() || 'Empty note'}</span>
              <span className="note-meta">{stored.pending ? <CloudOff aria-label="Pending synchronization" /> : <Cloud aria-label="Synchronized" />} {dateLabel(note.updated_at)}</span>
            </button>
          ))}
          {!filteredNotes.length && <div className="empty-list"><FileText /><span>{search ? 'No matching notes' : 'Your notes will appear here'}</span></div>}
        </div>
        <div className="sidebar-footer">
          <Connection status={connection} />
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings" title="Open settings"><Settings /></button>
        </div>
      </aside>
      {sidebarOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <main className="workspace">
        <header className="editor-toolbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open notes"><Menu /></button>
          <div className="save-indicator" aria-live="polite">
            {saveState === 'synced' && connection === 'online' ? <><Check /> Synced</> : <><CloudOff /> Saved offline</>}
          </div>
          <div className="toolbar-actions">
            {selected?.note.mode === 'markdown' && <div className="mode-switch" aria-label="Markdown editor view"><button className={markdownEditorMode === 'live' ? 'active' : ''} aria-pressed={markdownEditorMode === 'live'} onClick={() => setMarkdownEditorMode('live')}><Eye /> Live</button><button className={markdownEditorMode === 'source' ? 'active' : ''} aria-pressed={markdownEditorMode === 'source'} onClick={() => setMarkdownEditorMode('source')}><Code2 /> Source</button></div>}
            <button className="button secondary publish-button" onClick={publish} disabled={!selected}><Share2 /> {selectedPublication ? 'Update snapshot' : 'Publish'}</button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="More options"><MoreHorizontal /></button>
          </div>
        </header>
        {selected ? (
          <section className="editor-shell">
            <input className="title-input" value={selected.note.title} onChange={(event) => editNote({ title: event.target.value })} placeholder="Untitled note" aria-label="Note title" />
            <div className="editor-details">
              <span>{selected.note.mode === 'markdown' ? 'Markdown' : 'Plain text'}</span><span>Edited {dateLabel(selected.note.updated_at)}</span>
              {selectedPublication && <a href={`/p/${selectedPublication.public_id}`} target="_blank" rel="noreferrer">Public snapshot ↗</a>}
              {publicationOutdated && <span className="outdated">Snapshot outdated</span>}
            </div>
            {selected.note.mode === 'markdown' ? (
              <Suspense fallback={<div className="editor-loading" role="status">Loading editor…</div>}><MarkdownEditor key={selected.note.id} documentId={selected.note.id} value={selected.note.content} mode={markdownEditorMode} onChange={(content) => editNote({ content })} /></Suspense>
            ) : (
              <textarea className="content-editor" value={selected.note.content} onChange={(event) => editNote({ content: event.target.value })} placeholder="Start writing…" aria-label="Note content" spellCheck />
            )}
          </section>
        ) : (
          <section className="empty-editor"><div className="empty-art"><Sparkles /></div><p className="eyebrow">Your private workspace</p><h1>Capture what matters.</h1><p>Notes are encrypted in this browser, saved locally first, and synchronized whenever you’re connected.</p><button className="button primary" onClick={() => void newNote()}><FilePlus2 /> Create your first note</button></section>
        )}
      </main>

      {settingsOpen && <SettingsPanel
        theme={theme} mode={selected?.note.mode} publication={selected ? publications[selected.note.id] : undefined}
        onClose={() => setSettingsOpen(false)} onTheme={setTheme} onMode={(mode) => editNote({ mode })}
        onEncryptedExport={exportEncrypted} onPlaintextExport={exportPlaintext} onImport={() => fileInput.current?.click()}
        onRotate={() => setRotationOpen(true)} onDelete={() => void deleteNote()} onUnpublish={unpublish} onLogout={() => void logout()}
      />}
      <input ref={fileInput} hidden type="file" accept=".json,.onp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
      {rotationOpen && <PasswordDialog busy={busy} error={error} onClose={() => { setRotationOpen(false); setError('') }} onSubmit={(password) => void rotatePassword(password)} />}
      {toast && <div className="toast" role="status"><Check />{toast}</div>}
      {error && session && !rotationOpen && <div className="error-toast" role="alert"><X />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X /></button></div>}
    </div>
  )
}

function Welcome({ restoring, busy, error, onAuthenticate }: { restoring: boolean; busy: boolean; error: string; onAuthenticate: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); void onAuthenticate(username, password) }
  return <main className="welcome">
    <div className="welcome-shell">
      <nav className="welcome-nav"><a className="brand" href="/"><span className="brand-mark"><NotebookPen aria-hidden="true" /></span><span>Offline Notepad</span></a></nav>
      <section className="auth-section" aria-labelledby="notebook-access-title">
        <div className="auth-heading">
          <h1 id="notebook-access-title">Sign in or create a notebook</h1>
          <p className="auth-intro">Enter a notebook name and password. Existing details sign you in; new details create a private notebook.</p>
        </div>
        {restoring ? <div className="auth-restoring" role="status"><span className="spinner" /><span>Opening your saved notebook…</span></div> : <>
          <form onSubmit={submit}>
            <div className="auth-fields">
              <label>Notebook name<input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="e.g. north-star" /></label>
              <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" /></label>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button primary auth-submit" disabled={busy}>{busy ? <span className="spinner" /> : <LockKeyhole />}{busy ? 'Deriving encryption keys…' : 'Sign in or create notebook'}</button>
          </form>
          <p className="no-recovery"><ShieldCheck /> Your password never leaves this browser. There is no recovery.</p>
        </>}
      </section>
      <section className="welcome-details" aria-label="About Offline Notepad">
        <p>Write, edit, search, and delete private notes without an internet connection. Changes are saved on this device first.</p>
        <p>Encrypted synchronization makes the same notebook available on your other devices without sending readable notes or your password to the server.</p>
      </section>
    </div>
  </main>
}

function Connection({ status }: { status: ConnectionState }) {
  const label = status === 'online' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Offline'
  return <span className={`connection ${status}`} aria-label={label} title={label}>{status === 'online' ? <Cloud /> : status === 'connecting' ? <span className="saving-dot" /> : <CloudOff />}<span>{label}</span></span>
}

function SettingsPanel(props: {
  theme: 'system' | 'light' | 'dark'; mode?: ContentMode; publication?: Publication; onClose: () => void; onTheme: (theme: 'system' | 'light' | 'dark') => void; onMode: (mode: ContentMode) => void;
  onEncryptedExport: () => void; onPlaintextExport: () => void; onImport: () => void; onRotate: () => void; onDelete: () => void; onUnpublish: () => void; onLogout: () => void
}) {
  return <div className="panel-layer"><button className="panel-scrim" onClick={props.onClose} aria-label="Close settings" /><aside className="settings-panel" aria-label="Notebook settings">
    <header><div><p className="eyebrow">Offline Notepad</p><h2>Settings</h2></div><button className="icon-button" onClick={props.onClose} aria-label="Close settings"><X /></button></header>
    <section><h3>Appearance</h3><div className="setting-segment"><button className={props.theme === 'system' ? 'active' : ''} onClick={() => props.onTheme('system')}><Settings /> System</button><button className={props.theme === 'light' ? 'active' : ''} onClick={() => props.onTheme('light')}><Sun /> Light</button><button className={props.theme === 'dark' ? 'active' : ''} onClick={() => props.onTheme('dark')}><Moon /> Dark</button></div></section>
    {props.mode && <section><h3>Current note</h3><button className="setting-row" onClick={() => props.onMode(props.mode === 'markdown' ? 'plaintext' : 'markdown')}><FileText /><span><strong>Format: {props.mode === 'markdown' ? 'Markdown' : 'Plain text'}</strong><small>Switch the canonical content mode</small></span><ChevronLeft className="chevron" /></button>{props.publication && <button className="setting-row" onClick={props.onUnpublish}><Share2 /><span><strong>Remove public snapshot</strong><small>The private note is unaffected</small></span></button>}<button className="setting-row danger" onClick={props.onDelete}><Trash2 /><span><strong>Delete note</strong><small>Permanent across synchronized devices</small></span></button></section>}
    <section><h3>Backup & transfer</h3><button className="setting-row" onClick={props.onEncryptedExport}><FileLock2 /><span><strong>Encrypted archive</strong><small>Recommended portable backup</small></span><Download /></button><button className="setting-row" onClick={props.onPlaintextExport}><FileJson /><span><strong>Plaintext JSON</strong><small>Warning: contains readable notes</small></span><Download /></button><button className="setting-row" onClick={props.onImport}><Upload /><span><strong>Import notes</strong><small>Archives and legacy JSON</small></span></button></section>
    <section><h3>Security</h3><button className="setting-row" onClick={props.onRotate}><KeyRound /><span><strong>Change password</strong><small>Re-encrypt every active note</small></span></button><button className="setting-row" onClick={props.onLogout}><LogOut /><span><strong>Log out</strong><small>Forget the saved login on this browser</small></span></button></section>
  </aside></div>
}

function PasswordDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('')
  return <div className="dialog-layer" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rotation-title"><button className="icon-button dialog-close" onClick={onClose} aria-label="Close"><X /></button><span className="dialog-icon"><KeyRound /></span><h2 id="rotation-title">Change your password</h2><p>Every active note will be re-encrypted in one atomic online operation. Other devices will be signed out.</p><label>New password<input type="password" autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy} onClick={() => onSubmit(password)}>{busy ? 'Re-encrypting…' : 'Change password'}</button></div></div></div>
}
