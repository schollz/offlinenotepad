import Dexie, { type EntityTable } from 'dexie'
import type { KdfMetadata, OutboxEntry, SessionKeys, StoredDocument } from '../types'

export type DocumentSource = 'ack' | 'remote' | 'conflict' | 'initial'

export interface ReconcileResult {
  kind: 'accepted' | 'rebased' | 'unchanged' | 'stale' | 'conflict-preserved' | 'inconsistent'
  conflictDocumentId?: string
  conflictCreated?: boolean
}

interface LocalAccount extends KdfMetadata {
  username: string
  updatedAt: string
}

interface LocalLogin {
  id: 'active'
  username: string
  metadata: KdfMetadata
  contentKey: Uint8Array
  authSeed: Uint8Array
  authPublicKey: Uint8Array
  updatedAt: string
}

export interface SavedLogin {
  username: string
  metadata: KdfMetadata
  keys: SessionKeys
}

class NotebookDatabase extends Dexie {
  accounts!: EntityTable<LocalAccount, 'id'>
  documents!: EntityTable<StoredDocument, 'key'>
  outbox!: EntityTable<OutboxEntry, 'id'>
  logins!: EntityTable<LocalLogin, 'id'>

  constructor() {
    super('offlinenotepad-v2')
    this.version(1).stores({
      accounts: 'id, updatedAt',
      documents: 'key, workspaceId, [workspaceId+documentId], pending, updatedAt',
      outbox: '++id, &key, workspaceId, createdAt',
    })
    this.version(2).stores({
      accounts: 'id, updatedAt',
      documents: 'key, workspaceId, [workspaceId+documentId], pending, updatedAt',
      outbox: '++id, &key, workspaceId, createdAt',
      logins: 'id, updatedAt',
    })
  }
}

export const notebookDB = new NotebookDatabase()

export function documentKey(workspaceId: string, documentId: string): string {
  return `${workspaceId}:${documentId}`
}

export async function saveAccount(account: LocalAccount): Promise<void> {
  await notebookDB.accounts.put(account)
}

export async function getAccount(id: string): Promise<LocalAccount | undefined> {
  return notebookDB.accounts.get(id)
}

export async function saveLogin(login: SavedLogin): Promise<void> {
  await notebookDB.logins.put({
    id: 'active',
    username: login.username,
    metadata: { ...login.metadata },
    contentKey: new Uint8Array(login.keys.contentKey),
    authSeed: new Uint8Array(login.keys.authSeed),
    authPublicKey: new Uint8Array(login.keys.authPublicKey),
    updatedAt: new Date().toISOString(),
  })
}

export async function getLogin(): Promise<SavedLogin | undefined> {
  const login = await notebookDB.logins.get('active')
  if (!login) return undefined
  return {
    username: login.username,
    metadata: { ...login.metadata },
    keys: {
      contentKey: new Uint8Array(login.contentKey),
      authSeed: new Uint8Array(login.authSeed),
      authPublicKey: new Uint8Array(login.authPublicKey),
    },
  }
}

export async function clearLogin(): Promise<void> {
  await notebookDB.logins.delete('active')
}

export async function listDocuments(workspaceId: string): Promise<StoredDocument[]> {
  return notebookDB.documents.where('workspaceId').equals(workspaceId).toArray()
}

export async function queueDocument(document: StoredDocument, operation: OutboxEntry['operation']): Promise<void> {
  await notebookDB.transaction('rw', notebookDB.documents, notebookDB.outbox, async () => {
    const current = await notebookDB.documents.get(document.key)
    const existing = await notebookDB.outbox.where('key').equals(document.key).first()
    const baseRevision = Math.max(document.revision, current?.revision ?? 0, existing?.baseRevision ?? 0)
    await notebookDB.documents.put({ ...document, revision: baseRevision, pending: true })
    await notebookDB.outbox.put({
      id: existing?.id,
      key: document.key,
      workspaceId: document.workspaceId,
      documentId: document.documentId,
      operation,
      ciphertext: document.ciphertext,
      ciphertextHash: document.ciphertextHash,
      baseRevision,
      createdAt: new Date().toISOString(),
      sentMutation: existing?.sentMutation,
    })
  })
}

function matchesRemote(
  mutation: Pick<OutboxEntry, 'operation' | 'ciphertextHash'>,
  document: StoredDocument,
): boolean {
  return mutation.operation === (document.deleted ? 'delete' : 'upsert')
    && (document.deleted || mutation.ciphertextHash === document.ciphertextHash)
}

function queuedDocument(entry: OutboxEntry, revision: number): StoredDocument {
  return {
    key: entry.key,
    workspaceId: entry.workspaceId,
    documentId: entry.documentId,
    ciphertext: entry.ciphertext,
    ciphertextHash: entry.ciphertextHash,
    revision,
    deleted: entry.operation === 'delete',
    updatedAt: entry.createdAt,
    pending: true,
  }
}

