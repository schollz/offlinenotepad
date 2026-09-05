/// <reference lib="webworker" />
import { deriveKeyMaterial } from './key-material'

interface Request {
  id: number
  password: string
  salt: Uint8Array
  memory: number
  iterations: number
  parallelism: number
}

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const request = event.data
    const { contentKey, authSeed, authPublicKey } = deriveKeyMaterial(request.password, request.salt, request.memory, request.iterations, request.parallelism)
    self.postMessage({ id: request.id, contentKey, authSeed, authPublicKey }, [contentKey.buffer, authSeed.buffer, authPublicKey.buffer])
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : 'Key derivation failed' })
  }
}
