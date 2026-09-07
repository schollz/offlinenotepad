import { claimNextOutbox } from './db'
import { signChallenge } from './crypto'
import type { KdfMetadata, Publication, PublicationRenderMode, SessionKeys, SocketMessage, WireDocument } from '../types'

const synchronizationDebounceMilliseconds = 500
const documentSyncChannelPrefix = 'offlinenotepad-document-sync:'

interface LockManagerLike {
  request: (
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ) => Promise<void>
}

interface FlushSignal {
  type: 'flush'
  immediate: boolean
}

interface SyncCallbacks {
  onStatus: (status: 'connecting' | 'online' | 'offline') => void
  onInitial: (documents: WireDocument[], publications: Publication[]) => Promise<void>
  onDocuments: (documents: WireDocument[], source: 'ack' | 'remote' | 'conflict') => Promise<void>
  onPublication: (publication: Publication) => void
  onUnpublication: (documentId: string) => void
  onCredentialsRotated: () => void | Promise<void>
  onError: (message: string) => void
}

export class SyncClient {
  private socket: WebSocket | null = null
  private stopped = false
  private retry = 750
  private rotationResolve: (() => void) | null = null
  private rotationReject: ((error: Error) => void) | null = null
  private inFlight = false
  private authenticated = false
  private retryTimer = 0
  private flushTimer = 0
  private documentLeader = true
  private syncChannel: BroadcastChannel | null = null
  private leadershipAbort: AbortController | null = null
  private releaseLeadership: (() => void) | null = null
  private readonly resume = () => {
    if (!this.stopped && (!this.socket || this.socket.readyState === WebSocket.CLOSED)) this.open()
  }
  private readonly suspend = () => this.socket?.close(1000, 'offline')

  constructor(
    private readonly metadata: KdfMetadata,
    private readonly keys: SessionKeys,
    private readonly callbacks: SyncCallbacks,
  ) {}

  connect(): void {
    this.stopped = false
    window.addEventListener('online', this.resume)
    window.addEventListener('offline', this.suspend)
    this.startDocumentLeadership()
    this.open()
  }