export async function claimNextOutbox(workspaceId: string): Promise<OutboxEntry | undefined> {
  return notebookDB.transaction('rw', notebookDB.outbox, async () => {
    const entries = await notebookDB.outbox.where('workspaceId').equals(workspaceId).sortBy('createdAt')
    const entry = entries[0]
    if (!entry) return undefined
    const claimed: OutboxEntry = {
      ...entry,
      sentMutation: {
        operation: entry.operation,
        ciphertextHash: entry.ciphertextHash,
        baseRevision: entry.baseRevision,
      },
    }
    await notebookDB.outbox.put(claimed)
    return claimed
  })
}

export async function reconcileDocument(
  document: StoredDocument,
  source: DocumentSource,
  createConflictCopy?: (local: StoredDocument) => StoredDocument,
  localCandidate?: StoredDocument,
): Promise<ReconcileResult> {
  return notebookDB.transaction('rw', notebookDB.documents, notebookDB.outbox, async () => {
    const local = await notebookDB.documents.get(document.key)
    const queued = await notebookDB.outbox.where('key').equals(document.key).first()

    if (local && document.revision < local.revision) return { kind: 'stale' } satisfies ReconcileResult

    if (!queued && local && document.revision === local.revision) {
      const sameOperation = local.deleted === document.deleted
      const sameCiphertext = document.deleted || local.ciphertextHash === document.ciphertextHash
      if (!sameOperation || !sameCiphertext) return { kind: 'inconsistent' } satisfies ReconcileResult
    }

    let conflictDocumentId: string | undefined
    let conflictCreated = false
    const preserve = async (candidate: StoredDocument): Promise<void> => {
      if (!createConflictCopy) throw new Error('A conflict copy is required to reconcile this document.')
      const conflict = createConflictCopy(candidate)
      conflictDocumentId = conflict.documentId
      if (await notebookDB.documents.get(conflict.key)) return
      await notebookDB.documents.put({ ...conflict, pending: true })
      await notebookDB.outbox.add({
        key: conflict.key,
        workspaceId: conflict.workspaceId,
        documentId: conflict.documentId,
        operation: 'upsert',
        ciphertext: conflict.ciphertext,
        ciphertextHash: conflict.ciphertextHash,
        baseRevision: conflict.revision,
        createdAt: conflict.updatedAt,
      })
      conflictCreated = true
    }
    const finish = (kind: Exclude<ReconcileResult['kind'], 'conflict-preserved'>): ReconcileResult => (
      conflictDocumentId
        ? { kind: 'conflict-preserved', conflictDocumentId, conflictCreated }
        : { kind }
    )

    const candidateDiffersFromRemote = localCandidate
      && !localCandidate.deleted
      && !matchesRemote({ operation: 'upsert', ciphertextHash: localCandidate.ciphertextHash }, document)
    const candidateMatchesQueue = localCandidate && queued
      && matchesRemote(queued, localCandidate)
    if (candidateDiffersFromRemote && !candidateMatchesQueue) await preserve(localCandidate)

    if (queued) {
      if (matchesRemote(queued, document)) {
        await notebookDB.documents.put({ ...document, pending: false })
        await notebookDB.outbox.delete(queued.id!)
        return finish('accepted')
      }

      const sent = queued.sentMutation
      if (sent && matchesRemote(sent, document) && document.revision > sent.baseRevision) {
        await notebookDB.documents.put(queuedDocument(queued, document.revision))
        await notebookDB.outbox.put({ ...queued, baseRevision: document.revision, sentMutation: undefined })
        return finish('rebased')
      }

      if (source === 'ack' && document.revision >= queued.baseRevision) {
        await notebookDB.documents.put(queuedDocument(queued, document.revision))
        await notebookDB.outbox.put({ ...queued, baseRevision: document.revision, sentMutation: undefined })
        return finish('rebased')
      }

      if (source === 'conflict' && document.revision === queued.baseRevision) {
        // A conflict at the exact base revision violates the optimistic-revision
        // contract. Keep the encrypted local record, but stop retrying it forever.
        await notebookDB.outbox.delete(queued.id!)
        return { kind: 'inconsistent' }
      }

      if (document.revision <= queued.baseRevision) {
        return finish('unchanged')
      }

      if (queued.operation === 'delete') {
        await notebookDB.documents.put(queuedDocument(queued, document.revision))
        await notebookDB.outbox.put({ ...queued, baseRevision: document.revision, sentMutation: undefined })
        return finish('rebased')
      }

      await preserve(local ?? queuedDocument(queued, queued.baseRevision))
      await notebookDB.documents.put({ ...document, pending: false })
      await notebookDB.outbox.delete(queued.id!)
      return { kind: 'conflict-preserved', conflictDocumentId, conflictCreated }
    }

    if (local) {
      if (document.revision === local.revision) {
        if (!local.pending) return finish('unchanged')
      }
    }
    await notebookDB.documents.put({ ...document, pending: false })
    return finish('accepted')
  })
}

export async function acknowledgeDocument(document: StoredDocument): Promise<void> {
  await reconcileDocument(document, 'ack')
}
