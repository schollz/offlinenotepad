import type { PrivateRecord } from '../types'

interface Encrypted { ciphertext: string; hash: string }

export class EncryptionWorker {
  private readonly worker: Worker
  private sequence = 0
  private closed = false
  private readonly pending = new Map<number, { resolve: (result: Encrypted) => void; reject: (error: Error) => void }>()

  constructor(workspace: string, key: Uint8Array) {
    this.worker = new Worker(new URL('./encryption.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<Encrypted & { id: number; error?: boolean }>) => {
      const request = this.pending.get(event.data.id)
      if (!request) return
      this.pending.delete(event.data.id)
      if (event.data.error) request.reject(new Error('Local encryption failed'))
      else request.resolve({ ciphertext: event.data.ciphertext, hash: event.data.hash })
    }
    this.worker.onerror = () => this.close()
    this.worker.onmessageerror = () => this.close()
    // Transfer a copy; the active session keeps its own content key.
    const copy = key.slice()
    this.worker.postMessage({ id: 0, workspace, key: copy }, [copy.buffer])
  }

  encrypt(record: PrivateRecord): Promise<Encrypted> {
    if (this.closed) return Promise.reject(new Error('Local encryption unavailable'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ id, record }) }
      catch { this.close() }
    })
  }

  close(): void {
    this.closed = true
    this.worker.terminate()
    for (const request of this.pending.values()) request.reject(new Error('Local encryption unavailable'))
    this.pending.clear()
  }
}
