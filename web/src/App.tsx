import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  Code2,
  Cloud,
  CloudOff,
  Download,
  Eye,
  EyeClosed,
  Folder,
  FolderPlus,
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
import { z } from 'zod'
import { FileTree } from './components/FileTree'
import { PublishDialog } from './components/PublishDialog'
import { publicationURL } from './lib/publication'
import { EncryptionWorker } from './lib/encryption-worker'
import { LatestSaveQueue } from './lib/latest-save-queue'
import { useNoteSearch } from './lib/use-note-search'
import { useEvent } from './lib/use-event'
import { trackEvent, trackPageView } from './lib/analytics'
import { clearKeys, decryptRecord, deriveKeys, encryptNote, encryptRecord, randomSalt, workspaceID } from './lib/crypto'
import { acknowledgeDocument, clearLogin, documentKey, getAccount, getLogin, listDocuments, notebookDB, queueDocument as queueDocumentInDB, reconcileDocument, recoverUnreadableSyncedDocument, saveAccount, saveLogin, type DocumentSource } from './lib/db'
import { toBase64 } from './lib/encoding'
import { canMoveFolder, descendantFolderIds, flattenedFolders, folderNameError, folderPath } from './lib/folders'
import { decryptLegacyWorkspace, legacyWorkspaceID, parseLegacyWorkspace } from './lib/legacy'
import { isWorkspacePreferences, workspacePreferencesDocumentID } from './lib/preferences'
import { SyncClient } from './lib/sync'
import { useUI } from './store'
import type { ContentMode, FolderContent, KdfMetadata, NoteContent, PrivateRecord, Publication, PublicationRenderMode, SessionKeys, StoredDocument, WireDocument, WorkspacePreferences } from './types'

interface OpenNote { note: NoteContent; stored: StoredDocument }
interface OpenFolder { folder: FolderContent; stored: StoredDocument }
interface OpenWorkspacePreferences { preferences: WorkspacePreferences; stored: StoredDocument }
interface Session { username: string; metadata: KdfMetadata; keys: SessionKeys }
interface PendingRecord { active: Session; record: PrivateRecord; stored: StoredDocument }
type SaveState = 'saved-offline' | 'synced'
type ConnectionState = 'connecting' | 'online' | 'offline'
type FolderDialogState =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; folderId: string }
type MoveDialogState =
  | { kind: 'note' | 'folder'; id: string }
  | { kind: 'notes'; ids: string[] }

function isFolderRecord(record: PrivateRecord): record is FolderContent {
  return 'record_type' in record && record.record_type === 'folder'
}

function isNoteRecord(record: PrivateRecord): record is NoteContent {
  return !('record_type' in record)
}

const usernameSchema = z.string().max(200).refine((value) => value.trim().length > 0, 'Enter your notebook name.')
const credentialSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.'),
})