  close(): void {
    this.stopped = true
    window.removeEventListener('online', this.resume)
    window.removeEventListener('offline', this.suspend)
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.flushTimer)
    this.flushTimer = 0
    this.inFlight = false
    this.authenticated = false
    this.leadershipAbort?.abort()
    this.leadershipAbort = null
    this.releaseLeadership?.()
    this.releaseLeadership = null
    this.syncChannel?.close()
    this.syncChannel = null
    this.socket?.close(1000, 'client closed')
    this.socket = null
  }

  private startDocumentLeadership(): void {
    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks
    if (!locks || typeof BroadcastChannel === 'undefined') {
      // Older browsers retain the safe multi-sender behavior; database reconciliation
      // still makes duplicate acknowledgements and broadcasts idempotent.
      this.documentLeader = true
      return
    }

    this.documentLeader = false
    this.syncChannel = new BroadcastChannel(`${documentSyncChannelPrefix}${this.metadata.id}`)
    this.syncChannel.addEventListener('message', (event: MessageEvent<FlushSignal>) => {
      if (!this.documentLeader || event.data?.type !== 'flush') return
      if (event.data.immediate) void this.flushNow()
      else this.scheduleLocalFlush()
    })

    const abort = new AbortController()
    this.leadershipAbort = abort
    let releaseLock: () => void = () => {}
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve })
    this.releaseLeadership = releaseLock
    void locks.request(
      `${documentSyncChannelPrefix}${this.metadata.id}`,
      { mode: 'exclusive', signal: abort.signal },
      async () => {
        if (this.stopped) return
        this.documentLeader = true
        if (this.authenticated) void this.flushUnlessScheduled()
        await holdLock
        if (this.releaseLeadership === releaseLock) this.releaseLeadership = null
        this.documentLeader = false
      },
    ).catch((caught: unknown) => {
      if (this.stopped || (caught instanceof DOMException && caught.name === 'AbortError')) return
      this.documentLeader = true
      if (this.authenticated) void this.flushUnlessScheduled()
    })
  }

  private open(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return
    if (this.stopped || !navigator.onLine) {
      this.callbacks.onStatus('offline')
      return
    }
    this.callbacks.onStatus('connecting')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(`${protocol}//${location.host}/ws`)
    this.socket.addEventListener('message', (event) => void this.receive(event.data as string))
    this.socket.addEventListener('close', () => {
      this.inFlight = false
      this.authenticated = false
      this.callbacks.onStatus('offline')
      if (!this.stopped) {
        this.retryTimer = window.setTimeout(() => this.open(), this.retry)
        this.retry = Math.min(this.retry * 1.7, 15_000)
      }
    })
    this.socket.addEventListener('error', () => this.socket?.close())
  }

  private async receive(raw: string): Promise<void> {
    let message: SocketMessage
    try {
      message = JSON.parse(raw) as SocketMessage
    } catch {
      this.callbacks.onError('The server sent an unreadable synchronization message.')
      return
    }
    if (message.type === 'challenge' && message.challenge) {
      this.send({
        type: 'authenticate',
        workspace_id: this.metadata.id,
        signature: signChallenge(message.challenge, this.keys.authSeed),
      })
      return
    }
    if (message.type === 'authenticated') {
      this.retry = 750
      await this.callbacks.onInitial(message.documents ?? [], message.publications ?? [])
      this.authenticated = true
      this.callbacks.onStatus('online')
      await this.flushUnlessScheduled()
      return
    }
    if (message.type === 'documents') {
      await this.callbacks.onDocuments(message.documents ?? [], 'remote')
      return
    }
    if (message.type === 'conflict') {
      await this.callbacks.onDocuments(message.documents ?? [], 'conflict')
      this.inFlight = false
      await this.flushUnlessScheduled()
      return
    }
    if (message.type === 'ack') {
      if (message.documents?.length) {
        await this.callbacks.onDocuments(message.documents, 'ack')
        this.inFlight = false
      }
      if (message.publication) this.callbacks.onPublication(message.publication)
      if (message.document_id) this.callbacks.onUnpublication(message.document_id)
      if (this.rotationResolve && !message.documents?.length && !message.publication && !message.document_id) {
        this.rotationResolve()
        this.rotationResolve = null
        this.rotationReject = null
      }
      await this.flushUnlessScheduled()
      return
    }
    if (message.type === 'error') {
      this.inFlight = false
      if (message.error_code === 'authentication-failed') {
        this.stopped = true
        await this.callbacks.onCredentialsRotated()
        this.socket?.close(1000, 'credentials changed')
        return
      }
      const error = new Error(message.error ?? 'Synchronization failed.')
      this.callbacks.onError(error.message)
      this.rotationReject?.(error)
      this.rotationResolve = null
      this.rotationReject = null
      return
    }
    if (message.type === 'credentials-rotated') {
      this.stopped = true
      await this.callbacks.onCredentialsRotated()
      this.socket?.close(1000, 'credentials rotated')
    }
  }

  send(message: SocketMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  scheduleFlush(delay = synchronizationDebounceMilliseconds): void {
    if (!this.documentLeader) {
      this.syncChannel?.postMessage({ type: 'flush', immediate: false } satisfies FlushSignal)
      return
    }
    this.scheduleLocalFlush(delay)
  }

  private scheduleLocalFlush(delay = synchronizationDebounceMilliseconds): void {
    window.clearTimeout(this.flushTimer)
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = 0
      void this.flushNow()
    }, delay)
  }

  private async flushUnlessScheduled(): Promise<void> {
    if (this.documentLeader && !this.flushTimer) await this.flushNow()
  }

  async flush(): Promise<void> {
    if (!this.documentLeader) {
      this.syncChannel?.postMessage({ type: 'flush', immediate: true } satisfies FlushSignal)
      return
    }
    await this.flushNow()
  }

  private async flushNow(): Promise<void> {
    if (!this.documentLeader || !this.authenticated || this.inFlight || this.socket?.readyState !== WebSocket.OPEN) return
    this.inFlight = true
    const entry = await claimNextOutbox(this.metadata.id)
    if (!entry) {
      this.inFlight = false
      return
    }
    if (!this.send({
      type: entry.operation,
      document_id: entry.documentId,
      ciphertext: entry.ciphertext,
      ciphertext_hash: entry.ciphertextHash,
      base_revision: entry.baseRevision,
      deleted: entry.operation === 'delete',
    })) this.inFlight = false
  }

  publish(documentId: string, title: string, content: string, mode: 'markdown' | 'plaintext', publicId?: string, renderMode: PublicationRenderMode = 'document'): boolean {
    return this.send({ type: 'publish', document_id: documentId, title, content, content_mode: mode, public_id: publicId, render_mode: renderMode })
  }

  unpublish(documentId: string): boolean {
    return this.send({ type: 'unpublish', document_id: documentId })
  }

  rotate(message: SocketMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.send(message)) {
        reject(new Error('Password rotation requires an online connection.'))
        return
      }
      this.rotationResolve = resolve
      this.rotationReject = reject
    })
  }
}
