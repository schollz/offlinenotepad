import { afterEach, describe, expect, it, vi } from 'vitest'
import { EncryptionWorker } from './encryption-worker'
import type { NoteContent } from '../types'

class FakeWorker {
  static current: FakeWorker
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.current = this }
}

const note: NoteContent = { id: 'synthetic-note', title: '', content: 'Synthetic content', mode: 'plaintext', created_at: '', updated_at: '' }
afterEach(() => vi.unstubAllGlobals())

describe('encryption worker lifecycle', () => {
  it('copies only the content key and matches asynchronous responses to requests', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const key = new Uint8Array(32).fill(7)
    const worker = new EncryptionWorker('synthetic-workspace', key)
    const native = FakeWorker.current
    const initialization = native.postMessage.mock.calls[0][0]
    expect(initialization.key).not.toBe(key)
    expect(Object.keys(initialization).sort()).toEqual(['id', 'key', 'workspace'])
    const first = worker.encrypt(note)
    const second = worker.encrypt({ ...note, content: 'Newer content' })
    native.onmessage?.({ data: { id: 2, ciphertext: 'new encrypted', hash: 'new hash' } } as MessageEvent)
    native.onmessage?.({ data: { id: 1, ciphertext: 'old encrypted', hash: 'old hash' } } as MessageEvent)
    await expect(first).resolves.toEqual({ ciphertext: 'old encrypted', hash: 'old hash' })
    await expect(second).resolves.toEqual({ ciphertext: 'new encrypted', hash: 'new hash' })
    worker.close()
    expect(native.terminate).toHaveBeenCalledOnce()
    expect(key).toEqual(new Uint8Array(32).fill(7))
  })

  it('rejects outstanding saves when the worker fails or the session closes', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const worker = new EncryptionWorker('synthetic-workspace', new Uint8Array(32))
    const pending = worker.encrypt(note)
    FakeWorker.current.onerror?.()
    await expect(pending).rejects.toThrow('Local encryption unavailable')
    await expect(worker.encrypt(note)).rejects.toThrow('Local encryption unavailable')
    expect(FakeWorker.current.terminate).toHaveBeenCalledOnce()
  })
})