const defaultKdf = { kdf_version: 1, kdf_memory: 65_536, kdf_iterations: 3, kdf_parallelism: 1 }
const MarkdownEditor = lazy(() => import('./editor/MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })))
const otherTools = [
  { name: 'croc', description: 'fast, simple, secure file transfer', href: 'https://getcroc.com' },
  { name: 'wthrtxt', description: 'weather without clutter', href: 'https://wthrtxt.com' },
  { name: 'cowyo', description: 'write together, without the setup', href: 'https://cowyo.com' },
  { name: 'yesnotice', description: 'yes/no alerts when websites change', href: 'https://yesnotice.com' },
  { name: 'makemydrivefun', description: 'strange roadside detours', href: 'https://makemydrivefun.com' },
  { name: 'makestopmotion', description: 'claymation in browsers', href: 'https://makestopmotion.com' },
]

interface LegacyPromotion {
  metadata: KdfMetadata
  keys: SessionKeys
  documents: WireDocument[]
  rejectedDocuments: number
  deletedDocuments: number
  promoted: boolean
}

async function promoteLegacyWorkspace(username: string, password: string, workspaceId: string): Promise<LegacyPromotion | null> {
  const legacyId = legacyWorkspaceID(username)
  const legacyResponse = await fetch(`/api/v1/legacy/workspaces/${legacyId}`, { headers: { Accept: 'application/json' } })
  if (legacyResponse.status === 404) return null
  if (!legacyResponse.ok) throw new Error('The server could not load this legacy notebook.')
  const staged = parseLegacyWorkspace(await legacyResponse.json())
  if (staged.legacy_id !== legacyId) throw new Error('The server returned the wrong legacy notebook.')
  const decrypted = decryptLegacyWorkspace(staged, password)
  const metadata: KdfMetadata = { id: workspaceId, ...defaultKdf, kdf_salt: toBase64(randomSalt()), auth_public_key: '' }
  let keys = await deriveKeys(password, metadata)
  metadata.auth_public_key = toBase64(keys.authPublicKey)
  const timestamp = new Date().toISOString()
  const documents: WireDocument[] = decrypted.notes.map((note) => {
    const encrypted = encryptNote(note, workspaceId, keys.contentKey)
    return { document_id: note.id, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash, revision: 1, deleted: false, updated_at: timestamp }
  })
  let promotionResponse: Response
  try {
    promotionResponse = await fetch(`/api/v1/legacy/workspaces/${legacyId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username,
        workspace: metadata,
        documents,
        rejected_document_ids: decrypted.rejectedDocumentIds,
        discarded_document_ids: decrypted.deletedDocumentIds,
      }),
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
    return {
      metadata: current, keys, documents: [], rejectedDocuments: decrypted.rejectedDocumentIds.length,
      deletedDocuments: decrypted.deletedDocumentIds.length, promoted: false,
    }
  }
  if (!promotionResponse.ok) {
    clearKeys(keys)
    throw new Error('The legacy notebook could not be migrated.')
  }
  return {
    metadata, keys, documents, rejectedDocuments: decrypted.rejectedDocumentIds.length,
    deletedDocuments: decrypted.deletedDocumentIds.length, promoted: true,
  }
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
  const [folders, setFolders] = useState<OpenFolder[]>([])
  const foldersRef = useRef<OpenFolder[]>([])
  const preferencesRef = useRef<OpenWorkspacePreferences | null>(null)
  const [selectedID, setSelectedID] = useState('')
  const [selectedNoteIDs, setSelectedNoteIDs] = useState<string[]>([])
  const [activeFolderID, setActiveFolderID] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('offline')
  const [saveState, setSaveState] = useState<SaveState>('saved-offline')
  const [publications, setPublications] = useState<Record<string, Publication>>({})
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [publishingID, setPublishingID] = useState('')
  const [localSaveStatus, setLocalSaveStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const saveQueue = useRef<LatestSaveQueue<PendingRecord> | null>(null)
  const localWrites = useRef(0)
  const encryptionWorker = useRef<{ keys: SessionKeys; worker: EncryptionWorker } | null>(null)
  const [rotationOpen, setRotationOpen] = useState(false)
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null)
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoringLogin, setRestoringLogin] = useState(true)
  const [error, setError] = useState('')
  const syncRef = useRef<SyncClient | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const dirtyRecords = useRef(new Map<string, PrivateRecord>())
  const dirtyHashes = useRef(new Map<string, string>())
  const unreadableSyncedDocuments = useRef(new Set<string>())
  const tombstonedDocuments = useRef(new Set<string>())
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
  useEffect(() => {
    const available = new Set(notes.map(({ note }) => note.id))
    setSelectedNoteIDs((current) => {
      if (!selectedID || !available.has(selectedID)) return []
      const remaining = current.filter((id) => available.has(id))
      const next = remaining.includes(selectedID) ? remaining : [selectedID]
      return next.length === current.length && next.every((id, i) => id === current[i]) ? current : next
    })
  }, [notes, selectedID])
  useEffect(() => () => {
    syncRef.current?.close()
    saveQueue.current?.close()
    encryptionWorker.current?.worker.close()
    clearKeys(sessionRef.current?.keys ?? null)
  }, [])
  useEffect(() => {
    if (!session) return
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (event.shiftKey) setFolderDialog({ kind: 'create', parentId: activeFolderID })
        else void newNote(activeFolderID)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSidebarOpen(true)
        window.setTimeout(() => searchInput.current?.focus(), 0)
      }
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        setSettingsOpen(false)
        setFolderDialog(null)
        setMoveDialog(null)
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
    // The handler reads mutable note/sync refs; only a session transition changes its authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeFolderID])

  const refreshLocal = useCallback(async (active: Session, allowServerRecovery = false, documentIds?: string[]) => {
    const changed = documentIds ? new Set(documentIds) : null
    const stored = changed
      ? (await notebookDB.documents.bulkGet([...changed].map((id) => documentKey(active.metadata.id, id)))).filter((item): item is StoredDocument => Boolean(item))
      : await listDocuments(active.metadata.id)
    const cached = new Map<string, { record: PrivateRecord; stored: StoredDocument }>([
      ...notesRef.current.map(({ note, stored }) => [note.id, { record: note, stored }] as const),
      ...foldersRef.current.map(({ folder, stored }) => [folder.id, { record: folder, stored }] as const),
    ])
    const opened: OpenNote[] = changed ? notesRef.current.filter(({ note }) => !changed.has(note.id)) : []
    const openedFolders: OpenFolder[] = changed ? foldersRef.current.filter(({ folder }) => !changed.has(folder.id)) : []
    let openedPreferences = changed ? preferencesRef.current : null
    for (const item of stored) {
      if (item.deleted) continue
      try {
        const previous = cached.get(item.documentId)
        const record = dirtyRecords.current.get(item.documentId)
          ?? (previous?.stored.ciphertextHash === item.ciphertextHash ? previous.record : decryptRecord(item.ciphertext, active.metadata.id, item.documentId, active.keys.contentKey))
        unreadableSyncedDocuments.current.delete(item.documentId)
        if (isFolderRecord(record)) openedFolders.push({ folder: record, stored: item })
        else if (isWorkspacePreferences(record)) openedPreferences = { preferences: record, stored: item }
        else opened.push({ note: record, stored: item })
      } catch {
        const queued = await notebookDB.outbox.where('key').equals(item.key).count()
        if (!item.pending && queued === 0) {
          if (allowServerRecovery) {
            unreadableSyncedDocuments.current.add(item.documentId)
            continue
          }
          throw new Error('A synced local cache record could not be decrypted. Reconnect to its server to recover it.')
        }
        throw new Error('An unsynced local document could not be decrypted. Its encrypted data was preserved; restore a valid backup before continuing.')
      }
    }
    opened.sort((a, b) => b.note.updated_at.localeCompare(a.note.updated_at))
    openedFolders.sort((a, b) => a.folder.name.localeCompare(b.folder.name, undefined, { sensitivity: 'base', numeric: true }))
    setNotes(opened)
    notesRef.current = opened
    const sameFolders = openedFolders.length === foldersRef.current.length && openedFolders.every((item, i) => item.folder === foldersRef.current[i].folder && item.stored.ciphertextHash === foldersRef.current[i].stored.ciphertextHash && item.stored.pending === foldersRef.current[i].stored.pending && item.stored.revision === foldersRef.current[i].stored.revision)
    if (!sameFolders) { setFolders(openedFolders); foldersRef.current = openedFolders }
    preferencesRef.current = openedPreferences
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

  const queueDocument = useCallback(async (stored: StoredDocument, operation: 'upsert' | 'delete') => {
    localWrites.current++
    setLocalSaveStatus('saving')
    try {
      await queueDocumentInDB(stored, operation)
    } catch {
      throw new Error('Local storage unavailable')
    } finally {
      localWrites.current--
      if (localWrites.current === 0) setLocalSaveStatus((status) => status === 'error' ? status : saveQueue.current?.pending ? 'saving' : 'idle')
    }
  }, [])

  const persistRecord = useCallback(async (active: Session, record: PrivateRecord, openStored: StoredDocument) => {
    await runDocumentOperation(openStored.key, async () => {
      if (sessionRef.current !== active) throw new Error('Session closed')
      if (encryptionWorker.current?.keys !== active.keys) {
        encryptionWorker.current?.worker.close()
        encryptionWorker.current = { keys: active.keys, worker: new EncryptionWorker(active.metadata.id, active.keys.contentKey) }
      }
      let encrypted: { ciphertext: string; hash: string }
      try { encrypted = await encryptionWorker.current.worker.encrypt(record) }
      catch {
        encryptionWorker.current?.worker.close()
        encryptionWorker.current = null
        throw new Error('Local encryption failed')
      }
      if (sessionRef.current !== active) throw new Error('Session closed')
      const latest = await notebookDB.documents.get(openStored.key)
      if (latest?.deleted) return
      const stored: StoredDocument = {
        ...openStored,
        ciphertext: encrypted.ciphertext,
        ciphertextHash: encrypted.hash,
        deleted: false,
        pending: true,
        updatedAt: record.updated_at,
      }
      await queueDocument(stored, 'upsert')
      const persisted = await notebookDB.documents.get(stored.key) ?? stored
      if (dirtyRecords.current.get(record.id) === record) {
        dirtyHashes.current.set(record.id, encrypted.hash)
      }
      if (isWorkspacePreferences(record)) {
        preferencesRef.current = { preferences: record, stored: persisted }
      } else if (isFolderRecord(record)) {
        setFolders((current) => {
          const dirty = dirtyRecords.current.get(record.id)
          const folder = dirty && isFolderRecord(dirty) ? dirty : record
          const updated = current.map((item) => item.folder.id === record.id
            ? { folder, stored: persisted }
            : item)
          foldersRef.current = updated
          return updated
        })
      } else {
        setNotes((current) => {
          const dirty = dirtyRecords.current.get(record.id)
          const note = dirty && isNoteRecord(dirty) ? dirty : record as NoteContent
          const updated = current.map((item) => item.note.id === record.id ? { note, stored: persisted } : item)
          notesRef.current = updated
          return updated
        })
      }
    })
    syncRef.current?.scheduleFlush()
  }, [queueDocument, runDocumentOperation])

  const enqueueRecord = useCallback((active: Session, record: PrivateRecord, stored: StoredDocument) => {
    if (!saveQueue.current) {
      saveQueue.current = new LatestSaveQueue(
        (pending) => persistRecord(pending.active, pending.record, pending.stored),
        () => {
          const queue = saveQueue.current
          setLocalSaveStatus(queue?.failed ? 'error' : queue?.pending || localWrites.current ? 'saving' : 'idle')
        },
      )
    }
    saveQueue.current.enqueue(stored.key, { active, record, stored })
  }, [persistRecord])

  const drainSaves = useCallback(async () => {
    await saveQueue.current?.drain()
    await Promise.all([...documentOperations.current.values()])
  }, [])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveQueue.current?.pending || documentOperations.current.size || localWrites.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    const hidden = () => { if (document.visibilityState === 'hidden') void drainSaves().catch(() => undefined) }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', hidden) }
  }, [drainSaves])

  const rememberOpenedNote = useCallback(async (active: Session, noteId: string) => {
    const now = new Date().toISOString()
    const preferences: WorkspacePreferences = { record_type: 'workspace_preferences', id: workspacePreferencesDocumentID, last_opened_note_id: noteId, updated_at: now }
    const stored: StoredDocument = preferencesRef.current?.stored ?? {
      key: documentKey(active.metadata.id, workspacePreferencesDocumentID), workspaceId: active.metadata.id,
      documentId: workspacePreferencesDocumentID, ciphertext: '', ciphertextHash: '', revision: 0,
      deleted: false, pending: true, updatedAt: now,
    }
    dirtyRecords.current.set(preferences.id, preferences)
    preferencesRef.current = { preferences, stored }
    setSaveState('saved-offline')
    enqueueRecord(active, preferences, stored)
  }, [enqueueRecord])

  const closeSession = useCallback((keys: SessionKeys | null, message = '') => {
    syncRef.current?.close()
    syncRef.current = null
    saveQueue.current?.close()
    saveQueue.current = null
    encryptionWorker.current?.worker.close()
    encryptionWorker.current = null
    sessionRef.current = null
    setLocalSaveStatus('idle')
    setPublishingID('')
    clearKeys(keys)
    dirtyRecords.current.clear()
    dirtyHashes.current.clear()
    tombstonedDocuments.current.clear()
    unreadableSyncedDocuments.current.clear()
    pendingPublicationAnalytics.current.clear()
    pendingUnpublicationAnalytics.current.clear()
    notesRef.current = []
    foldersRef.current = []
    preferencesRef.current = null
    setSession(null)
    setNotes([])
    setFolders([])
    setSelectedID('')
    setSelectedNoteIDs([])
    setActiveFolderID(null)
    setPublications({})
    setSearch('')
    setConnection('offline')
    setSaveState('saved-offline')
    setSettingsOpen(false)
    setFolderDialog(null)
    setMoveDialog(null)
    setError(message)
    navigate('/')
  }, [navigate])

  const connect = useCallback((active: Session) => {
    syncRef.current?.close()
    const acceptDocuments = async (documents: WireDocument[], source: DocumentSource) => {
      let shouldFlush = false
      let recovered = 0
      for (const wire of documents) {
        const stored = storedFromWire(active.metadata.id, wire)
        if (unreadableSyncedDocuments.current.has(wire.document_id)) {
          if (await recoverUnreadableSyncedDocument(stored)) {
            unreadableSyncedDocuments.current.delete(wire.document_id)
            recovered += 1
          }
        }
        const key = documentKey(active.metadata.id, wire.document_id)
        if (stored.deleted) {
          const cached = await notebookDB.documents.get(key)
          if (!cached || stored.revision >= cached.revision) {
            tombstonedDocuments.current.add(wire.document_id)
            const open = notesRef.current.find(({ note }) => note.id === wire.document_id)
            if (open && (cached?.pending || saveQueue.current?.has(key))) {
              const now = new Date().toISOString()
              const record = dirtyRecords.current.get(wire.document_id) ?? open.note
              if (isNoteRecord(record)) {
                const copy: NoteContent = { ...record, id: crypto.randomUUID(), title: `${record.title || 'Untitled note'} (conflict ${now})`, created_at: now, updated_at: now }
                const encrypted = encryptNote(copy, active.metadata.id, active.keys.contentKey)
                const copyStored: StoredDocument = { key: documentKey(active.metadata.id, copy.id), workspaceId: active.metadata.id, documentId: copy.id, ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: now }
                await queueDocument(copyStored, 'upsert')
                notesRef.current = [...notesRef.current, { note: copy, stored: copyStored }]
                shouldFlush = true
              }
            }
            await saveQueue.current?.cancel(key)
            dirtyRecords.current.delete(wire.document_id)
            dirtyHashes.current.delete(wire.document_id)
          }
        }
        let dirtyRecord: PrivateRecord | undefined
        const result = await runDocumentOperation(key, () => {
          dirtyRecord = dirtyRecords.current.get(wire.document_id)
          return reconcileDocument(stored, source)
        })
        if (result.kind === 'inconsistent') {
          setError('Synchronization stopped for a document because the server returned inconsistent encrypted data.')
          continue
        }
        if (result.kind === 'rebased') shouldFlush = true
        if (result.kind === 'accepted') {
          if (dirtyRecords.current.get(wire.document_id) === dirtyRecord && !saveQueue.current?.has(key)) {
            dirtyRecords.current.delete(wire.document_id)
            dirtyHashes.current.delete(wire.document_id)
          }
        }
      }
      if (sessionRef.current !== active) return
      const local = await refreshLocal(active, source === 'initial', source === 'initial' ? undefined : documents.map((wire) => wire.document_id))
      if (source === 'initial') {
        const routeID = initialPath.current.match(/^\/app\/notes\/([^/]+)$/u)?.[1]
        const preferredID = preferencesRef.current?.preferences.last_opened_note_id
        const next = local.find((item) => item.note.id === routeID)
          ?? local.find((item) => item.note.id === preferredID)
          ?? local[0]
        if (next) {
          setSelectedID(next.note.id)
          setActiveFolderID(next.note.folder_id ?? null)
          navigate(`/app/notes/${next.note.id}`)
        }
      }
      if (source === 'initial' && recovered > 0) {
        showToast(`Recovered ${recovered} unreadable local cache ${recovered === 1 ? 'record' : 'records'} from the server.`)
      }
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
        try { await drainSaves() }
        catch {
          setConnection('offline')
          setError('The notebook password changed on another device. Save your pending edits before reopening it.')
          return
        }
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
  }, [closeSession, drainSaves, navigate, queueDocument, refreshLocal, runDocumentOperation, showToast])

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
        unreadableSyncedDocuments.current.clear()
        const local = await refreshLocal(active, response?.ok === true)
        if (cancelled) {
          clearKeys(active.keys)
          return
        }
        sessionRef.current = active
        setSession(active)
        connect(active)
        const routeID = initialPath.current.match(/^\/app\/notes\/([^/]+)$/u)?.[1]
        const first = local.find((item) => item.note.id === routeID)?.note.id
          ?? local.find((item) => item.note.id === preferencesRef.current?.preferences.last_opened_note_id)?.note.id
          ?? local[0]?.note.id
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
    unreadableSyncedDocuments.current.clear()
    let authEvent: 'notebook-create' | 'notebook-unlock' = 'notebook-unlock'
    let createFailure: 'validation' | 'already-exists' | 'server' | 'crypto' | 'unknown' = 'validation'
    let unlockFailure: 'validation' | 'not-found' | 'incorrect-password' | 'offline-unavailable' | 'server' | 'crypto' | 'unknown' = 'validation'
    try {
      const parsed = credentialSchema.parse({ username, password })
      const id = workspaceID(parsed.username)
      let metadata: KdfMetadata
      let keys: SessionKeys
      let migratedDocuments: WireDocument[] = []
      let rejectedLegacyDocuments = 0
      let deletedLegacyDocuments = 0
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
          rejectedLegacyDocuments = migration.rejectedDocuments
          deletedLegacyDocuments = migration.deletedDocuments
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
      sessionRef.current = active
      setSession(active)
      const local = await refreshLocal(active, response !== undefined)
      connect(active)
      const routeID = location.pathname.match(/^\/app\/notes\/([^/]+)$/u)?.[1]
      const first = local.find((item) => item.note.id === routeID)?.note.id
        ?? local.find((item) => item.note.id === preferencesRef.current?.preferences.last_opened_note_id)?.note.id
        ?? local[0]?.note.id
      if (first) { setSelectedID(first); navigate(`/app/notes/${first}`) } else navigate('/app')
      if (promoted) {
        const deleted = deletedLegacyDocuments > 0 ? ` Omitted ${deletedLegacyDocuments} legacy deletion ${deletedLegacyDocuments === 1 ? 'marker' : 'markers'}.` : ''
        const unreadable = rejectedLegacyDocuments > 0 ? ` Skipped ${rejectedLegacyDocuments} unreadable legacy ${rejectedLegacyDocuments === 1 ? 'record' : 'records'}.` : ''
        showToast(`Migrated ${migratedDocuments.length} legacy note${migratedDocuments.length === 1 ? '' : 's'}.${deleted}${unreadable}`)
      }
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

  function updateNote(noteId: string, patch: Partial<Pick<NoteContent, 'title' | 'content' | 'mode' | 'folder_id'>>): void {
    if (!session || !noteId || tombstonedDocuments.current.has(noteId)) return
    const current = notesRef.current.find((item) => item.note.id === noteId)
    if (!current) return
    const dirty = dirtyRecords.current.get(noteId)
    const base = dirty && isNoteRecord(dirty) ? dirty : current.note
    const changed: OpenNote = { ...current, note: { ...base, ...patch, updated_at: new Date().toISOString() } }
    dirtyRecords.current.set(noteId, changed.note)
    setSaveState('saved-offline')
    const updated = notesRef.current.map((item) => item.note.id === noteId ? changed : item)
    notesRef.current = updated
    setNotes(updated)
    enqueueRecord(session, changed.note, changed.stored)
  }

  function editNote(patch: Partial<Pick<NoteContent, 'title' | 'content' | 'mode' | 'folder_id'>>): void {
    updateNote(selectedID, patch)
  }

  async function newNote(folderId: string | null = activeFolderID): Promise<void> {
    if (!session) return
    let failureReason: 'local-storage' | 'unknown' = 'unknown'
    try {
      setSaveState('saved-offline')
      const now = new Date().toISOString()
      const targetFolder = folderId && foldersRef.current.some(({ folder }) => folder.id === folderId) ? folderId : null
      const note: NoteContent = { id: crypto.randomUUID(), title: '', content: '', mode: 'markdown', folder_id: targetFolder, created_at: now, updated_at: now }
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
      setSelectedNoteIDs([note.id])
      setActiveFolderID(targetFolder)
      setSidebarOpen(false)
      navigate(`/app/notes/${note.id}`)
      void rememberOpenedNote(session, note.id).catch(() => undefined)
      await syncRef.current?.flush()
    } catch {
      trackEvent({ event: 'note-create', outcome: 'error', reason: failureReason }, 'note')
      setError('The note could not be created.')
    }
  }

  async function tombstoneDocument(stored: StoredDocument): Promise<void> {
    await saveQueue.current?.cancel(stored.key)
    await runDocumentOperation(stored.key, async () => {
      const latest = await notebookDB.documents.get(stored.key) ?? stored
      await queueDocument({ ...latest, ciphertext: '', ciphertextHash: '', deleted: true, pending: true, updatedAt: new Date().toISOString() }, 'delete')
    })
  }

  async function deleteNotes(noteIds: string[]): Promise<void> {
    if (!session) return
    const requested = new Set(noteIds)
    const deletedNotes = notesRef.current.filter(({ note }) => requested.has(note.id))
    if (!deletedNotes.length) return
    const confirmation = deletedNotes.length === 1
      ? 'Permanently delete this note from every synced device?'
      : `Permanently delete ${deletedNotes.length} selected notes from every synced device?`
    if (!window.confirm(confirmation)) return
    try {
      setSaveState('saved-offline')
      for (const open of deletedNotes) await tombstoneDocument(open.stored)
      trackEvent({ event: 'note-delete', outcome: 'success' }, 'note')
      for (const { note } of deletedNotes) {
        dirtyRecords.current.delete(note.id)
        dirtyHashes.current.delete(note.id)
      }
      const deletedIds = new Set(deletedNotes.map(({ note }) => note.id))
      const updated = notesRef.current.filter(({ note }) => !deletedIds.has(note.id))
      notesRef.current = updated
      setNotes(updated)
      setSelectedNoteIDs((current) => current.filter((id) => !deletedIds.has(id)))
      if (deletedIds.has(selectedID)) {
        const next = updated[0]
        setSelectedID(next?.note.id ?? '')
        setActiveFolderID(next?.note.folder_id ?? null)
        navigate(next ? `/app/notes/${next.note.id}` : '/app')
        void rememberOpenedNote(session, next?.note.id ?? '').catch(() => undefined)
      }
      if (deletedNotes.length > 1) showToast(`Deleted ${deletedNotes.length} notes.`)
      await syncRef.current?.flush()
    } catch {
      trackEvent({ event: 'note-delete', outcome: 'error', reason: 'local-storage' }, 'note')
      setError(deletedNotes.length === 1 ? 'The note could not be deleted.' : 'The selected notes could not all be deleted.')
      await refreshLocal(session).catch(() => undefined)
    }
  }

  function selectNotes(ids: string[], activeId: string): void {
    const available = new Set(notesRef.current.map(({ note }) => note.id))
    const selection = [...new Set(ids)].filter((id) => available.has(id))
    const open = notesRef.current.find((item) => item.note.id === activeId)
    if (!open) return
    setSelectedNoteIDs(selection.includes(activeId) ? selection : [activeId])
    setSelectedID(activeId)
    setActiveFolderID(open?.note.folder_id ?? null)
    if (selection.length === 1) setSidebarOpen(false)
    navigate(`/app/notes/${activeId}`)
    if (session) void rememberOpenedNote(session, activeId).catch(() => undefined)
  }

  function selectFolder(id: string | null): void {
    setActiveFolderID(id)
    setSelectedID('')
    setSelectedNoteIDs([])
    setSidebarOpen(false)
    navigate('/app')
  }

  async function createFolder(name: string, parentId: string | null): Promise<void> {
    if (!session) return
    const allFolders = foldersRef.current.map(({ folder }) => folder)
    const targetParent = parentId && allFolders.some((folder) => folder.id === parentId) ? parentId : null
    const validation = folderNameError(name, targetParent, allFolders)
    if (validation) throw new Error(validation)
    const now = new Date().toISOString()
    const folder: FolderContent = {
      record_type: 'folder', id: crypto.randomUUID(), name: name.trim(), parent_id: targetParent,
      created_at: now, updated_at: now,
    }
    const encrypted = encryptRecord(folder, session.metadata.id, session.keys.contentKey)
    const stored: StoredDocument = {
      key: documentKey(session.metadata.id, folder.id), workspaceId: session.metadata.id, documentId: folder.id,
      ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: now,
    }
    setSaveState('saved-offline')
    await queueDocument(stored, 'upsert')
    const updated = [...foldersRef.current, { folder, stored }]
    foldersRef.current = updated
    setFolders(updated)
    setActiveFolderID(folder.id)
    setFolderDialog(null)
    showToast(`Created “${folder.name}”.`)
    await syncRef.current?.flush()
  }

  function updateFolder(folderId: string, patch: Partial<Pick<FolderContent, 'name' | 'parent_id'>>): void {
    if (!session) return
    const current = foldersRef.current.find(({ folder }) => folder.id === folderId)
    if (!current) return
    const dirty = dirtyRecords.current.get(folderId)
    const base = dirty && isFolderRecord(dirty) ? dirty : current.folder
    const changed: OpenFolder = { ...current, folder: { ...base, ...patch, updated_at: new Date().toISOString() } }
    dirtyRecords.current.set(folderId, changed.folder)
    setSaveState('saved-offline')
    const updated = foldersRef.current.map((item) => item.folder.id === folderId ? changed : item)
    foldersRef.current = updated
    setFolders(updated)
    enqueueRecord(session, changed.folder, changed.stored)
  }

  async function renameFolder(folderId: string, name: string): Promise<void> {
    const current = foldersRef.current.find(({ folder }) => folder.id === folderId)?.folder
    if (!current) return
    const validation = folderNameError(name, current.parent_id, foldersRef.current.map(({ folder }) => folder), folderId)
    if (validation) throw new Error(validation)
    updateFolder(folderId, { name: name.trim() })
    setFolderDialog(null)
    showToast(`Renamed folder to “${name.trim()}”.`)
  }

  function moveNote(noteId: string, folderId: string | null): void {
    const note = notesRef.current.find((item) => item.note.id === noteId)
    if (!note || (note.note.folder_id ?? null) === folderId) { setMoveDialog(null); return }
    updateNote(noteId, { folder_id: folderId })
    if (noteId === selectedID) setActiveFolderID(folderId)
    setMoveDialog(null)
    showToast(`Moved note to ${folderPath(folderId, foldersRef.current.map(({ folder }) => folder))}.`)
  }

  function moveNotes(noteIds: string[], folderId: string | null): void {
    const requested = new Set(noteIds)
    const moved = notesRef.current.filter(({ note }) => requested.has(note.id) && (note.folder_id ?? null) !== folderId)
    for (const { note } of moved) updateNote(note.id, { folder_id: folderId })
    if (requested.has(selectedID)) setActiveFolderID(folderId)
    setMoveDialog(null)
    if (moved.length) showToast(`Moved ${moved.length} note${moved.length === 1 ? '' : 's'} to ${folderPath(folderId, foldersRef.current.map(({ folder }) => folder))}.`)
  }

  function moveFolder(folderId: string, parentId: string | null): void {
    const allFolders = foldersRef.current.map(({ folder }) => folder)
    const current = allFolders.find((folder) => folder.id === folderId)
    if (!current || current.parent_id === parentId) { setMoveDialog(null); return }
    if (!canMoveFolder(folderId, parentId, allFolders)) {
      setError('A folder cannot be moved inside itself or one of its subfolders.')
      return
    }
    const duplicate = folderNameError(current.name, parentId, allFolders, folderId)
    if (duplicate) { setError(duplicate); return }
    updateFolder(folderId, { parent_id: parentId })
    setMoveDialog(null)
    showToast(`Moved “${current.name}” to ${folderPath(parentId, allFolders)}.`)
  }

  async function deleteFolder(folderId: string): Promise<void> {
    if (!session) return
    const allFolders = foldersRef.current.map(({ folder }) => folder)
    const folder = allFolders.find((candidate) => candidate.id === folderId)
    if (!folder) return
    const deletedFolderIds = descendantFolderIds(folderId, allFolders)
    const deletedNotes = notesRef.current.filter(({ note }) => Boolean(note.folder_id && deletedFolderIds.has(note.folder_id)))
    const nestedCount = deletedFolderIds.size - 1
    const detail = `${deletedNotes.length} note${deletedNotes.length === 1 ? '' : 's'}${nestedCount ? ` and ${nestedCount} subfolder${nestedCount === 1 ? '' : 's'}` : ''}`
    if (!window.confirm(`Permanently delete “${folder.name}” and ${detail} from every synced device?`)) return
    try {
      setSaveState('saved-offline')
      const deletedFolders = foldersRef.current.filter(({ folder: candidate }) => deletedFolderIds.has(candidate.id))
      for (const item of [...deletedNotes, ...deletedFolders]) await tombstoneDocument(item.stored)
      for (const id of [...deletedFolderIds, ...deletedNotes.map(({ note }) => note.id)]) {
        dirtyRecords.current.delete(id)
        dirtyHashes.current.delete(id)
      }
      const remainingFolders = foldersRef.current.filter(({ folder: candidate }) => !deletedFolderIds.has(candidate.id))
      const remainingNotes = notesRef.current.filter(({ note }) => !note.folder_id || !deletedFolderIds.has(note.folder_id))
      foldersRef.current = remainingFolders
      notesRef.current = remainingNotes
      setFolders(remainingFolders)
      setNotes(remainingNotes)
      if (deletedFolderIds.has(activeFolderID ?? '')) setActiveFolderID(null)
      if (deletedNotes.some(({ note }) => note.id === selectedID)) {
        const next = remainingNotes[0]
        setSelectedID(next?.note.id ?? '')
        setActiveFolderID(next?.note.folder_id ?? null)
        navigate(next ? `/app/notes/${next.note.id}` : '/app')
        void rememberOpenedNote(session, next?.note.id ?? '').catch(() => undefined)
      }
      showToast(`Deleted “${folder.name}”.`)
      await syncRef.current?.flush()
    } catch {
      setError('The folder could not be deleted.')
      await refreshLocal(session).catch(() => undefined)
    }
  }

  function dropItem(item: { kind: 'note' | 'folder'; id: string }, folderId: string | null): void {
    if (item.kind === 'note') moveNote(item.id, folderId)
    else moveFolder(item.id, folderId)
  }

  async function publish(renderMode: PublicationRenderMode): Promise<void> {
    if (connection !== 'online') throw new Error('Publishing requires a connection')
    await drainSaves()
    const open = notesRef.current.find((item) => item.note.id === publishingID)
    if (!open) throw new Error('Note unavailable')
    const variant = publications[open.note.id] ? 'update' : 'create'
    pendingPublicationAnalytics.current.set(open.note.id, variant)
    if (!syncRef.current?.publish(open.note.id, open.note.title || 'Untitled note', open.note.content, open.note.mode, publications[open.note.id]?.public_id, renderMode)) {
      pendingPublicationAnalytics.current.delete(open.note.id)
      trackEvent({ event: 'snapshot-publish', outcome: 'error', variant, reason: 'server' }, 'note')
      throw new Error('Publishing unavailable')
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
    void drainSaves().then(() => listDocuments(session.metadata.id)).then((documents) => {
      download(`offlinenotepad-${new Date().toISOString().slice(0, 10)}.onp.json`, {
        format: 'offlinenotepad-encrypted-archive', version: 3, exported_at: new Date().toISOString(), workspace: session.metadata, documents,
      })
      trackEvent({ event: 'archive-export', outcome: 'success', variant: 'encrypted' }, selectedID ? 'note' : 'notebook')
    }).catch(() => {
      trackEvent({ event: 'archive-export', outcome: 'error', variant: 'encrypted', reason: 'local-storage' }, selectedID ? 'note' : 'notebook')
      setError('The encrypted archive could not be exported.')
    })
  }

  async function exportPlaintext(): Promise<void> {
    if (!window.confirm('Plaintext export removes encryption. Store the downloaded file somewhere private. Continue?')) return
    try {
      await drainSaves()
      download(`offlinenotepad-plaintext-${new Date().toISOString().slice(0, 10)}.json`, {
        format: 'offlinenotepad-plaintext', version: 3, exported_at: new Date().toISOString(),
        folders: foldersRef.current.map(({ folder }) => folder), notes: notesRef.current.map(({ note }) => note),
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
      let importedRecords: PrivateRecord[] = []
      if (typeof value === 'object' && value && 'format' in value && (value as { format: string }).format === 'offlinenotepad-encrypted-archive') {
        variant = 'encrypted'
        const archive = value as unknown as { workspace: KdfMetadata; documents: StoredDocument[] }
        if (archive.workspace.id !== session.metadata.id) throw new Error('This encrypted archive belongs to a different notebook.')
        failureReason = 'crypto'
        importedRecords = archive.documents.filter((item) => !item.deleted).map((item) => decryptRecord(item.ciphertext, session.metadata.id, item.documentId, session.keys.contentKey))
      } else {
        if (typeof value === 'object' && value && 'format' in value && (value as { format: string }).format === 'offlinenotepad-plaintext') variant = 'plaintext'
        const root = value as { notes?: unknown[]; folders?: unknown[] }
        const importedFolders = Array.isArray(root?.folders) ? root.folders : []
        importedRecords.push(...importedFolders
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string'))
          .map((item) => {
            const now = new Date().toISOString()
            return {
              record_type: 'folder' as const,
              id: String(item.id),
              name: String(item.name ?? 'Imported folder'),
              parent_id: typeof item.parent_id === 'string' ? item.parent_id : null,
              created_at: String(item.created_at ?? now),
              updated_at: now,
            }
          }))
        const candidates = Array.isArray(value) ? value : Array.isArray(root?.notes) ? root.notes : Object.values(value as Record<string, unknown>)
        importedRecords.push(...candidates.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !('record_type' in item))).map((item) => {
          const now = new Date().toISOString()
          const title = String(item.title ?? item.name ?? '')
          return {
            id: typeof item.id === 'string' ? item.id : crypto.randomUUID(), title, content: String(item.content ?? item.markdown ?? ''),
            mode: (item.mode === 'plaintext' || (item.mode == null && title.includes('.')) ? 'plaintext' : 'markdown') as ContentMode,
            folder_id: typeof item.folder_id === 'string' ? item.folder_id : null,
            created_at: String(item.created_at ?? item.created ?? now), updated_at: now,
          }
        }))
      }
      failureReason = 'local-storage'
      if (importedRecords.length) setSaveState('saved-offline')
      const oldFolders = importedRecords.filter(isFolderRecord)
      const folderIdMap = new Map(oldFolders.map((folder) => [folder.id, crypto.randomUUID()]))
      const preparedFolders: FolderContent[] = []
      for (const old of oldFolders) {
        const parentId = old.parent_id ? folderIdMap.get(old.parent_id) ?? null : null
        const baseName = old.name.trim() || 'Imported folder'
        let name = baseName
        let suffix = 2
        while (folderNameError(name, parentId, [...foldersRef.current.map(({ folder }) => folder), ...preparedFolders])) {
          name = `${baseName} (${suffix++})`
        }
        const now = new Date().toISOString()
        preparedFolders.push({ ...old, id: folderIdMap.get(old.id)!, name, parent_id: parentId, created_at: now, updated_at: now })
      }
      const preparedNotes = importedRecords.filter(isNoteRecord).map((old) => {
        const now = new Date().toISOString()
        return { ...old, id: crypto.randomUUID(), folder_id: old.folder_id ? folderIdMap.get(old.folder_id) ?? null : null, created_at: now, updated_at: now }
      })
      for (const record of [...preparedFolders, ...preparedNotes]) {
        const encrypted = encryptRecord(record, session.metadata.id, session.keys.contentKey)
        await queueDocument({ key: documentKey(session.metadata.id, record.id), workspaceId: session.metadata.id, documentId: record.id, ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 0, deleted: false, pending: true, updatedAt: record.updated_at }, 'upsert')
      }
      await refreshLocal(session)
      await syncRef.current?.flush()
      trackEvent({ event: 'archive-import', outcome: 'success', variant }, selectedID ? 'note' : 'notebook')
      showToast(`Imported ${preparedNotes.length} note${preparedNotes.length === 1 ? '' : 's'}${preparedFolders.length ? ` and ${preparedFolders.length} folder${preparedFolders.length === 1 ? '' : 's'}` : ''}.`)
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
      if (connection !== 'online') throw new Error('Connect to the server before changing the password.')
      await drainSaves()
      await syncRef.current?.flush()
      const deadline = Date.now() + 10_000
      while (
        (documentOperations.current.size
          || dirtyHashes.current.size
          || await notebookDB.outbox.where('workspaceId').equals(session.metadata.id).count())
        && Date.now() < deadline
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 50))
      }
      if (documentOperations.current.size || dirtyHashes.current.size || await notebookDB.outbox.where('workspaceId').equals(session.metadata.id).count()) {
        throw new Error('Wait for all documents to sync before changing the password.')
      }
      failureReason = 'validation'
      credentialSchema.shape.password.parse(password)
      const metadata: KdfMetadata = { ...session.metadata, ...defaultKdf, kdf_salt: toBase64(randomSalt()), auth_public_key: '' }
      failureReason = 'crypto'
      const keys = await deriveKeys(password, metadata)
      metadata.auth_public_key = toBase64(keys.authPublicKey)
      const records = [
        ...notesRef.current.map(({ note, stored }) => ({ record: note as PrivateRecord, stored })),
        ...foldersRef.current.map(({ folder, stored }) => ({ record: folder as PrivateRecord, stored })),
        ...(preferencesRef.current ? [{ record: preferencesRef.current.preferences as PrivateRecord, stored: preferencesRef.current.stored }] : []),
      ]
      const rotation = records.map(({ record, stored }) => {
        const encrypted = encryptRecord(record, metadata.id, keys.contentKey)
        return { document_id: record.id, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash, revision: stored.revision }
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
      encryptionWorker.current?.worker.close()
      encryptionWorker.current = null
      clearKeys(session.keys)
      sessionRef.current = active
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
      await drainSaves()
      await clearLogin()
      closeSession(session?.keys ?? null)
    } catch {
      setError('Save your pending edits before signing out. Retry saving and try again.')
    }
  }

  const folderRecords = useMemo(() => folders.map(({ folder }) => folder), [folders])
  const searchIDs = useNoteSearch(notes, folderRecords, search, session?.metadata.id)
  const filteredNotes = useMemo(() => searchIDs ? notes.filter(({ note }) => searchIDs.has(note.id)) : notes, [notes, searchIDs])
  const selected = notes.find((item) => item.note.id === selectedID)
  const selectedPublication = selected ? publications[selected.note.id] : undefined
  const publicationOutdated = Boolean(selected && selectedPublication && new Date(selected.note.updated_at).getTime() > new Date(selectedPublication.updated_at).getTime())
  const selectedNoteIdSet = useMemo(() => new Set(selectedNoteIDs), [selectedNoteIDs])
  const activeFolder = activeFolderID ? folderRecords.find((folder) => folder.id === activeFolderID) : undefined
  const editingFolder = folderDialog?.kind === 'rename' ? folderRecords.find((folder) => folder.id === folderDialog.folderId) : undefined
  let moveDialogParentId: string | null | undefined
  if (moveDialog?.kind === 'note') {
    moveDialogParentId = notesRef.current.find(({ note }) => note.id === moveDialog.id)?.note.folder_id ?? null
  } else if (moveDialog?.kind === 'folder') {
    moveDialogParentId = foldersRef.current.find(({ folder }) => folder.id === moveDialog.id)?.folder.parent_id ?? null
  } else if (moveDialog?.kind === 'notes') {
    const parentIds = new Set(notesRef.current
      .filter(({ note }) => moveDialog.ids.includes(note.id))
      .map(({ note }) => note.folder_id ?? null))
    if (parentIds.size === 1) moveDialogParentId = [...parentIds][0]
  }

  const treeEvents = {
    onSelectNotes: useEvent(selectNotes),
    onClearNoteSelection: useEvent(() => setSelectedNoteIDs(selectedID ? [selectedID] : [])),
    onSelectFolder: useEvent(selectFolder),
    onNewNote: useEvent((folderId: string | null) => { void newNote(folderId) }),
    onNewFolder: useEvent((parentId: string | null) => setFolderDialog({ kind: 'create', parentId })),
    onRenameFolder: useEvent((folderId: string) => setFolderDialog({ kind: 'rename', folderId })),
    onMoveNote: useEvent((id: string) => setMoveDialog({ kind: 'note', id })),
    onMoveFolder: useEvent((id: string) => setMoveDialog({ kind: 'folder', id })),
    onMoveNotes: useEvent((ids: string[]) => setMoveDialog({ kind: 'notes', ids })),
    onDeleteNote: useEvent((id: string) => { void deleteNotes([id]) }),
    onDeleteNotes: useEvent((ids: string[]) => { void deleteNotes(ids) }),
    onDeleteFolder: useEvent((id: string) => { void deleteFolder(id) }),
    onDropItem: useEvent(dropItem),
  }
  const editContent = useEvent((content: string) => editNote({ content }))

  if (!session) return <Welcome restoring={restoringLogin} busy={busy} error={error} onAuthenticate={authenticate} />

  return (
    <div className={`notebook ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Files">
        <div className="sidebar-top">
          <a className="brand compact" href="/app" onClick={(event) => { event.preventDefault(); navigate('/app') }}><span className="brand-mark"><NotebookPen aria-hidden="true" /></span><span>Offline Notepad</span></a>
          <button className="icon-button desktop-collapse" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close notes"><X /></button>
        </div>
        <div className="create-actions">
          <button className="new-note" onClick={() => void newNote(activeFolderID)} aria-label="New note" title={`New note in ${folderPath(activeFolderID, folderRecords)}`}><FilePlus2 /> <span>New note</span><kbd>⌘ N</kbd></button>
          <button className="new-folder" onClick={() => setFolderDialog({ kind: 'create', parentId: activeFolderID })} aria-label="New folder" title="New folder (⌘ ⇧ N)"><FolderPlus /></button>
        </div>
        <label className="search-box"><Search /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" aria-label="Search notes" /></label>
        <FileTree
          notes={filteredNotes} folders={folderRecords} search={search} selectedNoteId={selectedID} selectedNoteIds={selectedNoteIdSet} activeFolderId={activeFolderID}
          {...treeEvents}
        />
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
            {localSaveStatus === 'error' ? <button className="button secondary" onClick={() => void drainSaves().catch(() => undefined)}>Save failed · Retry</button> : localSaveStatus === 'saving' ? <>Saving…</> : saveState === 'synced' && connection === 'online' ? <><Check /> Synced</> : <><CloudOff /> Saved offline</>}
          </div>
          <div className="toolbar-actions">
            {selected?.note.mode === 'markdown' && <div className="mode-switch" aria-label="Markdown editor view"><button className={markdownEditorMode === 'live' ? 'active' : ''} aria-pressed={markdownEditorMode === 'live'} onClick={() => setMarkdownEditorMode('live')}><Eye /> Live</button><button className={markdownEditorMode === 'source' ? 'active' : ''} aria-pressed={markdownEditorMode === 'source'} onClick={() => setMarkdownEditorMode('source')}><Code2 /> Source</button></div>}
            <button className="button secondary publish-button" onClick={() => setPublishingID(selectedID)} disabled={!selected}><Share2 /> {selectedPublication ? 'Update snapshot' : 'Publish'}</button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="More options"><MoreHorizontal /></button>
          </div>
        </header>
        {selected ? (
          <section className="editor-shell">
            <input className="title-input" value={selected.note.title} onChange={(event) => editNote({ title: event.target.value })} placeholder="Untitled note" aria-label="Note title" />
            <div className="editor-details">
              <button className="note-location" onClick={() => setMoveDialog({ kind: 'note', id: selected.note.id })} title="Move note"><Folder /> {folderPath(selected.note.folder_id, folderRecords)}</button>
              <span>{selected.note.mode === 'markdown' ? 'Markdown' : 'Plain text'}</span><span>Edited {dateLabel(selected.note.updated_at)}</span>
              {selectedPublication && <a href={publicationURL(selectedPublication)} target="_blank" rel="noreferrer">Public snapshot ↗</a>}
              {publicationOutdated && <span className="outdated">Snapshot outdated</span>}
            </div>
            <Suspense fallback={<div className="editor-loading" role="status">Loading editor…</div>}>
              <MarkdownEditor key={selected.note.id} documentId={selected.note.id} value={selected.note.content} mode={markdownEditorMode} contentMode={selected.note.mode} onChange={editContent} />
            </Suspense>
          </section>
        ) : connection === 'connecting' ? (
          <section className="connecting-editor" role="status" aria-label="Connecting to your notebook">
            <span className="loader" aria-hidden="true" />
          </section>
        ) : (
          <section className="empty-editor"><div className="empty-art"><Sparkles /></div><p className="eyebrow">{activeFolder ? folderPath(activeFolder.id, folderRecords) : 'Your private workspace'}</p><h1>{activeFolder ? `“${activeFolder.name}” is ready.` : 'Capture what matters.'}</h1><p>Notes and folders are encrypted in this browser, saved locally first, and synchronized whenever you’re connected.</p><button className="button primary" onClick={() => void newNote(activeFolderID)}><FilePlus2 /> {activeFolder ? 'New note in this folder' : 'Create your first note'}</button></section>
        )}
      </main>

      {publishingID && <PublishDialog initialMode={publications[publishingID]?.render_mode ?? 'document'} updating={Boolean(publications[publishingID])} onClose={() => setPublishingID('')} onPublish={publish} />}
      {settingsOpen && <SettingsPanel
        theme={theme} mode={selected?.note.mode} publication={selected ? publications[selected.note.id] : undefined}
        onClose={() => setSettingsOpen(false)} onTheme={setTheme} onMode={(mode) => editNote({ mode })}
        onEncryptedExport={exportEncrypted} onPlaintextExport={exportPlaintext} onImport={() => fileInput.current?.click()}
        onRotate={() => setRotationOpen(true)} onDelete={() => void deleteNotes(selectedID ? [selectedID] : [])} onUnpublish={unpublish} onLogout={() => void logout()}
      />}
      <input ref={fileInput} hidden type="file" accept=".json,.onp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
      {folderDialog && <FolderDialog
        title={folderDialog.kind === 'create' ? 'New folder' : 'Rename folder'}
        description={folderDialog.kind === 'create'
          ? `Create it inside ${folderPath(folderDialog.parentId, folderRecords)}.`
          : `Choose a new name for “${editingFolder?.name ?? 'this folder'}”.`}
        initialName={editingFolder?.name ?? ''}
        validate={(name) => folderDialog.kind === 'create'
          ? folderNameError(name, folderDialog.parentId, folderRecords)
          : editingFolder ? folderNameError(name, editingFolder.parent_id, folderRecords, editingFolder.id) : 'Folder not found.'}
        onClose={() => setFolderDialog(null)}
        onSubmit={(name) => folderDialog.kind === 'create' ? createFolder(name, folderDialog.parentId) : renameFolder(folderDialog.folderId, name)}
      />}
      {moveDialog && <MoveDialog
        title={moveDialog.kind === 'notes' ? `Move ${moveDialog.ids.length} notes` : moveDialog.kind === 'note' ? 'Move note' : 'Move folder'} folders={folderRecords}
        currentParentId={moveDialogParentId}
        unavailable={moveDialog.kind === 'folder' ? descendantFolderIds(moveDialog.id, folderRecords) : new Set()}
        onClose={() => setMoveDialog(null)}
        onMove={(folderId) => moveDialog.kind === 'notes' ? moveNotes(moveDialog.ids, folderId) : moveDialog.kind === 'note' ? moveNote(moveDialog.id, folderId) : moveFolder(moveDialog.id, folderId)}
      />}
      {rotationOpen && <PasswordDialog busy={busy} error={error} onClose={() => { setRotationOpen(false); setError('') }} onSubmit={(password) => void rotatePassword(password)} />}
      {toast && <div className="toast" role="status"><Check />{toast}</div>}
      {error && session && !rotationOpen && <div className="error-toast" role="alert"><X />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X /></button></div>}
    </div>
  )
}

function ProjectFooter() {
  return <footer className="project-footer">
    <nav className="project-footer-links" aria-label="Footer navigation">
      <span>made by <a href="https://github.com/sponsors/schollz" rel="noreferrer" target="_blank">schollz</a></span>
      <span aria-hidden="true">·</span>
      <a href="https://github.com/schollz/offlinenotepad" rel="noreferrer" target="_blank">github</a>
      <span aria-hidden="true">·</span>
      <a href="https://disco.cloud/" rel="noreferrer" target="_blank">deployed with disco</a>
    </nav>
    <details className="tools-menu">
      <summary>other tools</summary>
      <ul>{otherTools.map((tool) => <li key={tool.href}><a href={tool.href} rel="noreferrer" target="_blank"><strong>{tool.name}</strong><span>{tool.description}</span></a></li>)}</ul>
    </details>
  </footer>
}

function Welcome({ restoring, busy, error, onAuthenticate }: { restoring: boolean; busy: boolean; error: string; onAuthenticate: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const submit = (event: FormEvent) => { event.preventDefault(); void onAuthenticate(username, password) }
  return <div className="welcome">
    <div className="welcome-shell">
      <nav className="welcome-nav">
        <a className="brand" href="/" aria-label="Offline Notepad home"><span className="brand-mark"><NotebookPen aria-hidden="true" /></span><span>Offline Notepad</span></a>
        <div className="welcome-page-links"><a href="/about">About</a><a href="/blog">Blog</a><a href="/contact">Contact</a></div>
      </nav>
      <main>
        <section className="auth-section" aria-labelledby="notebook-access-title">
          <div className="auth-heading">
            <h1 id="notebook-access-title">Sign in or create a notebook</h1>
          </div>
          {restoring ? <div className="auth-restoring" role="status"><span className="spinner" /><span>Opening your saved notebook…</span></div> : <>
            <form onSubmit={submit}>
              <div className="auth-fields">
                <label>Notebook name<input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="e.g. north-star" /></label>
                <div className="auth-field">
                  <label htmlFor="notebook-password">Password</label>
                  <div className="password-input">
                    <input id="notebook-password" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" />
                    <button type="button" className="password-toggle" aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>
                      {passwordVisible ? <Eye aria-hidden="true" /> : <EyeClosed aria-hidden="true" />}
                    </button>
                  </div>
                </div>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="button primary auth-submit" disabled={busy}>{busy ? <span className="spinner" /> : <LockKeyhole />}{busy ? 'Deriving encryption keys…' : 'Sign in or create notebook'}</button>
            </form>
            <p className="no-recovery"><ShieldCheck /> Your password never leaves this browser. There is no recovery.</p>
          </>}
        </section>
        <section className="welcome-details" aria-label="About Offline Notepad">
          <h2>Welcome to the Offline Notepad.</h2>
          <p>Offline Notepad is a free, <a href="https://github.com/schollz/offlinenotepad" rel="noreferrer" target="_blank">open-source</a>, offline-capable note-writing app that securely synchronizes across all your devices. Everything you write is encrypted and stored locally, with encrypted syncing via a server.</p>
          <p>Offline Notepad is offline-first, which means you can create, edit, delete, and search notes without an internet connection. Your notes automatically sync with a server using end-to-end encryption when you come online.</p>
        </section>
      </main>
      <ProjectFooter />
    </div>
  </div>
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
    <section><h3>Security</h3><button className="setting-row" onClick={props.onRotate}><KeyRound /><span><strong>Change password</strong><small>Re-encrypt every note and folder</small></span></button><button className="setting-row" onClick={props.onLogout}><LogOut /><span><strong>Log out</strong><small>Forget the saved login on this browser</small></span></button></section>
  </aside></div>
}

function FolderDialog(props: {
  title: string
  description: string
  initialName: string
  validate: (name: string) => string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(props.initialName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const validation = props.validate(name)
    if (validation) { setError(validation); return }
    setBusy(true)
    try {
      await props.onSubmit(name.trim())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The folder could not be saved.')
      setBusy(false)
    }
  }
  return <div className="dialog-layer" role="presentation"><form className="dialog folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" onSubmit={(event) => void submit(event)}>
    <button type="button" className="icon-button dialog-close" onClick={props.onClose} aria-label="Close"><X /></button>
    <span className="dialog-icon"><FolderPlus /></span>
    <h2 id="folder-dialog-title">{props.title}</h2>
    <p>{props.description}</p>
    <label>Folder name<input autoFocus maxLength={120} value={name} onChange={(event) => { setName(event.target.value); setError('') }} onFocus={(event) => event.currentTarget.select()} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={props.onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : props.title}</button></div>
  </form></div>
}

function MoveDialog(props: {
  title: string
  folders: FolderContent[]
  currentParentId: string | null | undefined
  unavailable: Set<string>
  onClose: () => void
  onMove: (folderId: string | null) => void
}) {
  const rows = flattenedFolders(props.folders)
  return <div className="dialog-layer" role="presentation"><div className="dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title">
    <button className="icon-button dialog-close" onClick={props.onClose} aria-label="Close"><X /></button>
    <span className="dialog-icon"><Folder /></span>
    <h2 id="move-dialog-title">{props.title}</h2>
    <p>Choose a destination. Folders that would create a loop are unavailable.</p>
    <div className="folder-destination-list" role="listbox" aria-label="Destination folder">
      <button role="option" aria-selected={props.currentParentId === null} onClick={() => props.onMove(null)}><Folder /><span>Notes</span>{props.currentParentId === null && <Check />}</button>
      {rows.map(({ folder, depth }) => <button
        key={folder.id} role="option" aria-selected={props.currentParentId === folder.id} disabled={props.unavailable.has(folder.id)}
        style={{ '--folder-depth': depth } as CSSProperties} onClick={() => props.onMove(folder.id)}
      ><Folder /><span>{folder.name}</span>{props.currentParentId === folder.id && <Check />}</button>)}
    </div>
    <div className="dialog-actions"><button className="button secondary" onClick={props.onClose}>Cancel</button></div>
  </div></div>
}

function PasswordDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('')
  return <div className="dialog-layer" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rotation-title"><button className="icon-button dialog-close" onClick={onClose} aria-label="Close"><X /></button><span className="dialog-icon"><KeyRound /></span><h2 id="rotation-title">Change your password</h2><p>Every note and folder will be re-encrypted in one atomic online operation. Other devices will be signed out.</p><label>New password<input type="password" autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy} onClick={() => onSubmit(password)}>{busy ? 'Re-encrypting…' : 'Change password'}</button></div></div></div>
}
