import { beforeEach, describe, expect, it } from 'vitest'
import { acknowledgeDocument, claimNextOutbox, clearLogin, documentKey, getLogin, notebookDB, queueDocument, reconcileDocument, saveLogin } from './db'
import type { KdfMetadata, SessionKeys, StoredDocument } from '../types'

const workspaceId = 'workspace'
const key = documentKey(workspaceId, 'document-one')

function stored(hash: string, revision = 1): StoredDocument {
  return { key, workspaceId, documentId: 'document-one', ciphertext: `cipher-${hash}`, ciphertextHash: hash, revision, deleted: false, updatedAt: new Date().toISOString(), pending: true }
}

function remote(hash: string, revision: number, deleted = false): StoredDocument {
  return { ...stored(hash, revision), ciphertext: deleted ? '' : `cipher-${hash}`, ciphertextHash: deleted ? '' : hash, deleted, pending: false }
}

function conflictCopy(): StoredDocument {
  return {
    ...stored('conflict-copy', 0),
    key: documentKey(workspaceId, 'conflict-document'),
    documentId: 'conflict-document',
  }
}

describe('offline outbox', () => {
  beforeEach(async () => {
    await notebookDB.documents.clear()
    await notebookDB.outbox.clear()
    await notebookDB.logins.clear()
  })

  it('coalesces edits while retaining local-first encrypted state', async () => {
    await queueDocument(stored('first'), 'upsert')
    await notebookDB.documents.update(key, { revision: 2 })
    await queueDocument(stored('second'), 'upsert')
    expect(await notebookDB.outbox.count()).toBe(1)
    expect((await notebookDB.documents.get(key))?.ciphertextHash).toBe('second')
    expect((await notebookDB.outbox.where('key').equals(key).first())?.baseRevision).toBe(2)
  })

  it('does not lose a newer edit when an older acknowledgement arrives', async () => {
    await queueDocument(stored('first'), 'upsert')
    await queueDocument(stored('second'), 'upsert')
    await acknowledgeDocument({ ...stored('first', 2), pending: false })
    expect((await notebookDB.documents.get(key))?.ciphertextHash).toBe('second')
    expect((await notebookDB.outbox.where('key').equals(key).first())?.baseRevision).toBe(2)
    await acknowledgeDocument({ ...stored('second', 3), pending: false })
    expect(await notebookDB.outbox.count()).toBe(0)
    expect((await notebookDB.documents.get(key))?.pending).toBe(false)
  })

  it('records the exact mutation sent and rebases a newer queued edit over its acknowledgement', async () => {
    await queueDocument(stored('sent'), 'upsert')
    expect((await claimNextOutbox(workspaceId))?.sentMutation).toEqual({
      operation: 'upsert', ciphertextHash: 'sent', baseRevision: 1,
    })
    await queueDocument(stored('newer'), 'upsert')

    expect((await reconcileDocument(remote('sent', 2), 'remote')).kind).toBe('rebased')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'newer', revision: 2, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).first()).toMatchObject({
      ciphertextHash: 'newer', baseRevision: 2, sentMutation: undefined,
    })
  })

  it('keeps an offline edit when the initial server snapshot is only its base revision', async () => {
    await queueDocument(stored('offline', 3), 'upsert')

    expect((await reconcileDocument(remote('server-base', 3), 'initial', conflictCopy)).kind).toBe('unchanged')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'offline', revision: 3, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).count()).toBe(1)
  })

  it('ignores stale remote records', async () => {
    await notebookDB.documents.put({ ...stored('latest', 4), pending: false })

    expect((await reconcileDocument(remote('stale', 3), 'remote', conflictCopy)).kind).toBe('stale')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'latest', revision: 4 })
  })

  it('atomically creates only one conflict copy for duplicate concurrent deliveries', async () => {
    await queueDocument(stored('local', 1), 'upsert')
    const incoming = remote('remote', 2)

    const results = await Promise.all([
      reconcileDocument(incoming, 'remote', conflictCopy),
      reconcileDocument(incoming, 'remote', conflictCopy),
    ])

    expect(results.filter((result) => result.conflictCreated)).toHaveLength(1)
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(2)
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'remote', pending: false })
    expect(await notebookDB.outbox.toArray()).toEqual([
      expect.objectContaining({ documentId: 'conflict-document', ciphertextHash: 'conflict-copy' }),
    ])
  })

  it('preserves a different tab\'s local candidate once after the shared outbox was overwritten', async () => {
    const firstTab = stored('first-tab', 1)
    await queueDocument(stored('second-tab', 1), 'upsert')
    const incoming = remote('second-tab', 2)

    const first = await reconcileDocument(incoming, 'ack', conflictCopy, firstTab)
    const duplicate = await reconcileDocument(incoming, 'remote', conflictCopy, firstTab)

    expect(first).toMatchObject({ kind: 'conflict-preserved', conflictCreated: true })
    expect(duplicate).toMatchObject({ kind: 'conflict-preserved', conflictCreated: false })
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(2)
    expect(await notebookDB.outbox.toArray()).toEqual([
      expect.objectContaining({ documentId: 'conflict-document' }),
    ])
  })

  it('rebases a pending delete without creating a conflict copy', async () => {
    await queueDocument({ ...stored('local', 1), ciphertext: '', ciphertextHash: '', deleted: true }, 'delete')

    expect((await reconcileDocument(remote('remote', 2), 'remote', conflictCopy)).kind).toBe('rebased')
    expect(await notebookDB.documents.get(key)).toMatchObject({ deleted: true, revision: 2, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).first()).toMatchObject({ operation: 'delete', baseRevision: 2 })
  })

  it('preserves a pending upsert when a newer remote tombstone arrives', async () => {
    await queueDocument(stored('local', 1), 'upsert')

    const result = await reconcileDocument(remote('', 2, true), 'remote', conflictCopy)
    expect(result).toMatchObject({ kind: 'conflict-preserved', conflictCreated: true })
    expect(await notebookDB.documents.get(key)).toMatchObject({ deleted: true, revision: 2, pending: false })
    expect(await notebookDB.documents.get(documentKey(workspaceId, 'conflict-document'))).toMatchObject({ pending: true })
  })

  it('leaves local data untouched when an equal revision has inconsistent ciphertext', async () => {
    await notebookDB.documents.put({ ...stored('local', 2), pending: false })

    expect((await reconcileDocument(remote('impossible', 2), 'remote', conflictCopy)).kind).toBe('inconsistent')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'local', revision: 2 })
    expect(await notebookDB.outbox.count()).toBe(0)
  })

  it('stops retrying an impossible conflict at the queued base revision', async () => {
    await queueDocument(stored('local', 2), 'upsert')

    expect((await reconcileDocument(remote('impossible', 2), 'conflict', conflictCopy)).kind).toBe('inconsistent')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'local', revision: 2, pending: true })
    expect(await notebookDB.outbox.count()).toBe(0)
  })

  it('remembers one active login using independent key copies and clears it on logout', async () => {
    const metadata: KdfMetadata = {
      id: workspaceId,
      kdf_version: 1,
      kdf_salt: 'salt',
      kdf_memory: 65_536,
      kdf_iterations: 3,
      kdf_parallelism: 1,
      auth_public_key: 'public-key',
    }
    const keys: SessionKeys = {
      contentKey: new Uint8Array(32).fill(1),
      authSeed: new Uint8Array(32).fill(2),
      authPublicKey: new Uint8Array(32).fill(3),
    }
    await saveLogin({ username: 'saved-notebook', metadata, keys })
    keys.contentKey.fill(0)

    const first = await getLogin()
    expect(first?.username).toBe('saved-notebook')
    expect(first?.keys.contentKey[0]).toBe(1)
    first?.keys.contentKey.fill(9)
    expect((await getLogin())?.keys.contentKey[0]).toBe(1)

    await clearLogin()
    expect(await getLogin()).toBeUndefined()
  })
})
