/// <reference lib="webworker" />
import { encryptRecord } from './crypto'
import type { PrivateRecord } from '../types'

let contentKey: Uint8Array | undefined
let workspace = ''
self.onmessage = (event: MessageEvent<{ id: number; key?: Uint8Array; workspace?: string; record?: PrivateRecord }>) => {
  const { id, key, record } = event.data
  try {
    if (key) {
      contentKey?.fill(0)
      contentKey = key
      workspace = event.data.workspace!
    } else if (record && contentKey) {
      self.postMessage({ id, ...encryptRecord(record, workspace, contentKey) })
    } else {
      throw new Error('Worker not initialized')
    }
  } catch {
    // Never serialize note content, key material, or underlying crypto errors.
    self.postMessage({ id, error: true })
  }
}
