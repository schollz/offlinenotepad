import { beforeEach, describe, expect, it } from 'vitest'
import { acknowledgeDocument, claimNextOutbox, clearLogin, documentKey, getLogin, notebookDB, queueDocument, reconcileDocument, recoverUnreadableSyncedDocument, saveLogin } from './db'
import type { KdfMetadata, SessionKeys, StoredDocument } from '../types'

const workspaceId = 'workspace'
const key = documentKey(workspaceId, 'document-one')

function stored(hash: string, revision = 1): StoredDocument {
  return { key, workspaceId, documentId: 'document-one', ciphertext: `cipher-${hash}`, ciphertextHash: hash, revision, deleted: false, updatedAt: new Date().toISOString(), pending: true }
}

function remote(hash: string, revision: number, deleted = false): StoredDocument {
  return { ...stored(hash, revision), ciphertext: deleted ? '' : `cipher-${hash}`, ciphertextHash: deleted ? '' : hash, deleted, pending: false }
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

    expect((await reconcileDocument(remote('server-base', 3), 'initial')).kind).toBe('unchanged')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'offline', revision: 3, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).count()).toBe(1)
  })

  it('ignores stale remote records', async () => {
    await notebookDB.documents.put({ ...stored('latest', 4), pending: false })

    expect((await reconcileDocument(remote('stale', 3), 'remote')).kind).toBe('stale')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'latest', revision: 4 })
  })

  it('rebases the latest local edit in place when a newer remote revision arrives', async () => {
    await queueDocument(stored('local', 1), 'upsert')
    const incoming = remote('remote', 2)

    expect((await reconcileDocument(incoming, 'remote')).kind).toBe('rebased')
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(1)
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'local', revision: 2, pending: true })
    expect(await notebookDB.outbox.toArray()).toEqual([
      expect.objectContaining({ documentId: 'document-one', ciphertextHash: 'local', baseRevision: 2 }),
    ])
  })

  it('keeps one rebased local record for duplicate concurrent deliveries', async () => {
    await queueDocument(stored('local', 1), 'upsert')
    const incoming = remote('remote', 2)

    const results = await Promise.all([
      reconcileDocument(incoming, 'remote'),
      reconcileDocument(incoming, 'remote'),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual(['rebased', 'unchanged'])
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(1)
    expect(await notebookDB.outbox.toArray()).toEqual([
      expect.objectContaining({ documentId: 'document-one', ciphertextHash: 'local', baseRevision: 2 }),
    ])
  })

  it('rebases a pending delete over a newer remote edit', async () => {
    await queueDocument({ ...stored('local', 1), ciphertext: '', ciphertextHash: '', deleted: true }, 'delete')

    expect((await reconcileDocument(remote('remote', 2), 'remote')).kind).toBe('rebased')
    expect(await notebookDB.documents.get(key)).toMatchObject({ deleted: true, revision: 2, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).first()).toMatchObject({ operation: 'delete', baseRevision: 2 })
  })

  it('accepts a permanent remote tombstone without creating another document', async () => {
    await queueDocument(stored('local', 1), 'upsert')

    const result = await reconcileDocument(remote('', 2, true), 'remote')
    expect(result).toEqual({ kind: 'accepted' })
    expect(await notebookDB.documents.get(key)).toMatchObject({ deleted: true, revision: 2, pending: false })
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(1)
    expect(await notebookDB.outbox.count()).toBe(0)
  })

  it('accepts a permanent tombstone returned at the queued base revision', async () => {
    await queueDocument(stored('local', 2), 'upsert')

    expect((await reconcileDocument(remote('', 2, true), 'conflict')).kind).toBe('accepted')
    expect(await notebookDB.documents.get(key)).toMatchObject({ deleted: true, revision: 2, pending: false })
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(1)
    expect(await notebookDB.outbox.count()).toBe(0)
  })

  it('ignores a delayed conflict response after a broadcast already rebased the latest edit', async () => {
    await queueDocument(stored('local', 3), 'upsert')
    await claimNextOutbox(workspaceId)
    const incoming = remote('remote', 4)

    expect((await reconcileDocument(incoming, 'remote')).kind).toBe('rebased')
    expect((await reconcileDocument(incoming, 'conflict')).kind).toBe('unchanged')
    expect(await notebookDB.documents.where('workspaceId').equals(workspaceId).count()).toBe(1)
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'local', revision: 4, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).first()).toMatchObject({
      ciphertextHash: 'local', baseRevision: 4, sentMutation: undefined,
    })
  })

  it('leaves local data untouched when an equal revision has inconsistent ciphertext', async () => {
    await notebookDB.documents.put({ ...stored('local', 2), pending: false })

    expect((await reconcileDocument(remote('impossible', 2), 'remote')).kind).toBe('inconsistent')
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'local', revision: 2 })
    expect(await notebookDB.outbox.count()).toBe(0)
  })

  it('replaces an unreadable synced cache entry with the authenticated server copy', async () => {
    await notebookDB.documents.put({ ...stored('unreadable', 7), pending: false })

    expect(await recoverUnreadableSyncedDocument(remote('server', 1))).toBe(true)
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'server', revision: 1, pending: false })
  })

  it('never replaces an unreadable cache entry that may contain an unsent edit', async () => {
    await queueDocument(stored('unreadable', 7), 'upsert')

    expect(await recoverUnreadableSyncedDocument(remote('server', 8))).toBe(false)
    expect(await notebookDB.documents.get(key)).toMatchObject({ ciphertextHash: 'unreadable', revision: 7, pending: true })
    expect(await notebookDB.outbox.where('key').equals(key).count()).toBe(1)
  })

  it('stops retrying an impossible conflict at the queued base revision', async () => {
    await queueDocument(stored('local', 2), 'upsert')
    await claimNextOutbox(workspaceId)

    expect((await reconcileDocument(remote('impossible', 2), 'conflict')).kind).toBe('inconsistent')
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
