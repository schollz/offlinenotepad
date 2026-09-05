import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KdfMetadata, SessionKeys, StoredDocument, WireDocument } from '../types'
import { acknowledgeDocument, documentKey, notebookDB, queueDocument } from './db'
import { SyncClient } from './sync'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readyState = FakeWebSocket.OPEN
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>()

  constructor() { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  close(): void { this.readyState = FakeWebSocket.CLOSED }
  send(message: string): void { this.sent.push(message) }
}

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>()
  private readonly listeners: Array<(event: MessageEvent) => void> = []

  constructor(private readonly name: string) {
    const channels = FakeBroadcastChannel.channels.get(name) ?? new Set()
    channels.add(this)
    FakeBroadcastChannel.channels.set(name, channels)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.push(listener)
  }

  postMessage(message: unknown): void {
    for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel === this) continue
      queueMicrotask(() => channel.listeners.forEach((listener) => listener({ data: message } as MessageEvent)))
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

class FakeLockManager {
  private active = false
  private readonly queue: Array<{
    callback: () => Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
    signal: AbortSignal
  }> = []

  request(
    _name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ callback, resolve, reject, signal: options.signal })
      options.signal.addEventListener('abort', () => {
        const index = this.queue.findIndex((entry) => entry.callback === callback)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(new DOMException('The lock request was aborted.', 'AbortError'))
      }, { once: true })
      this.pump()
    })
  }

  private pump(): void {
    if (this.active) return
    const entry = this.queue.shift()
    if (!entry) return
    if (entry.signal.aborted) {
      entry.reject(new DOMException('The lock request was aborted.', 'AbortError'))
      this.pump()
      return
    }
    this.active = true
    void entry.callback().then(entry.resolve, entry.reject).finally(() => {
      this.active = false
      this.pump()
    })
  }
}

const metadata: KdfMetadata = {
  id: 'debounced-workspace',
  kdf_version: 1,
  kdf_salt: 'salt',
  kdf_memory: 65_536,
  kdf_iterations: 3,
  kdf_parallelism: 1,
  auth_public_key: 'public-key',
}

const keys: SessionKeys = {
  contentKey: new Uint8Array(32),
  authSeed: new Uint8Array(32),
  authPublicKey: new Uint8Array(32),
}

let online = true

function stored(hash: string): StoredDocument {
  return {
    key: documentKey(metadata.id, 'document-one'),
    workspaceId: metadata.id,
    documentId: 'document-one',
    ciphertext: `cipher-${hash}`,
    ciphertextHash: hash,
    revision: 0,
    deleted: false,
    updatedAt: new Date().toISOString(),
    pending: true,
  }
}

function wire(hash: string, revision: number): WireDocument {
  return {
    document_id: 'document-one', ciphertext: `cipher-${hash}`, ciphertext_hash: hash,
    revision, deleted: false, updated_at: new Date().toISOString(),
  }
}

function callbacks() {
  return {
    onStatus: () => undefined,
    onInitial: async () => undefined,
    onDocuments: async (documents: WireDocument[]) => {
      for (const document of documents) {
        await acknowledgeDocument({
          key: documentKey(metadata.id, document.document_id), workspaceId: metadata.id,
          documentId: document.document_id, ciphertext: document.ciphertext,
          ciphertextHash: document.ciphertext_hash, revision: document.revision,
          deleted: document.deleted, updatedAt: document.updated_at, pending: false,
        })
      }
    },
    onPublication: () => undefined,
    onUnpublication: () => undefined,
    onCredentialsRotated: () => undefined,
    onError: () => undefined,
  }
}

describe('offline synchronization', () => {
  beforeEach(async () => {
    await notebookDB.documents.clear()
    await notebookDB.outbox.clear()
    FakeWebSocket.instances.length = 0
    FakeBroadcastChannel.channels.clear()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    online = true
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online)
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps an encrypted edit queued offline and sends it after reconnecting', async () => {
    online = false
    const client = new SyncClient(metadata, keys, callbacks())
    client.connect()
    await queueDocument(stored('offline-edit'), 'upsert')

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(await notebookDB.documents.get(documentKey(metadata.id, 'document-one'))).toMatchObject({
      ciphertextHash: 'offline-edit', pending: true,
    })
    expect(await notebookDB.outbox.count()).toBe(1)

    online = true
    window.dispatchEvent(new Event('online'))
    const socket = FakeWebSocket.instances[0]
    socket.emit('message', { data: JSON.stringify({ type: 'authenticated', documents: [], publications: [] }) })

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: 'upsert', ciphertext: 'cipher-offline-edit', ciphertext_hash: 'offline-edit',
    })
    expect(await notebookDB.outbox.count()).toBe(1)

    socket.emit('message', { data: JSON.stringify({ type: 'ack', documents: [wire('offline-edit', 1)] }) })
    await vi.waitFor(async () => expect(await notebookDB.outbox.count()).toBe(0))
    expect(await notebookDB.documents.get(documentKey(metadata.id, 'document-one'))).toMatchObject({
      ciphertextHash: 'offline-edit', pending: false,
    })
    client.close()
  })

  it('coalesces rapid edits and sends only the latest encrypted record after typing pauses', async () => {
    const client = new SyncClient(metadata, keys, callbacks())
    client.connect()
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'authenticated', documents: [], publications: [] }) })
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    await queueDocument(stored('first'), 'upsert')
    client.scheduleFlush(60)
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    await queueDocument(stored('latest'), 'upsert')
    client.scheduleFlush(60)
    await new Promise((resolve) => window.setTimeout(resolve, 40))

    const socket = FakeWebSocket.instances[0]
    expect(socket.sent).toHaveLength(0)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0])).toMatchObject({ ciphertext: 'cipher-latest', ciphertext_hash: 'latest' })
    client.close()
  })

  it('lets only the workspace leader send shared outbox entries and transfers leadership on close', async () => {
    Object.defineProperty(window.navigator, 'locks', { value: new FakeLockManager(), configurable: true })
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    const first = new SyncClient(metadata, keys, callbacks())
    const second = new SyncClient(metadata, keys, callbacks())
    first.connect()
    second.connect()
    const firstSocket = FakeWebSocket.instances[0]
    const secondSocket = FakeWebSocket.instances[1]
    firstSocket.emit('message', { data: JSON.stringify({ type: 'authenticated', documents: [], publications: [] }) })
    secondSocket.emit('message', { data: JSON.stringify({ type: 'authenticated', documents: [], publications: [] }) })
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    await queueDocument(stored('leader-send'), 'upsert')
    await second.flush()
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1))
    expect(secondSocket.sent).toHaveLength(0)

    firstSocket.emit('message', { data: JSON.stringify({ type: 'ack', documents: [wire('leader-send', 1)] }) })
    await vi.waitFor(async () => expect(await notebookDB.outbox.count()).toBe(0))
    first.close()

    await queueDocument(stored('successor-send'), 'upsert')
    await second.flush()
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1))
    expect(JSON.parse(secondSocket.sent[0])).toMatchObject({ ciphertext_hash: 'successor-send', base_revision: 1 })
    second.close()
  })
})
